// User configuration: defaults, validation, and the values derived from the single "Assist strength" slider.
import { applySettings } from "../core/settings";

/** Keys are the JSON keys of settings/agaSteering.json (shared with the UI app): do not rename. */
export interface Config {
  enabled: boolean;
  /** also process keyboard steering (FILTER_KBD / KBD2) */
  applyToKeyboard: boolean;
  /** 0..1, how fast the steering follows the stick */
  steeringRate: number;
  /** 0..1, "Assist strength": higher = more self-steer, steadier */
  filterSetting: number;
  /** rally mode: the top of the stick steers past the grip limit (see calcCorrectedSteering) */
  rally: boolean;
  /** 0.4..0.9, stick position where rally mode starts adding angle past the grip limit */
  rallyKnee: number;
  /** deg, extra angle past the grip limit at speed (up to full lock when slow) */
  rallyExtraDeg: number;
  /** derive the advanced params below from filterSetting (like AGA) */
  useFilter: boolean;
  /** multiplier on the target front slip angle */
  targetSlip: number;
  /** deg */
  maxSelfSteerAngle: number;
  // advanced (only used when useFilter = false)
  rateIncreaseWithSpeed: number;
  selfSteerResponse: number;
  dampingStrength: number;
  countersteerResponse: number;
  maxDynamicLimitReduction: number;
  // BeamNG-specific
  /** starting estimate of front peak slip angle (deg); 0 = auto from tyre friction (~8 for road tyres) */
  peakSlipDeg: number;
  learnPeakSlip: boolean;
  /** measure steering lock + curve + direction at standstill on spawn */
  calibrate: boolean;
  /** flip the yaw-damping term while travelling backwards (original AGA anti-damps in reverse) */
  reverseDampingFix: boolean;
  /** seconds; optional low-pass on the measured axle velocities (0 = off, like AGA) */
  velocitySmoothing: number;
  /** streams values to the "Generic Graph" UI app */
  debug: boolean;
}

type NumericKey = { [K in keyof Config]: Config[K] extends number ? K : never }[keyof Config];

/** Same as AGA factory defaults. */
export const defaults: Readonly<Config> = {
  enabled: true,
  applyToKeyboard: false,
  steeringRate: 0.5,
  filterSetting: 0.5,
  rally: false,
  rallyKnee: 0.65,
  rallyExtraDeg: 18,
  useFilter: true,
  targetSlip: 0.95,
  maxSelfSteerAngle: 90.0,
  rateIncreaseWithSpeed: 0.0,
  selfSteerResponse: 0.37,
  dampingStrength: 0.37,
  countersteerResponse: 0.2,
  maxDynamicLimitReduction: 5.0,
  peakSlipDeg: 0,
  learnPeakSlip: true,
  calibrate: true,
  reverseDampingFix: true,
  velocitySmoothing: 0,
  debug: false,
};

/** Allowed ranges for numeric keys (anything outside is clamped). */
export const ranges: Readonly<Partial<Record<NumericKey, readonly [number, number]>>> = {
  steeringRate: [0.01, 1],
  filterSetting: [0, 1],
  targetSlip: [0.5, 1.5],
  maxSelfSteerAngle: [0, 90],
  rateIncreaseWithSpeed: [-0.5, 0.5],
  selfSteerResponse: [0, 1],
  dampingStrength: [0, 1],
  countersteerResponse: [0, 1],
  maxDynamicLimitReduction: [0, 10],
  peakSlipDeg: [0, 20],
  rallyKnee: [0.4, 0.9],
  rallyExtraDeg: [0, 60],
  velocitySmoothing: [0, 0.2],
};

/**
 * Rebuilds `cfg` IN PLACE (getState() hands out this very table) from defaults + `data` (the parsed JSON, or
 * anything else: see core/settings.ts), clamps the numeric keys, derives the advanced
 * parameters when useFilter is set, and finally applies the runtime enable override.
 */
export function applyConfig(cfg: Config, data: unknown, enabledOverride: boolean | undefined): void {
  applySettings(cfg, defaults, ranges, data);
  if (cfg.useFilter) {
    const f = cfg.filterSetting;
    cfg.rateIncreaseWithSpeed = (1.0 - f) * 0.2 - 0.1;
    cfg.selfSteerResponse = f * 0.5 + 0.12;
    cfg.dampingStrength = cfg.selfSteerResponse;
    cfg.maxSelfSteerAngle = 90.0;
    cfg.maxDynamicLimitReduction = 3 * f + 3.5;
    cfg.countersteerResponse = (1.0 - f) * 0.2 + 0.1;
    cfg.targetSlip = 0.95 - (f - 0.5) * 0.04;
  }
  if (enabledOverride !== undefined) cfg.enabled = enabledOverride;
}
