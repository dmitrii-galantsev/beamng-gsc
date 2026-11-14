/**
 * Electrics values the PadPilot vehicle extensions publish (electrics.values.*) and the PadPilot UI app reads from
 * the electrics stream. Shared by the vehicle Lua targets and the UI target. Key names are a public interface.
 */

/** Values AGA publishes for the UI app. Key names are part of the public interface: do not rename. */
interface AgaElectrics {
  agaEnabled?: number;
  agaActive?: number;
  agaCalibrated?: number;
  agaCalibrating?: number;
  agaUnsupported?: number;
  agaLockDeg?: number;
  agaPeakSlip?: number;
  agaLearn?: number;
  agaLearnWhy?: number;
  agaLimit?: number;
  agaSelfSteer?: number;
  /** 1 in rally mode */
  agaRally?: number;
  /** steering gauge, normalized to the lock, positive = right: wheel output, raw stick, grip limit, max reach */
  agaOut?: number;
  agaStick?: number;
  agaGrip?: number;
  agaMax?: number;
  agaCounter?: number;
}
/** Values QuickShift publishes for the UI app. */
interface QsElectrics {
  qsEnabled?: number;
  /** 1 once the stock shift logic was found and wrapped */
  qsAttached?: number;
  qsCoast?: number;
  qsReverse?: number;
}
