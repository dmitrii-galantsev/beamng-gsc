/** The part of BeamNG's UI (CEF / AngularJS) bridge the DriveKit app uses. */

/** Lua bridges. `engineLua` runs in the game-engine VM; the result of the chunk is handed to `cb`. */
declare const bngApi: {
  engineLua(code: string, cb?: (data: unknown) => void): void;
  /** runs in the vehicle VM of the player's car */
  activeObjectLua(code: string): void;
};

/** Subscribes the app to data streams (delivered as the `streamsUpdate` event). Absent outside the game. */
declare const StreamsManager: { add(streams: string[]): void; remove(streams: string[]): void } | undefined;
