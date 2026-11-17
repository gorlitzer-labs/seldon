// The docs view: short topics, a search box, nothing long. Each topic says what it is in a line
// or three and shows a couple of examples you can type. Pure data + search, so it is tested.

export const TOPICS = [
  { id: "steward", title: "The steward", tags: "steward assistant one agent relay orders boss manager",
    what: ["The one agent you talk to. It turns what your agents ask into one short", "message, sends each one your answer, and carries out your orders.", "It never decides for you."],
    examples: [["seldon steward", "start it: row 1 in the list"], ["what needs me?", "ask it, then answer \"1 yes, 2 later\""], ["seldon steward stop", "stop it"]] },
  { id: "workspace", title: "The workspace", tags: "ws start open terminal",
    what: ["Every agent from both laptops in one terminal: the list on the left,", "the agent you talk to on the right. Leaving never stops an agent."],
    examples: [["seldon ws", "open it (again: reconnects)"], ["seldon ws stop", "close it, agents keep going"]] },
  { id: "keys", title: "Keys", tags: "alt option shortcut hotkey move switch",
    what: ["List: space enters an agent, a replies, 1-9 picks an option. ⌥← back,", "⌥n jumps to the next agent waiting on you, ⌥q leaves. ? shows them all."],
    examples: [["⌃g then 3", "same as ⌥3, when ⌥ does nothing"]] },
  { id: "new-project", title: "A new project", tags: "new repo project folder create mkdir init",
    what: ["A new folder in ~/Desktop with git, and an agent on the task.", "N in the list asks name, task and agent. The steward can do it too."],
    examples: [['seldon new tide-tables --task "a CLI for tides"', "from a shell"], ["N", "in the list"]] },
  { id: "new-agent", title: "Start an agent", tags: "new lane spawn create task",
    what: ["n in the list, type the task, pick 1 claude · 2 codex · 3 opencode.", "Each agent gets its own branch and worktree."],
    examples: [["n", "in the list or the panel"], ['seldon lane start --task "fix the save crash"', "from a shell"], ["--agent codex", "pick the agent"]] },
  { id: "waiting", title: "Who needs me", tags: "needs you flag next permission waiting",
    what: ["The list puts agents waiting on you on top, under NEEDS YOU, and the card on", "the right shows the question. From the list: 1-9 picks an option, a replies."],
    examples: [["⌥n", "next agent waiting on you"], ["/", "filter the list"], ["seldon ls", "everything, as text"]] },
  { id: "answer", title: "Read or answer an agent", tags: "say read reply yes tell",
    what: ["Open it and type, like any terminal. Or from a shell, without opening it.", "say only types into an agent that is waiting."],
    examples: [["seldon lane read tars", "what it last said"], ['seldon lane say tars "yes"', "answer it"]] },
  { id: "stop", title: "Stop, resume, clean up", tags: "stop kill resume restart remove rm reboot",
    what: ["x in the panel stops an agent (it asks first). Its conversation and", "worktree are kept: R brings it back. rm removes the worktree."],
    examples: [["x", "in the panel, then y"], ["R", "resume what a reboot stopped"], ["seldon lane rm joey-blacklist", "clean up after merge"]] },
  { id: "phone", title: "From the phone", tags: "mobile ssh iphone small",
    what: ["ssh in, run seldon ws: one screen at a time. The list shows the card of the", "agent you pick; a or 1 answers it, space enters it, ⌥← (or ⌃g ←) comes back."],
    examples: [["ssh franco-mbp", "then: seldon ws"]] },
  { id: "machines", title: "The other laptop", tags: "machines remote ssh arrancar p2p",
    what: ["Add it once. Its agents show with @name and open over ssh.", "Asleep? They show ☾ paused and come back when it wakes."],
    examples: [["seldon machines add arrancar you@arrancar", "once"], ["seldon machines", "who is reachable"]] },
  { id: "telegram", title: "Telegram alerts", tags: "telegram phone notify alert watch tell",
    what: ["The watcher sends a card when an agent needs you, fails or finishes.", "Any agent can also message you."],
    examples: [["seldon watch", "run the watcher"], ['seldon tell --done "PR #12 merged"', "send yourself a card"]] },
  { id: "voice", title: "The voice", tags: "demerzel voice speak talk mic",
    what: ["Demerzel: ask \"what needs me?\", \"read me tars\", \"tell tars yes\".", "She reads answers back before sending. Fully local."],
    examples: [["seldon up", "start her (first time: ~25 GB of models)"], ["seldon up --tailnet", "reach her from the phone"]] },
  { id: "plan", title: "The plan", tags: "plan queue foundation todo backlog",
    what: ["p in the panel shows a project's plan (docs/QUEUE.md).", "⏎ on an item starts an agent on it."],
    examples: [["p", "in the panel"], ["a", "add an item, in the plan"]] },
  { id: "projects", title: "Projects and rooms", tags: "go project adopt repo room hive forget delete remove",
    what: ["⏎ on a project shows its plan. g opens it: room + an agent (asks first).", "x forgets it (asks first): the folder and git stay untouched."],
    examples: [["seldon go stranded", "open it from a shell"], ["x", "on a project, then y: forget it"]] },
  { id: "setup", title: "Install, new laptop", tags: "install setup doctor laptop path",
    what: ["install sets up the stack; doctor checks tmux, ssh and friends.", "Not found in a new shell? Add pnpm's folder to PATH."],
    examples: [["seldon install", "pick what to install"], ["seldon doctor", "check what is missing"]] },
  { id: "trouble", title: "Something looks off", tags: "broken alt option small error fix help",
    what: ["⌥ keys do nothing: turn on Option as Meta, or use ⌃g then the key.", "Screen says too small: make the window bigger (30×10 at least)."],
    examples: [["seldon ws stop", "then seldon ws: a fresh start"], ["seldon help", "every command"]] },
];

// Topics matching the query, best first: every word has to appear somewhere; title hits rank
// above tag hits above text hits. An empty query lists everything in order.
export function searchDocs(query, topics = TOPICS) {
  const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return topics;
  const scored = [];
  for (const t of topics) {
    const title = t.title.toLowerCase(), tags = t.tags.toLowerCase();
    const body = [...t.what, ...t.examples.flat()].join(" ").toLowerCase();
    let score = 0, all = true;
    for (const w of words) {
      const s = title.includes(w) ? 3 : tags.includes(w) ? 2 : body.includes(w) ? 1 : 0;
      if (!s) { all = false; break; }
      score += s;
    }
    if (all) scored.push([score, t]);
  }
  return scored.sort((a, b) => b[0] - a[0]).map(([, t]) => t);
}
