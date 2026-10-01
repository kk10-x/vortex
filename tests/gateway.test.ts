import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocket } from "ws";
import type { VortexEvent } from "../shared/types.ts";
import { createGateway } from "../server/gateway.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(25);
  }
}

test("real worker processes: kill one, requests reroute and none are lost", async () => {
  const gw = await createGateway({ port: 0, workerBasePort: 9301, healthIntervalMs: 150 });
  const events: VortexEvent[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/events`);
  ws.on("message", (m) => events.push(JSON.parse(String(m))));
  try {
    await waitFor(() => events.length > 0);
    await waitFor(() => gw.workers.every((w) => w.healthy));
    gw.applyConfig({ rateLimit: { rate: 200, burst: 400 } });

    // Kill worker 2's OS process for real, then immediately send traffic.
    gw.workers.find((w) => w.id === 2)!.proc!.kill("SIGKILL");
    await Promise.all(Array.from({ length: 30 }, (_, i) => gw.handleRequest(`key-${i}`)));
    await sleep(100);

    const done = events.filter((e) => e.type === "done");
    assert.equal(gw.stats.failed, 0, "no request fails while two workers are healthy");
    assert.equal(done.length, 30, "every request completes");
    assert.ok(!done.some((e) => e.type === "done" && e.worker === 2), "dead worker serves nothing");
    assert.ok(
      events.some((e) => e.type === "retry" && e.from === 2),
      "a retry away from worker 2 was emitted",
    );
    await waitFor(() => events.some((e) => e.type === "worker" && e.id === 2 && e.state === "down"));
  } finally {
    ws.close();
    await gw.close();
  }
});

test("rate limiter rejects requests past the burst", async () => {
  const gw = await createGateway({ port: 0, workerBasePort: 9311, healthIntervalMs: 150 });
  try {
    gw.applyConfig({ rateLimit: { rate: 1, burst: 5 } });
    await Promise.all(Array.from({ length: 20 }, (_, i) => gw.handleRequest(`k${i}`)));
    assert.ok(gw.stats.limited >= 14, `expected >=14 limited, got ${gw.stats.limited}`);
  } finally {
    await gw.close();
  }
});

test("hash strategy pins a key to one worker", async () => {
  const gw = await createGateway({ port: 0, workerBasePort: 9321, healthIntervalMs: 150 });
  const events: VortexEvent[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/events`);
  ws.on("message", (m) => events.push(JSON.parse(String(m))));
  try {
    await waitFor(() => events.length > 0);
    gw.applyConfig({ strategy: "hash", rateLimit: { rate: 200, burst: 400 } });
    for (let i = 0; i < 10; i++) await gw.handleRequest("sticky-key");
    await sleep(100);
    const routed = new Set(events.flatMap((e) => (e.type === "routed" ? [e.worker] : [])));
    assert.equal(routed.size, 1);
  } finally {
    ws.close();
    await gw.close();
  }
});
