import { useEffect, useState } from "react";
import { MODULES } from "../../content/modules";
import type { ModuleId } from "../../content/types";

/* Pull one piece out — what the stack becomes, and the job that shape fits.
   The whole point of a stack: match the combo to the work. */
const APART: { id: ModuleId; accent: string; becomes: string; job: string }[] = [
  { id: "demerzel", accent: "#35C8FF", becomes: "you drive by terminal — no hands-free voice", job: "heads-down, scripted runs" },
  { id: "comb", accent: "#b794f4", becomes: "remote agents go blind — keys don't travel", job: "single-machine, local-only work" },
  { id: "factory", accent: "#ff8c42", becomes: "tools you run by hand — nothing supervises", job: "a one-off build, no 24/7 loop" },
  { id: "bifrost", accent: "#5fb0d6", becomes: "one machine only — no realms, no phone", job: "a single workstation" },
  { id: "apiary", accent: "#34d399", becomes: "one agent, no room — lanes can't split", job: "a small, single-threaded task" },
  { id: "foundation", accent: "#e8ad3c", becomes: "no shared plan — agents improvise", job: "a throwaway spike" },
];

function Emblem({ id, accent }: { id: ModuleId; accent: string }) {
  return (
    <span className="apbadge" style={{ borderColor: accent, color: accent }}>
      <svg viewBox="0 0 40 40"><g dangerouslySetInnerHTML={{ __html: MODULES[id].emblem }} /></svg>
      <span className="apx">−</span>
    </span>
  );
}

export function StackApartSurface() {
  const [n, setN] = useState(0);
  useEffect(() => {
    setN(0);
    const timers: ReturnType<typeof setTimeout>[] = [];
    let t = 450;
    APART.forEach((_, i) => { timers.push(setTimeout(() => setN(i + 1), t)); t += 420; });
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <div className="term apart" key="apart">
      <div className="tb"><i /><i /><i /><span className="t">composable — take one out</span></div>
      <div className="apbody2">
        {APART.map((s, i) => {
          const live = i < n;
          return (
            <div className={"aprow" + (live ? " live" : "")} key={s.id} style={{ ["--a" as string]: s.accent }}>
              <Emblem id={s.id} accent={s.accent} />
              <div className="apmeta">
                <div className="aphead"><span className="apminus">without</span> <b style={{ color: s.accent }}>{MODULES[s.id].nm}</b></div>
                <div className="apbecomes">{s.becomes}</div>
                <div className="apjob"><span className="apgood">good for</span> {s.job}</div>
              </div>
            </div>
          );
        })}
        <div className="apnote">every combo is powerful — for a different job</div>
      </div>
    </div>
  );
}
