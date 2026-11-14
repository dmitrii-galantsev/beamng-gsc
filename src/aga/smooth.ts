// SmoothTowards (identical maths to AGALib): moves `state` towards a target at a rate that blends
// linear and exponential approach.
import { sgn } from "../core/mathx";

const abs = math.abs;
const min = math.min;

export class Smooth {
  rate: number;
  linearity: number;
  range: number;
  state: number;
  start: number;

  constructor(rate: number, linearity: number, minV: number, maxV: number, start?: number) {
    this.rate = rate;
    this.linearity = linearity;
    this.range = maxV - minV;
    this.state = start ?? 0;
    this.start = start ?? 0;
  }

  get(val: number, dt: number, rateOverride?: number): number {
    const r = rateOverride ?? this.rate;
    const linSq = this.linearity * this.linearity;
    const rate = (r / (1.0 - 1.0 / (linSq + 1.0 / 0.75))) * 0.5;
    const diffAbsN = abs((val - this.state) / this.range);
    const adjusted = (diffAbsN * (1 - linSq) + linSq) * rate;
    this.state = this.state + sgn(val - this.state) * min(diffAbsN, dt * adjusted) * this.range;
    return this.state;
  }

  getMult(val: number, dt: number, mult: number): number {
    return this.get(val, dt, this.rate * mult);
  }

  reset(): void {
    this.state = this.start;
  }
}
