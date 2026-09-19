import { useEffect } from "react";
import { chapters } from "../content/chapters";
import { useDeck, chapterAt, firstStepOfChapter } from "./deck";
/** Two-way sync between the URL hash (#chapterId) and the deck. */
export function useHashRoute() {
  const index = useDeck((s) => s.index);
  const view = useDeck((s) => s.view);
  useEffect(() => {
    const apply = () => {
      const id = location.hash.replace(/^#/, "");
      const ci = chapters.findIndex((c) => c.id === id);
      if (ci >= 0) useDeck.setState({ view: "reel", index: firstStepOfChapter(ci) });
      // empty/unknown hash: leave current view alone (don't force home — that
      // clobbered direct #chapter links under StrictMode's double effect run).
    };
    apply();
    addEventListener("hashchange", apply);
    return () => removeEventListener("hashchange", apply);
  }, []);
  useEffect(() => {
    const want = view === "reel" ? "#" + chapterAt(index).id : "";
    const now = location.hash;
    if (want && now !== want) history.replaceState(null, "", want);
    else if (!want && now) history.replaceState(null, "", location.pathname);
  }, [index, view]);
}
