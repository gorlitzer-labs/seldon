"""Skill: speak MCP, so any MCP server becomes a capability.

This is the answer to "she should have some way of doing everything". Rather
than hardcoding the next fifty tools, she speaks the protocol the ecosystem
already uses -- and the servers Franko runs are local processes: `playwright`,
`agent-coord`, and apiary's own `apiary mcp`.

NOTHING IS ENABLED BY DEFAULT. He chose to stay fully local, and some servers
can obviously reach the network (a browser being the clearest case), so every
server must be turned on by hand in ~/.demerzel/mcp.json and declares whether it
is local. A server left at the default does not run, is not discovered, and
costs nothing.

  {
    "servers": {
      "apiary":     {"command": "apiary", "args": ["mcp", "Demerzel"],
                     "enabled": false, "local": true},
      "playwright": {"command": "npx", "args": ["-y", "@playwright/mcp@latest"],
                     "enabled": false, "local": false}
    }
  }

The protocol is async and Demerzel's tools are called synchronously on the single
GPU worker thread, so one dedicated event-loop thread owns every session for the
life of the process and calls are bridged onto it.
"""
from __future__ import annotations

import asyncio
import json
import os
import pathlib
import threading
from dataclasses import dataclass, field

from ..tools import Tool, register

CONFIG = pathlib.Path(os.environ.get(
    "DEMERZEL_MCP_CONFIG", pathlib.Path.home() / ".demerzel" / "mcp.json"))
CALL_TIMEOUT_S = 60.0
CONNECT_TIMEOUT_S = 25.0
MAX_RESULT_CHARS = 3000


@dataclass
class Server:
    name: str
    command: str
    args: list[str] = field(default_factory=list)
    env: dict | None = None
    cwd: str | None = None
    local: bool = True
    enabled: bool = False


def read_config() -> list[Server]:
    try:
        raw = json.loads(CONFIG.read_text())
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return []
    out = []
    for name, d in (raw.get("servers") or {}).items():
        if not isinstance(d, dict) or not d.get("command"):
            continue
        out.append(Server(name=name, command=d["command"],
                          args=list(d.get("args") or []),
                          env=d.get("env"), cwd=d.get("cwd"),
                          local=bool(d.get("local", True)),
                          enabled=bool(d.get("enabled", False))))
    return out


class Bridge:
    """One event-loop thread owning every MCP session."""

    def __init__(self) -> None:
        self.loop: asyncio.AbstractEventLoop | None = None
        self.sessions: dict[str, object] = {}
        self.tools: dict[str, tuple[str, dict]] = {}   # qualified -> (server, schema)
        self._ready = threading.Event()
        self._stop: asyncio.Event | None = None

    # --- lifecycle ---------------------------------------------------------
    def start(self, servers: list[Server]) -> list[str]:
        """Connect the enabled servers. Returns the names that came up."""
        live = [s for s in servers if s.enabled]
        if not live:
            return []
        t = threading.Thread(target=self._run, args=(live,), daemon=True,
                             name="demerzel-mcp")
        t.start()
        self._ready.wait(CONNECT_TIMEOUT_S)
        return sorted(self.sessions)

    def _run(self, servers: list[Server]) -> None:
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        self._stop = asyncio.Event()
        try:
            self.loop.run_until_complete(self._serve(servers))
        except Exception as e:
            print(f"mcp: bridge stopped ({type(e).__name__}: {e})", flush=True)
        finally:
            self._ready.set()

    async def _serve(self, servers: list[Server]) -> None:
        # Each session is held open by its own task for the process lifetime; a
        # server that fails to start must not prevent the others.
        await asyncio.gather(*(self._hold(s) for s in servers),
                             return_exceptions=True)

    async def _hold(self, s: Server) -> None:
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
        try:
            params = StdioServerParameters(
                command=s.command, args=s.args,
                env={**os.environ, **(s.env or {})} if s.env else None, cwd=s.cwd)
            async with stdio_client(params) as (r, w):
                async with ClientSession(r, w) as session:
                    await asyncio.wait_for(session.initialize(), CONNECT_TIMEOUT_S)
                    listed = await asyncio.wait_for(session.list_tools(), CONNECT_TIMEOUT_S)
                    self.sessions[s.name] = session
                    for t in listed.tools:
                        self.tools[f"{s.name}_{t.name}"] = (
                            s.name, {"name": t.name,
                                     "description": t.description or "",
                                     "schema": getattr(t, "inputSchema", {}) or {},
                                     "local": s.local})
                    print(f"mcp: {s.name} up, {len(listed.tools)} tools "
                          f"({'local' if s.local else 'CAN REACH THE NETWORK'})",
                          flush=True)
                    self._ready.set()
                    await self._stop.wait()
        except Exception as e:
            print(f"mcp: {s.name} failed ({type(e).__name__}: {e})", flush=True)
            self._ready.set()

    # --- calling -----------------------------------------------------------
    def call(self, qualified: str, args: dict) -> str:
        entry = self.tools.get(qualified)
        if entry is None or self.loop is None:
            return f"{qualified} is not available."
        server, meta = entry
        session = self.sessions.get(server)
        if session is None:
            return f"The {server} server is not connected."
        fut = asyncio.run_coroutine_threadsafe(
            session.call_tool(meta["name"], args or {}), self.loop)
        try:
            res = fut.result(timeout=CALL_TIMEOUT_S)
        except TimeoutError:
            return "That took too long and I gave up on it."
        except Exception as e:
            return f"That failed: {type(e).__name__}."
        return _flatten(res)


def _flatten(res) -> str:
    """MCP results are structured; speech is not. Take the text and cap it."""
    parts = []
    for c in getattr(res, "content", None) or []:
        text = getattr(c, "text", None)
        if text:
            parts.append(text)
        elif getattr(c, "type", "") not in ("", "text"):
            parts.append(f"[{c.type}]")
    out = "\n".join(parts).strip() or "Done."
    return out[:MAX_RESULT_CHARS] + ("..." if len(out) > MAX_RESULT_CHARS else "")


BRIDGE = Bridge()


def load() -> list[str]:
    """Connect enabled servers and register their tools. Safe to call once."""
    servers = read_config()
    if not servers:
        return []
    up = BRIDGE.start(servers)
    for qualified, (server, meta) in sorted(BRIDGE.tools.items()):
        props = (meta["schema"] or {}).get("properties") or {}
        required = (meta["schema"] or {}).get("required") or []
        # Everything an MCP server exposes is treated as a WRITE: Demerzel cannot
        # know whether a remote tool mutates anything, and guessing in the
        # permissive direction would let a guest act through it.
        register(Tool(
            qualified,
            f"[{server}] {meta['description']}"[:400],
            props, list(required),
            (lambda q: lambda **kw: BRIDGE.call(q, kw))(qualified),
            (lambda sv: lambda **_: f"Asking {sv}.")(server),
            writes=True, local=meta["local"]))
    return up


def write_example_config() -> pathlib.Path:
    """Create a disabled-by-default config so enabling something is one edit."""
    if CONFIG.exists():
        return CONFIG
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    CONFIG.write_text(json.dumps({
        "_comment": "Nothing runs until enabled is true. 'local' false means "
                    "that server can reach the network.",
        "servers": {
            "apiary": {"command": "apiary", "args": ["mcp", "Demerzel"],
                       "enabled": False, "local": True},
            "playwright": {"command": "npx", "args": ["-y", "@playwright/mcp@latest"],
                           "enabled": False, "local": False},
        }}, indent=2))
    return CONFIG
