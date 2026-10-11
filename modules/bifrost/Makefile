# Bifrost — convenience wrappers so the common flow is one word each.
# The real tool is the `bifrost` shell script; `make` just shortens the path.
# Run `make` (or `make help`) to see everything.

# Drive the installed bifrost if it's on PATH, else the copy in this repo.
BIFROST := $(shell command -v bifrost 2>/dev/null || echo ./bifrost)

.DEFAULT_GOAL := help
.PHONY: help install setup scan add summon doctor sessions status kill sync lint ci release uninstall

help: ## Show this help
	@echo ""
	@echo "  Bifrost — make targets"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "  First time?  make install → make setup → make scan → make add NAME=asgard → make summon"
	@echo ""

install: ## Install bifrost + deps into your PATH (runs install.sh)
	bash install.sh

setup: ## One-time config (default host + SSH user, tmux.conf)
	@$(BIFROST) setup

scan: ## Discover machines on your Tailscale network
	@$(BIFROST) realm scan

add: ## Add a realm:  make add NAME=asgard
	@test -n "$(NAME)" || { echo "usage: make add NAME=<realm>"; exit 1; }
	@$(BIFROST) realm add $(NAME)

summon: ## ★ Launch — a grid/tabs for every realm
	@$(BIFROST) summon

doctor: ## Check prerequisites (local + every realm)
	@$(BIFROST) doctor

sessions: ## Visual map of every running session
	@$(BIFROST) sessions

status: ## Connectivity overview
	@$(BIFROST) status

sync: ## Push tmux.conf to all realms
	@$(BIFROST) sync

kill: ## Tear down all sessions
	@$(BIFROST) kill

lint: ## Syntax-check the shell scripts
	@bash -n bifrost && bash -n install.sh && echo "ok: scripts parse clean"

ci: ## Run local CI (version-bump gate; Actions is billing-blocked)
	@bash scripts/ci.sh check

release: ## Cut the v<version> GitHub release (manual)
	@bash scripts/ci.sh release

uninstall: ## Remove bifrost from ~/bin and ~/.local/bin (config left intact)
	@rm -f "$$HOME/bin/bifrost" "$$HOME/.local/bin/bifrost" && echo "removed bifrost (config under ~/.config/bifrost left intact)"

test: ## run the test suite (no deps, just bash)
	@bash scripts/ci.sh test
