import type { Chapter } from "./types";

/** The reel is this array. Chapter = a lecture; beats = its subchapters.
 *  `say` lines are the narration script (voiced via ElevenLabs); their cues
 *  already drive the scene, so voice slots into motion authored once. */
export const chapters: Chapter[] = [
  {
    id: "intro", marker: "00", title: "The Hive", short: "Intro",
    beats: [{
      id: "whole", kicker: "A software factory of AI agents", heading: "Six tools, one hive.",
      body: ["Seldon runs a plan the way Hari Seldon ran his — continuously, escalating only the pivotal calls.",
             "Six tools make the comb. None of them is the point alone. This course takes them apart, one at a time, building one small thing — a weather CLI — with each."],
      focus: null, view: "hive",
      say: [{ text: "Six tools. One hive. None of them is the point on its own." },
            { text: "We'll take them apart one at a time — and build one small thing, a weather CLI, with each." }],
    }],
  },
  {
    id: "apiary", marker: "01", title: "apiary — the conversation", short: "apiary", module: "apiary",
    beats: [
      { id: "hex", kicker: "the conversation", heading: "Where the agents talk.",
        body: ["Shared rooms for AI agents — mentions, whispers, history, a human in the room. The hive where a build actually happens."],
        focus: "apiary", view: "hive", say: [{ text: "This one is the conversation — shared rooms where agents coordinate.", look: "apiary" }] },
      { id: "room", kicker: "apiary · weather-cli", heading: "A room, filling with work.",
        body: ["Here, two agents split the weather CLI into a fetch lane and a format lane — and agreed the boundary between them, live. This is a real captured session."],
        focus: "apiary", view: "surface", say: [{ text: "Open a room, and it fills. Two agents claim lanes, agree a boundary, and report done — no one orchestrating them by hand.", view: "surface" }] },
    ],
  },
  {
    id: "foundation", marker: "02", title: "foundation — the seam", short: "foundation", module: "foundation",
    beats: [
      { id: "hex", kicker: "the seam", heading: "The plan, underneath.",
        body: ["QUEUE → WORKSTREAMS → DONE → FACTS, one writer per file, every fact tool-stamped. Named for Asimov; the seed of the world."],
        focus: "foundation", view: "hive", say: [{ text: "Beneath the agents is the seam — a deterministic plan they all follow.", look: "foundation" }] },
      { id: "run", kicker: "foundation — one command", heading: "A plan, in one command.",
        body: ["init scaffolds the repo and the seam; queue seeds the work; done cites a real PR. The record is plain files, one writer each — lock-free."],
        focus: "foundation", view: "surface", say: [{ text: "One command lays down the whole plan — a queue, a record, and skills the agents share.", view: "surface" }] },
    ],
  },
  {
    id: "comb", marker: "03", title: "comb — the vault", short: "comb", module: "comb",
    beats: [
      { id: "hex", kicker: "the vault", heading: "Keys by name, never by value.",
        body: ["SOPS + age, no server. A leak audit no vault does — and credentials that follow an agent to another machine, safely."],
        focus: "comb", view: "hive", say: [{ text: "The weather CLI needs an API key. The vault holds it — by name, never by value.", look: "comb" }] },
      { id: "run", kicker: "comb — a real run", heading: "The key the CLI never sees.",
        body: ["The weather key goes in once. The tool reads it from its environment at run time — never on a command line, never in shell history, never in a log."],
        focus: "comb", view: "surface", say: [{ text: "Store the key once. The CLI reads it from its environment at run time — it never touches a command line or a log.", view: "surface" }] },
    ],
  },
  {
    id: "factory", marker: "04", title: "factory — the floor", short: "factory", module: "factory",
    beats: [
      { id: "hex", kicker: "the floor", heading: "The 24/7 supervisor.",
        body: ["new · watch · board · box · realms. It heals dead agents, gates work in a container, and escalates the hard calls to you."],
        focus: "factory", view: "hive", say: [{ text: "The floor is the supervisor — it keeps the hive alive and running around the clock.", look: "factory" }] },
      { id: "run", kicker: "factory — reach + boundary", heading: "Runs it, everywhere, safely.",
        body: ["factory sees the machines it can reach — through bifrost — and runs each agent boxed: permissions skipped inside a container, the host sealed out."],
        focus: "factory", view: "surface", say: [{ text: "It reaches every machine, and runs each agent in a box — free inside, walled off from your keys and your disk.", view: "surface" }] },
    ],
  },
  {
    id: "bifrost", marker: "05", title: "bifrost — the bridge", short: "bifrost", module: "bifrost",
    beats: [
      { id: "hex", kicker: "the bridge", heading: "Many machines, one workspace.",
        body: ["tmux + Tailscale as one desk. Sessions survive the closed lid, reachable from a phone, each agent flagged by what it's doing."],
        focus: "bifrost", view: "hive", say: [{ text: "The bridge makes every machine one workspace — and lets you watch it from your phone.", look: "bifrost" }] },
      { id: "run", kicker: "bifrost — the realms", heading: "Your desk, your realm, your phone.",
        body: ["One workspace across a desk, a realm, and whatever you're holding — sessions that survive the lid closing, each agent flagged idle, working, or needs-you."],
        focus: "bifrost", view: "surface", say: [{ text: "One desk, one realm, one phone — and each agent flagged by what it's doing, so you see who needs you.", view: "surface" }] },
    ],
  },
  {
    id: "demerzel", marker: "06", title: "Demerzel — the voice", short: "Demerzel", module: "demerzel",
    beats: [
      { id: "hex", kicker: "the voice", heading: "The one you talk to.",
        body: ["A fully-local voice — a 35B brain on-device, ~2s to reply, nothing leaving the machine. Named for Seldon's First Minister: the way a human steers the factory."],
        focus: "demerzel", view: "hive", say: [{ text: "And the voice — how a human steers all of it, just by speaking.", look: "demerzel" }] },
      { id: "talk", kicker: "Demerzel — offline", heading: "Ask it. It answers.",
        body: ["No cloud, no API key, no telemetry — a 35B model on the machine, about two seconds from your last word to hers. You ask; it tells you what needs you."],
        focus: "demerzel", view: "surface", say: [{ text: "You ask if the weather CLI shipped. She checks, and tells you it's live and nothing needs you — all on-device.", view: "surface" }] },
    ],
  },
  {
    id: "combos", marker: "07", title: "Together — and apart", short: "Combos",
    beats: [
      { id: "together", kicker: "the whole hive", heading: "Together, it runs itself.",
        body: ["Foundation plans, apiary builds, comb holds the keys, factory supervises, bifrost spans the machines, Demerzel takes the call. One idea to shipped — the weather CLI, live."],
        focus: null, view: "combo",
        say: [{ text: "Put them together and one idea walks itself to shipped — the weather CLI, planned, built, verified, and live." }] },
      { id: "apart", kicker: "composable — it's about the job", heading: "Take one out, and it's a different tool.",
        body: ["Drop the voice and you drive by terminal. Drop the vault and remote agents go blind. Drop the floor and it stops being a factory at all. Every combo is powerful for a different job."],
        focus: null, view: "hive",
        say: [{ text: "Pull a piece, and it becomes something else — good for a different job. That's the point: match the combo to the work." }] },
    ],
  },
  {
    id: "credits", marker: "08", title: "Credits", short: "Credits",
    beats: [
      { id: "roll", kicker: "the seldon stack", heading: "Credits",
        body: ["Six tools, one hive."],
        focus: null, view: "surface",   // drives the scene only: dims the hive, drops labels, pulls back
        say: [{ text: "That's the Seldon stack — six tools, one hive, running a plan continuously. Thanks for watching." }] },
    ],
  },
];
