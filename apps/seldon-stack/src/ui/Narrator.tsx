import { useEffect, useRef, useState } from "react";
import { useDeck, beatAt, chapterAt, stepCount } from "../deck/deck";

/** The guide. With sound on it plays each beat's narration lines in order, shows
 *  them as captions, drives the scene per line (a line can fly the camera to a
 *  module and swap the view), and walks the lecture forward on its own. Lines
 *  without a voice clip are paced by a timer so an un-voiced walk still animates. */
export function Narrator() {
  const index = useDeck((s) => s.index);
  const view = useDeck((s) => s.view);
  const sound = useDeck((s) => s.sound);
  const voice = useDeck((s) => s.voice);
  const next = useDeck((s) => s.next);
  const setCue = useDeck((s) => s.setCue);
  const [caption, setCaption] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const stop = () => { const a = audioRef.current; if (a) { a.pause(); a.src = ""; audioRef.current = null; } };
    if (!sound || view !== "reel") { stop(); setCaption(null); setCue(null); return; }

    const beat = beatAt(index);
    const chap = chapterAt(index);
    const lines = beat.say ?? [];
    if (!lines.length) { stop(); setCaption(null); setCue(null); return; }

    let cancelled = false;
    let i = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const at = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));
    setCaption(null); // blank while the camera flies in

    const playLine = () => {
      if (cancelled) return;
      if (i >= lines.length) {
        setCaption(null);
        if (useDeck.getState().index < stepCount - 1) at(1100, () => { if (!cancelled) next(); });
        return;
      }
      const line = lines[i];
      // drive the scene for this line
      const cue: { look?: typeof line.look; view?: typeof line.view } = {};
      if (line.look !== undefined) cue.look = line.look;
      if (line.view) cue.view = line.view;
      setCue(Object.keys(cue).length ? cue : null);
      setCaption(line.text);

      // advance exactly once per line, whichever signal arrives first
      let stepped = false;
      const advance = () => { if (cancelled || stepped) return; stepped = true; i++; playLine(); };
      const paced = Math.min(4600, Math.max(2100, line.text.length * 52));
      const a = new Audio(`vo/${voice}/${chap.id}-${beat.id}-${i}.mp3`);
      a.preservesPitch = false;
      a.playbackRate = 0.92;
      audioRef.current = a;
      a.onended = advance;
      a.onerror = () => at(paced, advance); // no clip yet -> pace by timer so the walk still animates
      // If play() is REJECTED (mobile Safari blocks audio started outside a tap),
      // pace forward instead of freezing. Plus a hard backstop so a clip that
      // loads but never fires 'ended' (buffer stall) can't wedge the whole reel.
      a.play().catch(() => at(paced, advance));
      at(14000, advance);
    };
    at(700, playLine); // lead-in: let the camera arrive before she speaks
    return () => { cancelled = true; timers.forEach(clearTimeout); stop(); setCue(null); };
  }, [index, view, sound, voice, next, setCue]);

  if (!caption) return null;
  return (
    <div className="caption" aria-live="polite">
      <span className="capdot" /> {caption}
    </div>
  );
}
