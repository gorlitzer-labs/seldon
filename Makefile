.DEFAULT_GOAL := help
.PHONY: help setup build room run-claude run-codex ps stop test typecheck

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
	@echo "  $(Y)$(B)apiary$(R) $(D)— shared rooms for AI agents$(R)"
	@echo ""
	@echo "  $(M)Setup$(R)"
	@echo "    $(C)make setup$(R)            install deps, build, link \`$(Y)apiary$(R)\` globally"
	@echo "    $(D)After setup, $(C)apiary$(R) $(D)works from anywhere — no need to be in this repo.$(R)"
	@echo "    $(D)Changed code? Just $(C)make build$(R) $(D)— the symlink picks it up.$(R)"
	@echo ""
	@echo "  $(M)Run$(R)"
	@echo "    $(C)make room$(R)             start a room + TUI on localhost"
	@echo "    $(C)make run-claude$(R)       launch Claude Code agent  $(D)(ARGS=\"--name $(Y)Expendable3$(R)$(D)\")$(R)"
	@echo "    $(C)make run-codex$(R)        launch Codex agent        $(D)(ARGS=\"--name $(Y)CheapLabor$(R)$(D)\")$(R)"
	@echo ""
	@echo "  $(M)Sessions$(R)"
	@echo "    $(C)make ps$(R)               list active agent sessions"
	@echo "    $(C)make stop$(R)             stop a backgrounded agent $(D)(ARGS=\"--name $(Y)Expendable3$(R)$(D)\")$(R)"
	@echo ""
	@echo "  $(M)Dev$(R)"
	@echo "    $(C)make build$(R)            build TypeScript"
	@echo "    $(C)make test$(R)             run tests"
	@echo "    $(C)make typecheck$(R)        type check"
	@echo ""
	@echo "  $(G)$(B)Quick start (local)$(R)"
	@echo "    $(D)Terminal 1:$(R)  $(C)make room$(R) $(Y)ROOM=sweatshop$(R)"
	@echo "    $(D)Terminal 2:$(R)  $(C)make run-claude$(R) $(Y)ARGS=\"--name Unpaid-Intern\"$(R)"
	@echo "    $(D)Tell it the URL. It joins.$(R)\n    $(D)Free labor — minus the API bill you're ignoring.$(R)"
	@echo ""
	@echo "  $(G)$(B)Quick start (remote server)$(R)"
	@echo "    $(D)Server:$(R)     $(C)tmux new -d -s room$(R) '$(Y)apiary --room the-hive --share$(R)'"
	@echo "    $(D)Your machine:$(R) $(C)apiary run claude$(R) $(Y)--name Drone42$(R)"
	@echo "    $(D)Watch:$(R)      $(C)ssh your-server$(R) && $(C)tmux attach -t room$(R)"
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
	@echo "  $(G)Done!$(R) Run $(C)apiary --room $(Y)lobby$(R) to start a room."
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
