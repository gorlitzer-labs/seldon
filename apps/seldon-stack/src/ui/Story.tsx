import { useBeat } from "../deck/deck";
export function Story() {
  const beat = useBeat();
  return (
    <div className="story">
      <div key={beat.id} className="beat-enter" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {beat.kicker && <div className="kicker">{beat.kicker}</div>}
        <h2>{beat.heading}</h2>
        {beat.body && <div className="body">{beat.body.map((p, i) => <p key={i}>{p}</p>)}</div>}
      </div>
    </div>
  );
}
