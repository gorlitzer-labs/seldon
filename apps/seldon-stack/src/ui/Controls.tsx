import { useDeck, stepCount } from "../deck/deck";
export function Controls() {
  const { index, next, prev, home, sound, toggleSound, voice, setVoice } = useDeck();
  return (
    <>
      <div className="progress" style={{ width: `${((index + 1) / stepCount) * 100}%` }} />
      <div className="controls">
        <button className="cbtn home" onClick={home} aria-label="Home">⌂</button>
        <button className={"cbtn narrate" + (sound ? " on" : "")} onClick={toggleSound}
          aria-label={sound ? "Mute narration" : "Play narration"} aria-pressed={sound}>
          {sound ? "❚❚ narrating" : "▶ narrate"}
        </button>
        <div className="vpick" role="group" aria-label="Narrator voice">
          <button className={"vopt" + (voice === "lily" ? " on" : "")} onClick={() => setVoice("lily")}>Lily</button>
          <button className={"vopt" + (voice === "george" ? " on" : "")} onClick={() => setVoice("george")}>George</button>
        </div>
        <span className="spacer" />
        <button className="cbtn" onClick={prev} aria-label="Previous">‹</button>
        <button className="cbtn" onClick={next} aria-label="Next">›</button>
        <span className="count">{String(index + 1).padStart(2, "0")} / {stepCount}</span>
      </div>
    </>
  );
}
