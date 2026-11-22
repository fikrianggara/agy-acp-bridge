export class KeyedLock {
  private activeLocks = new Set<string>();

  public tryAcquire(key: string): boolean {
    if (this.activeLocks.has(key)) {
      return false;
    }
    this.activeLocks.add(key);
    return true;
  }

  public release(key: string): void {
    this.activeLocks.delete(key);
  }

  public isLocked(key: string): boolean {
    return this.activeLocks.has(key);
  }
}
