"""Every capability Boomer has. Importing a module registers its tools.

Add a skill by adding a module here. Nothing else in the codebase needs to know
it exists -- which is the point, and how an MCP client will arrive later.
"""
from . import factory, files, system, timers   # noqa: F401  (imported to register)

SKILLS = ["factory", "files", "system", "timers"]
