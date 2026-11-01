/** Restores scheduler jobs after a startup database outage, without overlapping attempts. */
export class SchedulerRecovery {
  private ready = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly restore: () => Promise<void>,
    private readonly onFailure: (error: unknown) => void,
    private readonly retryDelayMs = 30_000,
  ) {}

  isReady() { return this.ready && !this.stopped; }

  async start(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.restore();
      if (!this.stopped) this.ready = true;
    } catch (error) {
      if (this.stopped) return;
      this.onFailure(error);
      this.timer = setTimeout(() => { void this.start(); }, this.retryDelayMs);
    }
  }

  stop() {
    this.stopped = true;
    this.ready = false;
    if (this.timer) clearTimeout(this.timer);
  }
}
