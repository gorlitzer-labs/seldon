import { create } from "zustand";
import { chapters } from "../content/chapters";
import type { Beat, Chapter, ModuleId, View } from "../content/types";

export type Step = { chapter: number; beat: number };

/** Flat, ordered list of every beat — a chapter boundary is not special. */
const STEPS: Step[] = chapters.flatMap((c, ci) => c.beats.map((_, bi) => ({ chapter: ci, beat: bi })));

export const stepCount = STEPS.length;
export const beatAt = (i: number): Beat => chapters[STEPS[i].chapter].beats[STEPS[i].beat];
export const chapterAt = (i: number): Chapter => chapters[STEPS[i].chapter];
export const firstStepOfChapter = (ci: number): number => STEPS.findIndex((s) => s.chapter === ci);

/** A narration-line override: while a say line is speaking it can fly the camera
 *  (look) and swap the view, so ONE beat can walk through several modules. */
export type Cue = { look?: ModuleId | null; view?: View } | null;

type DeckState = {
  index: number;
  view: "syllabus" | "reel";
  sound: boolean;                // narration on/off (a user gesture flips it)
  voice: "lily" | "george";      // which narrator
  cue: Cue;                      // transient per-line scene override
  go: (i: number) => void;
  next: () => void;
  prev: () => void;
  toChapter: (ci: number) => void;
  enter: (ci: number) => void;   // from syllabus into the reel
  home: () => void;
  toggleSound: () => void;
  setVoice: (v: "lily" | "george") => void;
  setCue: (c: Cue) => void;
};

const clamp = (i: number) => Math.max(0, Math.min(stepCount - 1, i));

export const useDeck = create<DeckState>((set, get) => ({
  index: 0,
  view: "syllabus",
  sound: false,
  voice: "lily",
  cue: null,
  // any manual navigation clears a stale cue so the beat's own framing takes over
  go: (i) => set({ index: clamp(i), cue: null }),
  next: () => set({ index: clamp(get().index + 1), cue: null }),
  prev: () => set({ index: clamp(get().index - 1), cue: null }),
  toChapter: (ci) => set({ index: firstStepOfChapter(ci), cue: null }),
  enter: (ci) => set({ view: "reel", index: firstStepOfChapter(ci), cue: null }),
  home: () => set({ view: "syllabus", cue: null }),
  toggleSound: () => set((s) => ({ sound: !s.sound })),
  setVoice: (v) => set({ voice: v }),
  setCue: (c) => set({ cue: c }),
}));

/** Convenience selectors — a live cue overrides the beat's own focus/view. */
export const useBeat = (): Beat => useDeck((s) => beatAt(s.index));
export const useChapter = (): Chapter => useDeck((s) => chapterAt(s.index));
export const useFocus = (): ModuleId | null | undefined =>
  useDeck((s) => (s.cue && "look" in s.cue ? s.cue.look : beatAt(s.index).focus));
export const useView = (): View =>
  useDeck((s) => s.cue?.view ?? beatAt(s.index).view ?? "hive");
