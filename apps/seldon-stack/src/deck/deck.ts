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

type DeckState = {
  index: number;
  view: "syllabus" | "reel";
  sound: boolean;                // narration on/off (a user gesture flips it)
  voice: "lily" | "george";      // which narrator
  go: (i: number) => void;
  next: () => void;
  prev: () => void;
  toChapter: (ci: number) => void;
  enter: (ci: number) => void;   // from syllabus into the reel
  home: () => void;
  toggleSound: () => void;
  setVoice: (v: "lily" | "george") => void;
};

const clamp = (i: number) => Math.max(0, Math.min(stepCount - 1, i));

export const useDeck = create<DeckState>((set, get) => ({
  index: 0,
  view: "syllabus",
  sound: false,
  voice: "lily",
  go: (i) => set({ index: clamp(i) }),
  next: () => set({ index: clamp(get().index + 1) }),
  prev: () => set({ index: clamp(get().index - 1) }),
  toChapter: (ci) => set({ index: firstStepOfChapter(ci) }),
  enter: (ci) => set({ view: "reel", index: firstStepOfChapter(ci) }),
  home: () => set({ view: "syllabus" }),
  toggleSound: () => set((s) => ({ sound: !s.sound })),
  setVoice: (v) => set({ voice: v }),
}));

/** Convenience selectors. */
export const useBeat = (): Beat => useDeck((s) => beatAt(s.index));
export const useChapter = (): Chapter => useDeck((s) => chapterAt(s.index));
export const useFocus = (): ModuleId | null | undefined => useDeck((s) => beatAt(s.index).focus);
export const useView = (): View => useDeck((s) => beatAt(s.index).view ?? "hive");
