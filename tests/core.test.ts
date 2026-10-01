import assert from "node:assert/strict";
import { test } from "node:test";
import { HashRing } from "../server/hashRing.ts";
import { TokenBucket } from "../server/tokenBucket.ts";

test("token bucket allows a burst, then rejects, then refills over time", () => {
  let now = 0;
  const bucket = new TokenBucket(10, 5, () => now);
  const first = Array.from({ length: 7 }, () => bucket.tryTake());
  assert.deepEqual(first, [true, true, true, true, true, false, false]);
  now += 300; // 10 tokens/s * 0.3s = 3 tokens
  assert.deepEqual(
    [bucket.tryTake(), bucket.tryTake(), bucket.tryTake(), bucket.tryTake()],
    [true, true, true, false],
  );
});

test("hash ring is stable: the same key always maps to the same node", () => {
  const ring = new HashRing([1, 2, 3]);
  for (let i = 0; i < 100; i++) assert.equal(ring.lookup(`k${i}`), ring.lookup(`k${i}`));
});

test("hash ring spreads keys across all nodes", () => {
  const ring = new HashRing([1, 2, 3]);
  const counts = new Map<number, number>();
  for (let i = 0; i < 3000; i++) {
    const n = ring.lookup(`key-${i}`)!;
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  for (const n of [1, 2, 3]) assert.ok((counts.get(n) ?? 0) > 600, `node ${n} got ${counts.get(n)}`);
});

test("when a node dies only its keys move; every other key keeps its owner", () => {
  const ring = new HashRing([1, 2, 3]);
  const keys = Array.from({ length: 2000 }, (_, i) => `key-${i}`);
  const before = new Map(keys.map((k) => [k, ring.lookup(k)!]));
  const alive = (n: number) => n !== 2;
  let moved = 0;
  for (const k of keys) {
    const after = ring.lookup(k, alive)!;
    assert.notEqual(after, 2);
    if (before.get(k) === 2) moved++;
    else assert.equal(after, before.get(k), "a key not owned by the dead node must not move");
  }
  assert.ok(moved > 0);
});

test("lookup returns undefined when every node is dead", () => {
  assert.equal(new HashRing([1, 2]).lookup("x", () => false), undefined);
});
