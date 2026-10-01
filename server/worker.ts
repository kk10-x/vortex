import { createServer } from "node:http";

/** A worker is a plain HTTP server in its own OS process, so killing it is a real failure. */
const id = Number(process.env.WORKER_ID ?? 0);
const port = Number(process.env.WORKER_PORT ?? 0);
const baseMs = Number(process.env.WORK_MS ?? 40);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://worker");
  if (url.pathname === "/health") {
    res.writeHead(200).end("ok");
    return;
  }
  const jitter = baseMs * (0.5 + Math.random());
  setTimeout(() => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ worker: id, key: url.searchParams.get("key") }));
  }, jitter);
});

server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
