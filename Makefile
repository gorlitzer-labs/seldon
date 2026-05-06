.DEFAULT_GOAL := help
.PHONY: help setup update build room mcp claude codex run-claude run-codex ps stop test typecheck release

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
	@echo "  $(C)make setup$(R)       install + build + link $(C)apiary$(R) globally"
	@echo "  $(C)make build$(R)       rebuild after code changes"
	@echo ""
	@echo "  $(C)make room$(R)        host a room    $(D)ROOM= NAME=$(R)"
	@echo "  $(C)make mcp$(R)         standalone MCP $(D)NAME= ADMIN=1$(R)"
	@echo "  $(C)make claude$(R)      launch agent   $(D)NAME= ADMIN=1 ARGS=$(R)"
	@echo "  $(C)make codex$(R)       launch codex   $(D)NAME= ADMIN=1 ARGS=$(R)"
	@echo "  $(C)make ps$(R)          list rooms + agents $(D)(with join links)$(R)"
	@echo "  $(C)make stop$(R)        stop agents    $(D)NAME= or ALL=1$(R)"
	@echo "  $(C)make release$(R)     bump, tag, push $(D)V=patch|minor|major NOTES=$(R)"
	@echo ""
	@echo "  $(G)$(B)Quick start$(R)  $(D)(MCP — recommended)$(R)"
	@echo "    $(D)1.$(R) Add to MCP config $(D)(~/.claude/mcp.json or .mcp.json):$(R)"
	@echo "       $(D){ \"mcpServers\": { \"apiary\": {$(R)"
	@echo "           $(D)\"type\": \"stdio\", \"command\": \"npx\",$(R)"
	@echo "           $(D)\"args\": [\"apiary\", \"mcp\", \"$(Y)YourName$(R)$(D)\", \"--admin\"] } } }$(R)"
	@echo "    $(D)2.$(R) $(C)make room$(R) $(Y)ROOM=brood-box$(R)"
	@echo "    $(D)3.$(R) Paste the URL to any agent."
	@echo ""
	@echo "  $(D)tmux wrapper:$(R)  $(C)make claude$(R) $(Y)NAME=Expendable3 ADMIN=1$(R)  $(D)(alternative)$(R)"
	@echo ""
	@echo "  $(D)Dev shortcuts. Users run: $(C)apiary --help$(R)"
	@echo ""

# ── Setup ────────────────────────────────────────────────────────────────────

setup: ## install deps, build, and link the `apiary` command globally
	@echo "$(C)Installing dependencies...$(R)"
	@npm install
	@echo "$(C)Building...$(R)"
	@npm run build
	@echo "$(C)Linking apiary command...$(R)"
	@npm link
	@echo ""
	@echo "  $(G)$(B)Ready!$(R) $(C)apiary$(R) works from anywhere now."
	@echo ""
	@echo "  $(G)$(B)Quick start$(R)"
	@echo "    $(D)1.$(R) Add to MCP config $(D)(~/.claude/mcp.json):$(R)"
	@echo "       $(D){ \"mcpServers\": { \"apiary\": {$(R)"
	@echo "           $(D)\"type\": \"stdio\", \"command\": \"apiary\",$(R)"
	@echo "           $(D)\"args\": [\"mcp\", \"$(Y)YourName$(R)$(D)\", \"--admin\"] } } }$(R)"
	@echo "    $(D)2.$(R) $(C)apiary room $(Y)brood-box$(R)           $(D)start a room$(R)"
	@echo "    $(D)3.$(R) Paste the URL to any agent."
	@echo ""
	@echo "  $(D)Run $(C)apiary --help$(R) $(D)for all commands.$(R)"
	@echo ""

update: ## pull latest + rebuild
	apiary update

# ── Run ──────────────────────────────────────────────────────────────────────

build: ## build TypeScript
	npm run build

room: ## start a room + join the TUI
	apiary room $(or $(ROOM),brood-box) $(if $(NAME),--name $(NAME)) $(ARGS)

mcp: ## start standalone MCP server (any client, no tmux)
	apiary mcp $(if $(NAME),--name $(NAME)) $(if $(ADMIN),--admin) $(ARGS)

claude: ## launch Claude Code agent (tmux wrapper)
	apiary claude $(if $(NAME),--name $(NAME)) $(if $(ADMIN),--admin) $(ARGS)

codex: ## launch Codex agent
	apiary codex $(if $(NAME),--name $(NAME)) $(if $(ADMIN),--admin) $(ARGS)

# Legacy aliases
run-claude: claude
run-codex: codex

# ── Sessions ─────────────────────────────────────────────────────────────────

ps: ## list active rooms + agents
	apiary ps

stop: ## stop a backgrounded agent
	apiary stop $(if $(NAME),--name $(NAME)) $(if $(ALL),--all) $(ARGS)

# ── Dev ──────────────────────────────────────────────────────────────────────

test: ## run tests
	npm test

typecheck: ## type check
	npm run typecheck

V ?= patch
release: ## bump version, tag, and push (V=patch|minor|major NOTES="...")
	@echo "$(C)  Running tests...$(R)"
	@npm test
	@echo "$(C)  Bumping $(Y)$(V)$(R)$(C) version...$(R)"
	@npm version $(V) --no-git-tag-version
	@NEW_V=$$(node -p "require('./package.json').version") && \
	 npm run build && \
	 git add -A && \
	 if [ -n "$(NOTES)" ]; then \
	   git commit -m "v$$NEW_V" -m "$(NOTES)"; \
	   git tag -a "v$$NEW_V" -m "$(NOTES)"; \
	 else \
	   git commit -m "v$$NEW_V"; \
	   git tag "v$$NEW_V"; \
	 fi; \
	 echo "$(C)  Pushing...$(R)"; \
	 git push && git push --tags; \
	 echo ""; \
	 echo "  $(G)$(B)Released v$$NEW_V$(R)"; \
	 echo ""
