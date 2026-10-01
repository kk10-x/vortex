/** FNV-1a, 32-bit. Good enough distribution for a demo ring; not cryptographic. */
export function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Consistent-hash ring with virtual nodes. `lookup` walks clockwise from the key's position and
 * returns the first node the caller considers alive, so a dead owner's keys fall to its ring
 * neighbours instead of reshuffling every key.
 */
export class HashRing {
  private ring: { point: number; node: number }[] = [];

  constructor(nodes: number[], vnodes = 64) {
    for (const node of nodes) {
      for (let v = 0; v < vnodes; v++) {
        this.ring.push({ point: fnv1a(`node-${node}#${v}`), node });
      }
    }
    this.ring.sort((a, b) => a.point - b.point);
  }

  lookup(key: string, isAlive: (node: number) => boolean = () => true): number | undefined {
    if (this.ring.length === 0) return undefined;
    const h = fnv1a(key);
    let lo = 0;
    let hi = this.ring.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.ring[mid]!.point < h) lo = mid + 1;
      else hi = mid;
    }
    for (let i = 0; i < this.ring.length; i++) {
      const entry = this.ring[(lo + i) % this.ring.length]!;
      if (isAlive(entry.node)) return entry.node;
    }
    return undefined;
  }
}
