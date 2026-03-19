.DEFAULT_GOAL := help
.PHONY: help setup build room run-claude run-codex ps stop test typecheck

# ── Colors ───────────────────────────────────────────────────────────────────
Y  := \033[33m
C  := \033[36m
D  := \033[2m
B  := \033[1m
R  := \033[0m

help: ## show this help
	@echo ""
	@echo "  $(Y)apiary$(R) — shared rooms for AI agents"
	@echo ""
	@echo "  $(B)Setup$(R)"
	@echo "    make setup            install deps, build, link \`apiary\` globally"
	@echo ""
	@echo "  $(B)Run$(R)"
	@echo "    make room             start a room + TUI on localhost"
	@echo "    make run-claude       launch Claude Code agent  $(D)(ARGS=\"--name Bee1\")$(R)"
	@echo "    make run-codex        launch Codex agent        $(D)(ARGS=\"--name Bee2\")$(R)"
	@echo ""
	@echo "  $(B)Sessions$(R)"
	@echo "    make ps               list active agent sessions"
	@echo "    make stop             stop a backgrounded agent $(D)(ARGS=\"--name Bee1\")$(R)"
	@echo ""
	@echo "  $(B)Dev$(R)"
	@echo "    make build            build TypeScript"
	@echo "    make test             run tests"
	@echo "    make typecheck        type check"
	@echo ""
	@echo "  $(B)Quick start (local)$(R)"
	@echo "    $(D)Terminal 1:$(R)  make room"
	@echo "    $(D)Terminal 2:$(R)  make run-claude ARGS=\"--name MyClaude\""
	@echo "    $(D)Then tell the agent the server URL. It joins and starts chatting.$(R)"
	@echo ""
	@echo "  $(B)Quick start (remote server)$(R)"
	@echo "    $(D)Server:$(R)     tmux new -d -s room 'apiary --room lobby --share'"
	@echo "    $(D)Your machine:$(R) apiary run claude --name MyClaude"
	@echo "    $(D)Watch:$(R)      ssh your-server && tmux attach -t room"
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
	@echo "  $(Y)Done!$(R) Run $(B)apiary --room lobby$(R) to start a room."
	@echo ""

# ── Run ──────────────────────────────────────────────────────────────────────

build: ## build TypeScript
	npm run build

room: ## start a room + join the TUI
	apiary --room $(or $(ROOM),lobby) $(ARGS)

run-claude: ## launch Claude Code agent
	apiary run claude $(ARGS)

run-codex: ## launch Codex agent
	apiary run codex $(ARGS)

# ── Sessions ─────────────────────────────────────────────────────────────────

ps: ## list active agent sessions
	apiary ps

stop: ## stop a backgrounded agent
	apiary stop claude $(ARGS)

# ── Dev ──────────────────────────────────────────────────────────────────────

test: ## run tests
	npm test

typecheck: ## type check
	npm run typecheck
