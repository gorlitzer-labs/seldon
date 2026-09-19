.DEFAULT_GOAL := help
.PHONY: help build test typecheck release

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
	@echo "  $(C)make release$(R)     bump, tag, push $(D)V=patch|minor|major NOTES=$(R)"
	@echo ""
	@echo "  $(G)$(B)Install$(R)"
	@echo "    $(D)npm install -g @gorlitzer/apiary$(R)  $(D)(after auth: npm login --scope=@gorlitzer --registry=https://npm.pkg.github.com)$(R)"
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
