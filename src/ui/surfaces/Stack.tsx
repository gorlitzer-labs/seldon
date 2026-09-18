import { useEffect, useState } from "react";
import { MODULES } from "../../content/modules";
import type { ModuleId } from "../../content/types";

/* the whole stack, in the order one idea actually flows through it —
   each line is what that tool really did for the weather CLI in this course. */
const STAGES: { id: ModuleId; accent: string; did: string }[] = [
  { id: "foundation", accent: "#e8ad3c", did: "queued the plan — a fetch lane and a format lane, one writer each" },
  { id: "apiary", accent: "#34d399", did: "ana ◆ and ben ★ split the lanes and agreed the boundary, live" },
  { id: "comb", accent: "#b794f4", did: "stored WEATHER_API_KEY — by name, never by value" },
  { id: "factory", accent: "#ff8c42", did: "ran each agent boxed — every host secret sealed off" },
  { id: "bifrost", accent: "#5fb0d6", did: "spanned zanpakuto — reachable, sessions survive the lid" },
  { id: "demerzel", accent: "#35C8FF", did: "“it’s live — and nothing needs you”" },
];

function Emblem({ id, accent }: { id: ModuleId; accent: string }) {
  return (
    <span className="stbadge" style={{ borderColor: accent, color: accent }}>
      <svg viewBox="0 0 40 40"><g dangerouslySetInnerHTML={{ __html: MODULES[id].emblem }} /></svg>
    </span>
  );
}

export function StackSurface() {
  const [n, setN] = useState(0);          // stages revealed
  const [shipped, setShipped] = useState(false);
  useEffect(() => {
    setN(0); setShipped(false);
    const timers: ReturnType<typeof setTimeout>[] = [];
    let t = 500;
    STAGES.forEach((_, i) => { timers.push(setTimeout(() => setN(i + 1), t)); t += 620; });
    timers.push(setTimeout(() => setShipped(true), t + 200));
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <div className="term stack" key="stack">
      <div className="tb"><i /><i /><i /><span className="t">the seldon stack — weather-cli, end to end</span></div>
      <div className="stbody">
        <ol className="stflow">
          {STAGES.map((s, i) => {
            const live = i < n;
            return (
              <li className={"strow" + (live ? " live" : "")} key={s.id} style={{ ["--a" as string]: s.accent }}>
                <Emblem id={s.id} accent={s.accent} />
                <div className="stmeta">
                  <div className="sthead">
                    <b style={{ color: s.accent }}>{MODULES[s.id].nm}</b>
                    <span className="strole">{MODULES[s.id].role}</span>
                  </div>
                  <div className="stdid">{s.did}</div>
                </div>
              </li>
            );
          })}
        </ol>
        <div className={"stship" + (shipped ? " on" : "")}>
          <div className="stcmd"><span className="p">$</span> <span className="b">weather</span> Rome</div>
          <div className="stout">Rome: 18°C, light rain</div>
          <div className="stlive"><span className="dotlive" /> one idea → shipped · weather-cli is live</div>
        </div>
      </div>
    </div>
  );
}
