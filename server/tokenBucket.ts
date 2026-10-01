/** Token bucket: refills `rate` tokens/second up to `burst`. Time source is injectable for tests. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    public rate: number,
    public burst: number,
    private now: () => number = () => performance.now(),
  ) {
    this.tokens = burst;
    this.last = now();
  }

  configure(rate: number, burst: number): void {
    this.rate = rate;
    this.burst = burst;
    this.tokens = Math.min(this.tokens, burst);
  }

  tryTake(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}
