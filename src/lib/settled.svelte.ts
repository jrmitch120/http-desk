// A value that follows its source only once the source has stopped changing for a
// moment, so something shown from it doesn't flicker while the source keeps changing
// (the Problems count while you type, #217).

export class Settled<T> {
  /** The source's value when it last stopped changing for `ms`; none until first tracked. */
  private taken = $state.raw<{ value: T } | null>(null);
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly read: () => T,
    private readonly ms: number,
  ) {}

  /** The source's value when it last stopped changing for `ms`: until first tracked, the source's own. */
  get current(): T {
    return this.taken ? this.taken.value : this.read();
  }

  /**
   * Reads the source: call it from an effect, which reruns on each change to it. The
   * first read is taken at once; after that, each change waits `ms` again, and the
   * value read last is taken once no other follows.
   */
  track() {
    const value = this.read();
    clearTimeout(this.timer);
    if (!this.taken) this.taken = { value };
    else this.timer = setTimeout(() => (this.taken = { value }), this.ms);
  }
}
