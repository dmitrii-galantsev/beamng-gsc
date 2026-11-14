import { isNum } from "./mathx";

const max = math.max;

/** Critically damped spring: `tau` is roughly the time to settle. Never overshoots, frame-rate independent. */
export class Spring {
  x: number;
  v = 0;

  constructor(x = 0) {
    this.x = x;
  }

  set(x: number): void {
    this.x = x;
    this.v = 0;
  }

  damp(target: number, tau: number, dt: number): number {
    const omega = 2 / max(tau, 0.001);
    const k = omega * dt;
    const e = 1 / (1 + k + 0.48 * k * k + 0.235 * k * k * k);
    const change = this.x - target;
    const temp = (this.v + omega * change) * dt;
    this.v = (this.v - omega * temp) * e;
    this.x = target + (change + temp) * e;
    if (!isNum(this.x) || !isNum(this.v)) {
      this.x = target;
      this.v = 0;
    }
    return this.x;
  }
}
