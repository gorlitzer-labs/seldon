export type ModuleId =
  | "foundation" | "apiary" | "factory" | "comb" | "bifrost" | "demerzel";

/** What the reader is looking at during a beat. */
export type View = "hive" | "surface" | "combo";

/** One narration line + the scene cue it fires (voice comes later; text now). */
export type SayLine = { text: string; look?: ModuleId | null; view?: View };

/** A subchapter: one framed moment with copy, a scene state, and narration. */
export type Beat = {
  id: string;
  kicker?: string;
  heading: string;
  body?: string[];
  /** Which module the camera frames / lifts. null = the whole hive. */
  focus?: ModuleId | null;
  view?: View;
  say?: SayLine[];
};

export type Chapter = {
  id: string;
  marker: string;      // "00", "01", ...
  title: string;
  short: string;
  module?: ModuleId;   // module chapters carry their id
  beats: Beat[];
};
