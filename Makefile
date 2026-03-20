.DEFAULT_GOAL := help
.PHONY: help setup update build room claude codex run-claude run-codex ps stop test typecheck release

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
	@echo "  $(C)make setup$(R)       install + build + link $(C)apiary$(R) globally"
	@echo "  $(C)make build$(R)       rebuild after code changes"
	@echo ""
	@echo "  $(C)make room$(R)        host a room    $(D)ROOM= NAME=$(R)"
	@echo "  $(C)make claude$(R)      launch agent   $(D)NAME= ADMIN=1$(R)"
	@echo "  $(C)make codex$(R)       launch codex   $(D)NAME= ADMIN=1$(R)"
	@echo "  $(C)make ps$(R)          list sessions"
	@echo "  $(C)make stop$(R)        stop agents    $(D)NAME= or ALL=1$(R)"
	@echo ""
	@echo "  $(G)$(B)Quick start$(R)"
	@echo "    $(D)T1$(R)  $(C)make room$(R) $(Y)NAME=BeeKeeper$(R)"
	@echo "    $(D)T2$(R)  $(C)make claude$(R) $(Y)NAME=Expendable3 ADMIN=1$(R)"
	@echo "    $(D)T3$(R)  $(C)make claude$(R) $(Y)NAME=Unpaid-Intern$(R)"
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
	@echo "  $(G)Done!$(R) Run $(C)apiary room $(Y)lobby$(R) to start."
	@echo ""

update: ## pull latest + rebuild
	apiary update

# ── Run ──────────────────────────────────────────────────────────────────────

build: ## build TypeScript
	npm run build

room: ## start a room + join the TUI
	apiary room $(or $(ROOM),lobby) $(if $(NAME),--name $(NAME)) $(ARGS)

claude: ## launch Claude Code agent
	apiary claude $(if $(NAME),--name $(NAME)) $(if $(ADMIN),--admin) $(ARGS)

codex: ## launch Codex agent
	apiary codex $(if $(NAME),--name $(NAME)) $(if $(ADMIN),--admin) $(ARGS)

# Legacy aliases
run-claude: claude
run-codex: codex

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
