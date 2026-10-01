import type { Config, Strategy, VortexEvent } from "../../shared/types.ts";
import { HashRing } from "../../server/hashRing.ts";
import { TokenBucket } from "../../server/tokenBucket.ts";

export type Mode = "connecting" | "live" | "simulated";

export interface View {
  mode: Mode;
  workers: { id: number; healthy: boolean; served: number }[];
  config: Config;
  sent: number;
  limited: number;
  rerouted: number;
  failed: number;
}

type Listener = (e: VortexEvent) => void;

/**
 * Talks to the gateway when one is reachable. If not (for example, a static deploy), it falls
 * back to a local simulator that reuses the same HashRing and TokenBucket code, and the UI
 * labels itself SIMULATED so nobody mistakes it for real processes.
 */
export class Api {
  view: View = {
    mode: "connecting",
    workers: [1, 2, 3].map((id) => ({ id, healthy: true, served: 0 })),
    config: { strategy: "round-robin", rps: 0, rateLimit: { rate: 40, burst: 60 } },
    sent: 0,
    limited: 0,
    rerouted: 0,
    failed: 0,
  };
  private listeners = new Set<Listener>();
  private ws: WebSocket | null = null;
  private sim: Simulator | null = null;

  on(fn: Listener) {
    this.listeners.add(fn);
  }

  private dispatch(e: VortexEvent) {
    const v = this.view;
    switch (e.type) {
      case "state":
        v.workers = e.workers;
        v.config = e.config;
        v.sent = e.stats.sent;
        v.limited = e.stats.limited;
        v.rerouted = e.stats.rerouted;
        v.failed = e.stats.failed;
        break;
      case "config":
        v.config = e.config;
        break;
      case "routed":
        if (!e.retried) v.sent++;
        break;
      case "limited":
        v.sent++;
        v.limited++;
        break;
      case "retry":
        v.rerouted++;
        break;
      case "failed":
        v.failed++;
        break;
      case "done": {
        const w = v.workers.find((x) => x.id === e.worker);
        if (w) w.served++;
        break;
      }
      case "worker": {
        const w = v.workers.find((x) => x.id === e.id);
        if (w) w.healthy = e.state === "up";
        break;
      }
    }
    for (const fn of this.listeners) fn(e);
  }

  connect(): Promise<Mode> {
    return new Promise((resolve) => {
      // Relative to the page URL so the app also works when mounted under a path prefix (e.g. /vortex/).
      const wsUrl = new URL("events", document.baseURI);
      wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
      let settled = false;
      const fallback = () => {
        if (settled) return;
        settled = true;
        this.ws?.close();
        this.sim = new Simulator((e) => this.dispatch(e));
        this.view.mode = "simulated";
        resolve("simulated");
      };
      const timer = setTimeout(fallback, 1500);
      try {
        const ws = new WebSocket(wsUrl);
        this.ws = ws;
        ws.onmessage = (m) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            this.view.mode = "live";
            resolve("live");
          }
          this.dispatch(JSON.parse(String(m.data)) as VortexEvent);
        };
        ws.onerror = fallback;
        ws.onclose = () => {
          if (!settled) fallback();
          else this.view.mode = "connecting";
        };
      } catch {
        fallback();
      }
    });
  }

  private post(path: string, body?: unknown) {
    return fetch(new URL(path, document.baseURI), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }).catch(() => undefined);
  }

  setConfig(patch: { strategy?: Strategy; rps?: number; rateLimit?: { rate?: number; burst?: number } }) {
    if (this.sim) this.sim.applyConfig(patch);
    else void this.post("api/config", patch);
  }
  kill(id: number) {
    if (this.sim) this.sim.kill(id);
    else void this.post(`api/workers/${id}/kill`);
  }
  revive(id: number) {
    if (this.sim) this.sim.revive(id);
    else void this.post(`api/workers/${id}/revive`);
  }
  burst(n: number) {
    if (this.sim) this.sim.burst(n);
    else void this.post("api/burst", { n });
  }
}

/** In-browser stand-in for the gateway: same routing algorithms, no real processes. */
class Simulator {
  private config: Config = { strategy: "round-robin", rps: 0, rateLimit: { rate: 40, burst: 60 } };
  private bucket = new TokenBucket(40, 60);
  private ring = new HashRing([1, 2, 3]);
  private dead = new Set<number>();
  private believedUp = new Set<number>([1, 2, 3]);
  private rr = 0;
  private nextId = 1;
  private carry = 0;

  constructor(private emit: Listener) {
    emit({
      type: "state",
      workers: [1, 2, 3].map((id) => ({ id, healthy: true, served: 0 })),
      config: this.config,
      stats: { sent: 0, limited: 0, rerouted: 0, failed: 0 },
    });
    setInterval(() => {
      this.carry += (this.config.rps * 50) / 1000;
      while (this.carry >= 1) {
        this.carry -= 1;
        this.request();
      }
    }, 50);
    // Health checks lag a real failure by up to ~400 ms, like the gateway's probe interval.
    setInterval(() => {
      for (const id of [1, 2, 3]) {
        const up = !this.dead.has(id);
        if (up !== this.believedUp.has(id)) {
          if (up) this.believedUp.add(id);
          else this.believedUp.delete(id);
          emit({ type: "worker", id, state: up ? "up" : "down" });
        }
      }
    }, 400);
  }

  applyConfig(p: { strategy?: Strategy; rps?: number; rateLimit?: { rate?: number; burst?: number } }) {
    if (p.strategy) this.config.strategy = p.strategy;
    if (p.rps !== undefined) this.config.rps = Math.min(80, Math.max(0, p.rps));
    if (p.rateLimit) {
      this.config.rateLimit.rate = Math.min(200, Math.max(1, p.rateLimit.rate ?? this.config.rateLimit.rate));
      this.config.rateLimit.burst = Math.min(400, Math.max(1, p.rateLimit.burst ?? this.config.rateLimit.burst));
      this.bucket.configure(this.config.rateLimit.rate, this.config.rateLimit.burst);
    }
    this.emit({ type: "config", config: this.config });
  }
  kill(id: number) {
    this.dead.add(id);
  }
  revive(id: number) {
    this.dead.delete(id);
  }
  burst(n: number) {
    for (let i = 0; i < n; i++) this.request();
  }

  private pick(key: string, exclude: Set<number>): number | undefined {
    const usable = (id: number) => !exclude.has(id) && this.believedUp.has(id);
    if (this.config.strategy === "hash") return this.ring.lookup(key, usable);
    for (let i = 0; i < 3; i++) {
      const id = (this.rr++ % 3) + 1;
      if (usable(id)) return id;
    }
    return undefined;
  }

  private request() {
    const id = this.nextId++;
    const key = `key-${Math.floor(Math.random() * 48)}`;
    if (!this.bucket.tryTake()) {
      this.emit({ type: "limited", id, key });
      return;
    }
    const tried = new Set<number>();
    let attempt = 0;
    const step = () => {
      const w = attempt < 3 ? this.pick(key, tried) : undefined;
      if (w === undefined) {
        this.emit({ type: "failed", id, key });
        return;
      }
      this.emit({ type: "routed", id, key, worker: w, retried: attempt > 0 });
      attempt++;
      if (this.dead.has(w)) {
        tried.add(w);
        this.believedUp.delete(w);
        this.emit({ type: "worker", id: w, state: "down" });
        this.emit({ type: "retry", id, from: w });
        setTimeout(step, 5);
        return;
      }
      const ms = 20 + Math.random() * 40;
      setTimeout(() => this.emit({ type: "done", id, worker: w, ms: Math.round(ms) }), ms);
    };
    step();
  }
}
