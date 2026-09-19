import { chapters } from "../content/chapters";
import { useDeck } from "../deck/deck";
export function Syllabus() {
  const enter = useDeck((s) => s.enter);
  return (
    <div className="syllabus">
      <div className="in">
        <div className="eye">An interactive course · {chapters.length} lectures · the Seldon stack</div>
        <h1>Seldon</h1>
        <p className="lede">A software factory of AI agents. Each lecture takes one module of the stack, shows a real workflow it ran, and makes the case for how much it does with how little. Take the hive apart, piece by piece.</p>
        <div className="list">
          {chapters.map((c, ci) => (
            <button key={c.id} className="row" onClick={() => enter(ci)}>
              <span className="mk">{c.marker}</span>
              <span className="ti">{c.title}</span>
              <span className="go">enter →</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
