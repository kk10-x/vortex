import { fork, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { Config, Stats, Strategy, VortexEvent, WorkerInfo } from "../shared/types.ts";
import { HashRing } from "./hashRing.ts";
import { TokenBucket } from "./tokenBucket.ts";

const WORKER_ENTRY = fileURLToPath(new URL("./worker.ts", import.meta.url));
const WEB_DIST = fileURLToPath(new URL("../web/dist", import.meta.url));
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

export interface GatewayOptions {
  port?: number;
  workerBasePort?: number;
  workerCount?: number;
  workMs?: number;
  healthIntervalMs?: number;
}

interface Worker {
  id: number;
  port: number;
  proc: ChildProcess | null;
  healthy: boolean;
  served: number;
}

const clamp = (n: unknown, lo: number, hi: number, fallback: number) =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;

export async function createGateway(opts: GatewayOptions = {}) {
  const workerCount = opts.workerCount ?? 3;
  const basePort = opts.workerBasePort ?? 9101;
  const workMs = opts.workMs ?? 40;
  const healthMs = opts.healthIntervalMs ?? 400;

  const workers: Worker[] = Array.from({ length: workerCount }, (_, i) => ({
    id: i + 1,
    port: basePort + i,
    proc: null,
    healthy: false,
    served: 0,
  }));
  const byId = new Map(workers.map((w) => [w.id, w]));
  const ring = new HashRing(workers.map((w) => w.id));
  const bucket = new TokenBucket(40, 60);
  const config: Config = { strategy: "round-robin", rps: 0, rateLimit: { rate: 40, burst: 60 } };
  const stats: Stats = { sent: 0, limited: 0, rerouted: 0, failed: 0 };
  const clients = new Set<WebSocket>();
  let nextId = 1;
  let rr = 0;

  const emit = (e: VortexEvent) => {
    const payload = JSON.stringify(e);
    for (const c of clients) if (c.readyState === c.OPEN) c.send(payload);
  };
  const snapshot = (): VortexEvent => ({
    type: "state",
    workers: workers.map<WorkerInfo>((w) => ({ id: w.id, healthy: w.healthy, served: w.served })),
    config,
    stats,
  });

  // ---- worker lifecycle -------------------------------------------------------------------
  function spawnWorker(w: Worker) {
    if (w.proc && w.proc.exitCode === null) return;
    const proc = fork(WORKER_ENTRY, [], {
      execArgv: ["--import", "tsx"],
      env: {
        ...process.env,
        WORKER_ID: String(w.id),
        WORKER_PORT: String(w.port),
        WORK_MS: String(workMs),
      },
      stdio: "ignore",
    });
    w.proc = proc;
    proc.on("exit", () => {
      if (w.proc === proc) w.proc = null;
    });
  }

  function setHealth(w: Worker, healthy: boolean) {
    if (w.healthy === healthy) return;
    w.healthy = healthy;
    emit({ type: "worker", id: w.id, state: healthy ? "up" : "down" });
  }

  async function probe(w: Worker) {
    try {
      const res = await fetch(`http://127.0.0.1:${w.port}/health`, {
        signal: AbortSignal.timeout(300),
      });
      setHealth(w, res.ok);
    } catch {
      setHealth(w, false);
    }
  }
  const healthTimer = setInterval(() => workers.forEach(probe), healthMs);

  // ---- routing ----------------------------------------------------------------------------
  function pick(key: string, strategy: Strategy, exclude: Set<number>): Worker | undefined {
    const usable = (id: number) => !exclude.has(id) && byId.get(id)!.healthy;
    if (strategy === "hash") {
      const id = ring.lookup(key, usable);
      return id === undefined ? undefined : byId.get(id);
    }
    for (let i = 0; i < workers.length; i++) {
      const w = workers[rr++ % workers.length]!;
      if (usable(w.id)) return w;
    }
    return undefined;
  }

  /** Rate-limit, route, call the worker, and retry on a different worker if the call fails. */
  async function handleRequest(key: string): Promise<void> {
    const id = nextId++;
    stats.sent++;
    if (!bucket.tryTake()) {
      stats.limited++;
      emit({ type: "limited", id, key });
      return;
    }
    const tried = new Set<number>();
    for (let attempt = 0; attempt < workers.length; attempt++) {
      const w = pick(key, config.strategy, tried);
      if (!w) break;
      emit({ type: "routed", id, key, worker: w.id, retried: attempt > 0 });
      const started = performance.now();
      try {
        const res = await fetch(`http://127.0.0.1:${w.port}/work?key=${encodeURIComponent(key)}`, {
          signal: AbortSignal.timeout(1500),
        });
        if (!res.ok) throw new Error(`worker ${w.id} returned ${res.status}`);
        await res.arrayBuffer();
        w.served++;
        emit({ type: "done", id, worker: w.id, ms: Math.round(performance.now() - started) });
        return;
      } catch {
        tried.add(w.id);
        setHealth(w, false);
        stats.rerouted++;
        emit({ type: "retry", id, from: w.id });
      }
    }
    stats.failed++;
    emit({ type: "failed", id, key });
  }

  // ---- synthetic traffic (real requests through the same pipeline) -------------------------
  let carry = 0;
  const trafficTimer = setInterval(() => {
    carry += (config.rps * 50) / 1000;
    while (carry >= 1) {
      carry -= 1;
      void handleRequest(`key-${Math.floor(Math.random() * 48)}`);
    }
  }, 50);

  function applyConfig(patch: Partial<Config> & { rateLimit?: Partial<Config["rateLimit"]> }) {
    if (patch.strategy === "round-robin" || patch.strategy === "hash") config.strategy = patch.strategy;
    if (patch.rps !== undefined) config.rps = clamp(patch.rps, 0, 80, config.rps);
    if (patch.rateLimit) {
      config.rateLimit.rate = clamp(patch.rateLimit.rate, 1, 200, config.rateLimit.rate);
      config.rateLimit.burst = clamp(patch.rateLimit.burst, 1, 400, config.rateLimit.burst);
      bucket.configure(config.rateLimit.rate, config.rateLimit.burst);
    }
    emit({ type: "config", config });
  }

  // ---- HTTP + WebSocket -------------------------------------------------------------------
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<any>((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          resolve({});
        }
      });
    });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://gateway");
    const path = url.pathname;
    try {
      if (path === "/api/state" && req.method === "GET") return json(res, 200, snapshot());
      if (path === "/api/config" && req.method === "POST") {
        applyConfig(await readBody(req));
        return json(res, 200, config);
      }
      if (path === "/api/burst" && req.method === "POST") {
        const n = clamp((await readBody(req)).n, 1, 500, 100);
        for (let i = 0; i < n; i++) void handleRequest(`key-${Math.floor(Math.random() * 48)}`);
        return json(res, 202, { n });
      }
      if (path === "/api/request" && req.method === "POST") {
        const key = String((await readBody(req)).key ?? "key-0");
        void handleRequest(key);
        return json(res, 202, { key });
      }
      const m = path.match(/^\/api\/workers\/(\d+)\/(kill|revive)$/);
      if (m && req.method === "POST") {
        const w = byId.get(Number(m[1]));
        if (!w) return json(res, 404, { error: "no such worker" });
        if (m[2] === "kill") w.proc?.kill("SIGKILL");
        else spawnWorker(w);
        return json(res, 200, { id: w.id, action: m[2] });
      }
      if (path.startsWith("/api/")) return json(res, 404, { error: "not found" });
      return serveStatic(path, res);
    } catch (err) {
      return json(res, 500, { error: String(err) });
    }
  });

  function serveStatic(path: string, res: ServerResponse) {
    const rel = normalize(path === "/" ? "/index.html" : path).replace(/^(\.\.[/\\])+/, "");
    let file = join(WEB_DIST, rel);
    if (!file.startsWith(WEB_DIST) || !existsSync(file)) file = join(WEB_DIST, "index.html");
    if (!existsSync(file)) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Frontend not built. Run `npm run build`, or use `npm run dev`.");
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  }

  const wss = new WebSocketServer({ server, path: "/events" });
  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify(snapshot()));
    ws.on("close", () => clients.delete(ws));
  });

  workers.forEach(spawnWorker);
  // Workers need a moment to boot; poll health until all answer (or give up after ~10s).
  for (let i = 0; i < 100 && !workers.every((w) => w.healthy); i++) {
    await Promise.all(workers.map(probe));
    if (!workers.every((w) => w.healthy)) await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise<void>((resolve) => server.listen(opts.port ?? 8080, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 8080);

  async function close() {
    clearInterval(healthTimer);
    clearInterval(trafficTimer);
    workers.forEach((w) => w.proc?.kill("SIGKILL"));
    wss.close();
    for (const c of clients) c.terminate();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }

  return { port, close, workers, config, stats, handleRequest, applyConfig };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1]);
if (isMain) {
  const gw = await createGateway({ port: Number(process.env.PORT ?? 8080) });
  console.log(`vortex gateway listening on http://localhost:${gw.port}`);
  const stop = () => gw.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
