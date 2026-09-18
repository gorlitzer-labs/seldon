import { useEffect, useRef, useState } from "react";
import { useDeck, beatAt, chapterAt, stepCount } from "../deck/deck";

/** The guide. When sound is on it plays each beat's narration lines in order,
 *  shows them as captions, and walks the lecture forward on its own — the voice
 *  drives the scene, since each beat already carries its focus/view. */
export function Narrator() {
  const index = useDeck((s) => s.index);
  const view = useDeck((s) => s.view);
  const sound = useDeck((s) => s.sound);
  const voice = useDeck((s) => s.voice);
  const next = useDeck((s) => s.next);
  const [caption, setCaption] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const stop = () => { const a = audioRef.current; if (a) { a.pause(); a.src = ""; audioRef.current = null; } };
    if (!sound || view !== "reel") { stop(); setCaption(null); return; }

    const beat = beatAt(index);
    const chap = chapterAt(index);
    const lines = beat.say ?? [];
    if (!lines.length) { stop(); setCaption(null); return; }

    let cancelled = false;
    let i = 0;
    const playLine = () => {
      if (cancelled) return;
      if (i >= lines.length) {
        if (useDeck.getState().index < stepCount - 1) next();   // auto-advance the lecture
        else setCaption(null);                                   // last beat: rest
        return;
      }
      setCaption(lines[i].text);
      const a = new Audio(`vo/${voice}/${chap.id}-${beat.id}-${i}.mp3`);
      audioRef.current = a;
      const step = () => { i++; playLine(); };
      a.onended = step;
      a.onerror = step;
      a.play().catch(() => {});
    };
    playLine();
    return () => { cancelled = true; stop(); };
  }, [index, view, sound, voice, next]);

  if (!caption) return null;
  return (
    <div className="caption" aria-live="polite">
      <span className="capdot" /> {caption}
    </div>
  );
}
