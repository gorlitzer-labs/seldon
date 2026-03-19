.DEFAULT_GOAL := help
.PHONY: help setup update build room run-claude run-codex ps stop test typecheck release

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
	@echo "    $(C)make update$(R)           $(D)→ apiary update$(R)            $(D)(git pull + rebuild)$(R)"
	@echo "    $(D)After setup, $(C)apiary$(R) $(D)works from anywhere — no need to be in this repo.$(R)"
	@echo "    $(D)Changed code? Just $(C)make build$(R) $(D)— the symlink picks it up.$(R)"
	@echo ""
	@echo "  $(M)Run$(R)"
	@echo "    $(C)make room$(R)             $(D)→ apiary --room sweatshop$(R)   $(D)(ROOM= NAME=$(Y)BeeKeeper$(R)$(D))$(R)"
	@echo "    $(C)make run-claude$(R)       $(D)→ apiary run claude$(R)      $(D)(NAME=$(Y)Expendable3$(R)$(D) ADMIN=1)$(R)"
	@echo "    $(C)make run-codex$(R)        $(D)→ apiary run codex$(R)       $(D)(NAME=$(Y)CheapLabor$(R)$(D) ADMIN=1)$(R)"
	@echo ""
	@echo "  $(M)Sessions$(R)"
	@echo "    $(C)make ps$(R)               $(D)→ apiary ps$(R)"
	@echo "    $(C)make stop$(R)             $(D)→ apiary stop$(R)             $(D)(NAME=$(Y)Expendable3$(R)$(D) or ALL=1)$(R)"
	@echo ""
	@echo "  $(M)Dev$(R)"
	@echo "    $(C)make build$(R)            build TypeScript"
	@echo "    $(C)make test$(R)             run tests"
	@echo "    $(C)make typecheck$(R)        type check"
	@echo "    $(C)make release$(R)          bump version, tag, push  $(D)(V=patch|minor|major, default: patch)$(R)"
	@echo ""
	@echo "  $(G)$(B)Quick start (local)$(R)"
	@echo "    $(D)Terminal 1:$(R)  $(C)make room$(R) $(Y)ROOM=sweatshop NAME=BeeKeeper$(R)"
	@echo "    $(D)Terminal 2:$(R)  $(C)make run-claude$(R) $(Y)NAME=Expendable3 ADMIN=1$(R)"
	@echo "    $(D)Terminal 3:$(R)  $(C)make run-claude$(R) $(Y)NAME=Unpaid-Intern$(R)"
	@echo "    $(D)Tell them the URL. They join.$(R)\n    $(D)ADMIN=1 → can kick, mute, and manage other participants.$(R)"
	@echo ""
	@echo "  $(G)$(B)Quick start (remote server)$(R)"
	@echo "    $(D)Server:$(R)     $(C)tmux new -d -s room$(R) '$(Y)apiary --room the-hive --name BeeKeeper --share$(R)'"
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

update: ## pull latest + rebuild
	apiary update

# ── Run ──────────────────────────────────────────────────────────────────────

build: ## build TypeScript
	npm run build

room: ## start a room + join the TUI
	apiary --room $(or $(ROOM),lobby) $(if $(NAME),--name $(NAME)) $(ARGS)

run-claude: ## launch Claude Code agent
	apiary run claude $(if $(NAME),--name $(NAME)) $(if $(ADMIN),--admin) $(ARGS)

run-codex: ## launch Codex agent
	apiary run codex $(if $(NAME),--name $(NAME)) $(if $(ADMIN),--admin) $(ARGS)

# ── Sessions ─────────────────────────────────────────────────────────────────

ps: ## list active agent sessions
	apiary ps

stop: ## stop a backgrounded agent
	apiary stop $(if $(NAME),--name $(NAME)) $(if $(ALL),--all) $(ARGS)

# ── Dev ──────────────────────────────────────────────────────────────────────

test: ## run tests
	npm test

typecheck: ## type check
	npm run typecheck

V ?= patch
release: ## bump version, tag, and push (V=patch|minor|major)
	@echo "$(C)  Running tests...$(R)"
	@npm test
	@echo "$(C)  Bumping $(Y)$(V)$(R)$(C) version...$(R)"
	@npm version $(V) --no-git-tag-version
	@NEW_V=$$(node -p "require('./package.json').version"); \
	 npm run build; \
	 git add -A; \
	 git commit -m "v$$NEW_V"; \
	 git tag "v$$NEW_V"; \
	 echo "$(C)  Pushing...$(R)"; \
	 git push && git push --tags; \
	 echo ""; \
	 echo "  $(G)$(B)Released v$$NEW_V$(R)"; \
	 echo ""
