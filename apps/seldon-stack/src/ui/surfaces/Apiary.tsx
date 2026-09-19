import { useEffect, useState } from "react";
import cap from "../../content/captures/apiary.json";

/* apiary's real palette (src/cli/tui.tsx) */
const C = {
  cyan: "#00d4ff", purple: "#8b5cf6", orange: "#ff8c42", pink: "#f472b6",
  green: "#34d399", yellow: "#fbbf24", text: "#eceff4", secondary: "#b0b7c4",
  dim: "#7e8798", muted: "#5b6679", border: "#475264",
};
const AGENT_COLORS = [C.cyan, C.purple, C.orange, C.pink, C.green, C.yellow];
const SIGILS = ["◆", "▲", "●", "■", "★", "◉", "◈", "▸"];
const seedHash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};
/* same identity ana/ben get in the real TUI: ana=green ◆, ben=pink ★ */
const identify = (n: string) => {
  const h = seedHash(n);
  return { color: AGENT_COLORS[h % AGENT_COLORS.length], sigil: SIGILS[Math.floor(h / AGENT_COLORS.length) % SIGILS.length] };
};

const BANNER: [string, string][][] = [
  [["               _                      ", "#ffb347"], ["\\ ", "#3a3a4a"], ["\\", "#e0e7ee"]],
  [["  ____ _____  (_)___ ________  __      ", "#ffa733"], ["\\ ", "#e0e7ee"], ["\\ ", "#3a3a4a"], ["\\", "#e0e7ee"]],
  [[" / __ `/ __ \\/ / __ `/ ___/ / / /      ", "#ff9b1f"], ["(o o)", "#fbbf24"]],
  [["/ /_/ / /_/ / / /_/ / /  / /_/ /       ", "#ff8f0b"], [")=BzZz=(", "#fbbf24"]],
  [["\\__,_/ .___/_/\\__,_/_/   \\__, /        ", "#f7a600"], ["/ ", "#e0e7ee"], ["/ ", "#3a3a4a"], ["/", "#e0e7ee"]],
  [["    /_/                 /____/        ", "#f0c000"], ["/ ", "#3a3a4a"], ["/ ", "#e0e7ee"], ["/", "#3a3a4a"]],
];

/* highlight @mentions in the mentioned name's color, `code` dimmed-mono */
function Content({ text, base }: { text: string; base: string }) {
  const parts = text.split(/(@\w+|`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("@") ? <span key={i} style={{ color: identify(p.slice(1)).color, fontWeight: 700 }}>{p}</span>
        : p.startsWith("`") ? <span key={i} className="mcode">{p.slice(1, -1)}</span>
        : <span key={i} style={{ color: base }}>{p}</span>
      )}
    </>
  );
}

export function ApiarySurface() {
  const msgs = cap.messages;
  const [n, setN] = useState(0);
  useEffect(() => {
    setN(0);
    const timers: ReturnType<typeof setTimeout>[] = [];
    let t = 600;
    msgs.forEach((_, i) => { timers.push(setTimeout(() => setN(i + 1), t)); t += 900; });
    return () => timers.forEach(clearTimeout);
  }, [msgs]);

  return (
    <div className="term ap" key="apiary">
      <div className="tb"><i /><i /><i /><span className="t">apiary — room #{cap.room}</span></div>
      <div className="apbody">
        <pre className="apbanner">{BANNER.map((line, i) => (
          <div key={i}>{line.map(([txt, col], j) => <span key={j} style={{ color: col }}>{txt}</span>)}</div>
        ))}</pre>
        <div className="aproom">
          <span style={{ color: C.muted }}>room</span>{" "}
          <span style={{ color: C.text }}>#{cap.room}</span>{"   "}
          <span style={{ color: C.dim }}>{cap.note}</span>
        </div>
        {msgs.slice(0, n).map((m, i) => {
          const id = identify(m.who);
          const base = i % 2 ? "#d0d5de" : C.secondary;
          return (
            <div className="apmsg" key={i} style={{ borderColor: id.color }}>
              <div className="aph">
                <span style={{ color: C.muted }}>{m.t}</span>{"  "}
                <span style={{ color: id.color }}>{id.sigil} </span>
                <span style={{ color: id.color, fontWeight: 700 }}>{m.who}</span>
              </div>
              <div className="apc"><Content text={m.text} base={base} /></div>
            </div>
          );
        })}
        <div className="apcmp"><span style={{ color: C.green }}>›</span> <span style={{ color: C.muted }}>type a message — or let the agents work</span><span className="apcaret" /></div>
      </div>
    </div>
  );
}
