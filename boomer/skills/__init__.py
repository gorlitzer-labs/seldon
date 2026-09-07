"""Every capability Boomer has. Importing a module registers its tools.

Add a skill by adding a module here. Nothing else in the codebase needs to know
it exists -- which is the point.
"""
from . import factory, files, system, timers   # noqa: F401  (imported to register)
from . import mcp as mcp_skill

SKILLS = ["factory", "files", "system", "timers"]

# MCP servers are opt-in and disabled by default, so this usually registers
# nothing and costs nothing. See boomer/skills/mcp.py.
_MCP_UP = mcp_skill.load()
if _MCP_UP:
    SKILLS.extend(f"mcp:{n}" for n in _MCP_UP)
