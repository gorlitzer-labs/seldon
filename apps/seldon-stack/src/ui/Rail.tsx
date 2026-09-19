import { chapters } from "../content/chapters";
import { useDeck, chapterAt } from "../deck/deck";
export function Rail() {
  const index = useDeck((s) => s.index);
  const toChapter = useDeck((s) => s.toChapter);
  const current = chapterAt(index).id;
  return (
    <nav className="rail" aria-label="Chapters">
      {chapters.map((c, ci) => (
        <button key={c.id} className={c.id === current ? "on" : ""} onClick={() => toChapter(ci)}>
          <span className="lbl">{c.short}</span>
          <span className="mk">{c.marker}</span>
          <span className="nub" />
        </button>
      ))}
    </nav>
  );
}
