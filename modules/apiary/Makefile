.DEFAULT_GOAL := help
.PHONY: help build test typecheck

# ── Colors ───────────────────────────────────────────────────────────────────
Y  := \033[33m
C  := \033[36m
G  := \033[32m
M  := \033[35m
D  := \033[2m
B  := \033[1m
R  := \033[0m

help: ## show this help
	@echo ""
	@V=$$(node -p 'require("./package.json").version' 2>/dev/null || echo unknown); echo "  $(Y)$(B)apiary$(R) $(D)v$$V — shared rooms for AI agents$(R)"
	@echo ""
	@echo "  $(C)make build$(R)       rebuild after code changes"
	@echo "  $(C)make test$(R)        run tests"
	@echo "  $(C)make typecheck$(R)   type check"
	@echo ""
	@echo "  $(D)Releases are published from the seldon monorepo (public npm).$(R)"
	@echo ""
	@echo "  $(G)$(B)Install$(R)"
	@echo "    $(D)npm install -g @gorlitzer-labs/apiary$(R)  $(D)(public npm — no auth)$(R)"
	@echo ""
	@echo "  $(G)$(B)Quick start$(R)  $(D)(MCP — recommended)$(R)"
	@echo "    $(D)1.$(R) Add to MCP config $(D)(~/.claude/mcp.json or .mcp.json):$(R)"
	@echo "       $(D){ \"mcpServers\": { \"apiary\": {$(R)"
	@echo "           $(D)\"type\": \"stdio\", \"command\": \"npx\",$(R)"
	@echo "           $(D)\"args\": [\"apiary\", \"mcp\", \"$(Y)YourName$(R)$(D)\", \"--admin\"] } } }$(R)"
	@echo "    $(D)2.$(R) $(C)apiary room $(Y)brood-box$(R)           $(D)start a room$(R)"
	@echo "    $(D)3.$(R) Paste the URL to any agent."
	@echo ""
	@echo "  $(D)Run $(C)apiary --help$(R) $(D)for all commands.$(R)"
	@echo ""

# ── Dev ──────────────────────────────────────────────────────────────────────

build: ## build TypeScript
	npm run build

test: ## run tests
	npm test

typecheck: ## type check
	npm run typecheck
