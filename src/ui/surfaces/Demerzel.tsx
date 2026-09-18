import { useEffect, useState } from "react";

/* Demerzel's real UI (demerzel/web/index.html + demerzel.js):
   its own palette, state-driven accent, me/them log, the rail. */
const ACCENT: Record<string, string> = {
  offline: "#4a6377", idle: "#1FA8D8", listening: "#18E08A",
  thinking: "#FFB020", speaking: "#35C8FF", busy: "#FF4D6D",
};
type Msg = { who: string; text: string; cls: "me" | "them" | "them unprompted"; c?: string; pending?: boolean };

/* the scripted turn, played on the real surface */
const YOU = "#FF9E3D";
const SCRIPT: { at: number; state?: string; readout?: string; msg?: Msg; pendDone?: boolean }[] = [
  { at: 300, state: "idle", readout: "" },
  { at: 900, state: "listening", readout: "franco 0.97" },
  { at: 1500, msg: { who: "FRANCO", text: "Demerzel — did the weather CLI ship?", cls: "me", c: YOU } },
  { at: 2100, state: "thinking", readout: "…" },
  { at: 3100, state: "speaking", readout: "780 ms", msg: { who: "DEMERZEL", text: "Yes. ana's fetch lane and ben's format lane both merged — weather-cli builds and runs. Say a city and I'll run it for you.", cls: "them", c: "#35C8FF", pending: true } },
  { at: 5200, pendDone: true },
  { at: 5900, state: "idle", readout: "" },
  { at: 6600, msg: { who: "DEMERZEL / FACTORY", text: "Heads-up — the weather-cli gate is green on main. Nothing needs you.", cls: "them unprompted", c: "#35C8FF" } },
];

export function DemerzelSurface() {
  const [state, setState] = useState("offline");
  const [readout, setReadout] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [pendDone, setPendDone] = useState(false);

  useEffect(() => {
    setState("offline"); setReadout(""); setMsgs([]); setPendDone(false);
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const s of SCRIPT) {
      timers.push(setTimeout(() => {
        if (s.state !== undefined) setState(s.state);
        if (s.readout !== undefined) setReadout(s.readout);
        if (s.msg) setMsgs(m => [...m, s.msg!]);
        if (s.pendDone) setPendDone(true);
      }, s.at));
    }
    return () => timers.forEach(clearTimeout);
  }, []);

  const accent = ACCENT[state] || ACCENT.idle;
  return (
    <div className="term dz" key="demerzel" style={{ ["--accent" as string]: accent }}>
      <div className="dzid">
        <span className="dzdot" /><b>Demerzel</b><i>{state}</i>
        <span className="dzspacer" />
        <span className="dzread">{readout}</span>
      </div>
      <div className="dzstage">
        <div className="dzorb" />
      </div>
      <div className="dzlog">
        {msgs.map((m, i) => {
          const pending = m.pending && !pendDone;
          return (
            <p className={`dzmsg ${m.cls}${pending ? " pending" : ""}`} key={i} style={{ ["--c" as string]: m.c || "#35C8FF" }}>
              <span className="dzwho">{m.who}</span>
              <span className="dztxt">{m.text}</span>
            </p>
          );
        })}
      </div>
      <div className="dzrail">
        <button className="dzbtn prim">listen</button>
        <button className="dzbtn">interrupt</button>
        <button className="dzbtn">clear</button>
        <span className="dzspacer" />
        <button className="dzbtn">voices</button>
      </div>
    </div>
  );
}
