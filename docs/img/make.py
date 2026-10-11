#!/usr/bin/env python3
"""The README illustrations. Edit a caption here, then: python3 docs/img/make.py

Plain SVG in the stack's palette (near-black, gold honeycomb) — no dependencies,
renders on GitHub in light and dark themes because every image carries its own
background.
"""
import math, os, html
OUT = os.path.dirname(os.path.abspath(__file__))
BG, BG2, GOLD, INK, DIM, LINE = "#0a0b10", "#15161e", "#e8ad3c", "#f3efe6", "#9a968c", "#2a2b35"
SANS = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"
MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
e = html.escape

def svg(w, h, body, title):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-label="{e(title)}">
<title>{e(title)}</title>
<defs>
  <radialGradient id="glow" cx="75%" cy="30%" r="70%"><stop offset="0" stop-color="#2b2210"/><stop offset="1" stop-color="{BG}"/></radialGradient>
  <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{GOLD}"/></marker>
</defs>
<rect width="{w}" height="{h}" rx="18" fill="url(#glow)"/>
{body}
</svg>
'''

def hexpts(cx, cy, r):
    return " ".join(f"{cx + r*math.cos(math.radians(60*i-90)):.1f},{cy + r*math.sin(math.radians(60*i-90)):.1f}" for i in range(6))

def text(x, y, s, size=16, fill=INK, weight=400, anchor="start", font=SANS, opacity=1):
    return f'<text xml:space="preserve" x="{x}" y="{y}" font-family="{font}" font-size="{size}" font-weight="{weight}" fill="{fill}" text-anchor="{anchor}" opacity="{opacity}">{e(s)}</text>'

# ---- 1. the stack as a honeycomb -------------------------------------------
def stack():
    W, H, r = 980, 560, 96
    mods = [
        ("apiary", "the conversation", "rooms where agents talk"),
        ("foundation", "the seam", "the plan agents follow"),
        ("comb", "the vault", "keys by name only"),
        ("factory", "the floor", "24/7 supervisor"),
        ("bifrost", "the bridge", "machines + your phone"),
        ("demerzel", "the voice", "talk to it, fully local"),
    ]
    dx = math.sqrt(3) * r + 10
    dy = 1.5 * r + 9
    x0, y0 = 270, 215
    cells = [(x0 + i*dx, y0) for i in range(3)] + [(x0 + dx/2 + i*dx, y0 + dy) for i in range(3)]
    b = [text(40, 58, "seldon", 34, INK, 800), text(40, 88, "six tools — take one, take all six", 17, DIM),
         f'<rect x="40" y="102" width="64" height="5" rx="2.5" fill="{GOLD}"/>']
    for (cx, cy), (name, role, line) in zip(cells, mods):
        b.append(f'<polygon points="{hexpts(cx, cy, r)}" fill="{BG2}" stroke="{GOLD}" stroke-width="2.5" stroke-linejoin="round"/>')
        b.append(text(cx, cy - 14, name, 23, GOLD, 700, "middle", MONO))
        b.append(text(cx, cy + 12, role, 15, INK, 600, "middle"))
        b.append(text(cx, cy + 34, line, 12.5, DIM, 400, "middle"))
    b.append(text(W - 40, H - 28, "you install them with one command: seldon", 14, DIM, 400, "end", MONO))
    return svg(W, H, "\n".join(b), "The Seldon stack: apiary, foundation, comb, factory, bifrost, demerzel")

# ---- 2. quickstart in three steps ------------------------------------------
def quickstart():
    W, H = 1000, 330
    steps = [
        ("1", "Install", ["npm i -g @gorlitzer-labs/seldon", "seldon"], "press  a  then  Enter"),
        ("2", "Start", ["seldon up"], "it prints where everything is"),
        ("3", "Put agents to work", ['factory new "a weather CLI"', "— or, in your repo —", "seldon adopt"], "you get woken only when it matters"),
    ]
    cw, ch, gap, top = 290, 210, 40, 70
    b = [text(25, 46, "Quickstart — three steps", 24, INK, 800)]
    for i, (n, title, cmds, note) in enumerate(steps):
        x = 25 + i*(cw + gap)
        b.append(f'<rect x="{x}" y="{top}" width="{cw}" height="{ch}" rx="14" fill="{BG2}" stroke="{LINE}" stroke-width="1.5"/>')
        b.append(f'<polygon points="{hexpts(x+42, top+42, 24)}" fill="{GOLD}"/>')
        b.append(text(x+42, top+50, n, 22, BG, 800, "middle"))
        b.append(text(x+78, top+50, title, 20, INK, 700))
        for j, c in enumerate(cmds):
            is_cmd = not c.startswith("—")
            b.append(text(x+18, top+100 + j*28, ("$ " if is_cmd else "") + c, 13.5 if is_cmd else 13, GOLD if is_cmd else DIM, 600 if is_cmd else 400, font=MONO if is_cmd else SANS))
        b.append(text(x+20, top+ch-20, note, 13, DIM))
        if i < 2:
            ax = x + cw + 5
            b.append(f'<line x1="{ax}" y1="{top+ch/2}" x2="{ax+gap-10}" y2="{top+ch/2}" stroke="{GOLD}" stroke-width="2.5" marker-end="url(#arr)"/>')
    b.append(text(25, H-18, "stop: seldon down  ·  check: seldon status  ·  remove: seldon uninstall --all", 13.5, DIM, 400, font=MONO))
    return svg(W, H, "\n".join(b), "Quickstart: install seldon, run seldon up, then factory new or seldon adopt")

# ---- 3. two ways into a room -----------------------------------------------
def twoways():
    W, H = 980, 420
    cx, cy = 490, 215
    b = [text(40, 46, "Two ways to put an agent in a room", 24, INK, 800),
         text(40, 74, "both talk in the same room — they differ in who wakes the agent up", 15, DIM)]
    # the room (hive) in the middle
    b.append(f'<polygon points="{hexpts(cx, cy, 92)}" fill="{BG2}" stroke="{GOLD}" stroke-width="3"/>')
    b.append(text(cx, cy - 10, "room", 24, GOLD, 800, "middle", MONO))
    b.append(text(cx, cy + 16, "apiary serve", 14, INK, 500, "middle", MONO))
    b.append(text(cx, cy + 38, "keep one running", 12.5, DIM, 400, "middle"))
    def card(x, title, sub, lines, arrow_label, left):
        w, h, y = 290, 230, 105
        b.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="14" fill="{BG2}" stroke="{LINE}" stroke-width="1.5"/>')
        b.append(text(x+20, y+36, title, 19, INK, 700))
        b.append(text(x+20, y+60, sub, 14, GOLD, 600, font=MONO))
        for j, l in enumerate(lines):
            b.append(text(x+20, y+96 + j*26, l, 14, INK if not l.startswith("·") else DIM))
        ay = cy
        if left:
            b.append(f'<line x1="{x+w+8}" y1="{ay-14}" x2="{cx-98}" y2="{ay-14}" stroke="{GOLD}" stroke-width="2.5" marker-end="url(#arr)"/>')
            b.append(f'<line x1="{cx-98}" y1="{ay+14}" x2="{x+w+8}" y2="{ay+14}" stroke="{DIM}" stroke-width="2" stroke-dasharray="6 5" marker-end="url(#arr)"/>')
            b.append(text((x+w+cx-98)/2, ay-24, "posts", 12.5, GOLD, 600, "middle"))
            b.append(text((x+w+cx-98)/2, ay+36, arrow_label, 12.5, DIM, 400, "middle"))
        else:
            b.append(f'<line x1="{x-8}" y1="{ay-14}" x2="{cx+98}" y2="{ay-14}" stroke="{GOLD}" stroke-width="2.5" marker-end="url(#arr)"/>')
            b.append(f'<line x1="{cx+98}" y1="{ay+14}" x2="{x-8}" y2="{ay+14}" stroke="{GOLD}" stroke-width="2.5" marker-end="url(#arr)"/>')
            b.append(text((x-8+cx+98)/2, ay-24, "posts", 12.5, GOLD, 600, "middle"))
            b.append(text((x-8+cx+98)/2, ay+36, arrow_label, 12.5, GOLD, 600, "middle"))
    card(40, "MCP client", "apiary mcp", ["Claude Code, Cursor, Windsurf…", "add it in seconds, on the fly", "· reads when it calls catch_up", "· sleeps when you stop typing"], "pulls (catch_up)", True)
    card(650, "tmux wrapper", "apiary claude <name>", ["launched and watched for you", "factory can staff it", "· messages pushed in, even idle", "· runs with nobody at the keys"], "pushed in", False)
    b.append(text(40, H-22, "driving it yourself → MCP client   ·   must run unattended → wrapper", 14, DIM, 400, font=MONO))
    return svg(W, H, "\n".join(b), "Two ways into an apiary room: MCP client pulls, tmux wrapper gets messages pushed")

os.makedirs(OUT, exist_ok=True)
for name, fn in [("stack", stack), ("quickstart", quickstart), ("two-ways", twoways)]:
    open(os.path.join(OUT, name + ".svg"), "w").write(fn())
print("ok")
