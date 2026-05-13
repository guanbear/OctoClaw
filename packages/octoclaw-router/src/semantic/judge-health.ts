export class JudgeHealthTracker {
  private callLog: Array<{ timestamp: number; success: boolean }> = [];
  private cooldownUntil = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  recordSuccess(): void {
    this.callLog.push({ timestamp: this.now(), success: true });
    this.trim();
  }

  recordFailure(_reason: string): void {
    this.callLog.push({ timestamp: this.now(), success: false });
    this.trim();
    this.maybeEnterCooldown();
  }

  isInCooldown(): boolean {
    return this.now() < this.cooldownUntil;
  }

  getCooldownUntil(): number {
    return this.cooldownUntil;
  }

  private trim(): void {
    if (this.callLog.length > 50) {
      this.callLog = this.callLog.slice(-50);
    }
  }

  private maybeEnterCooldown(): void {
    if (this.callLog.length < 10) return;
    const recent10 = this.callLog.slice(-10);
    const failures = recent10.filter((call) => !call.success).length;
    if (failures >= 5) {
      this.cooldownUntil = this.now() + 30 * 60 * 1000;
    }
  }
}
