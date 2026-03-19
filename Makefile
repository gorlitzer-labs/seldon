.DEFAULT_GOAL := help
.PHONY: help setup build run-claude run-codex ps stop test typecheck

help:                     ## show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[33m%-16s\033[0m %s\n", $$1, $$2}'

setup:                    ## install deps, build, and link the `apiary` command globally
	npm install
	npm run build
	npm link

build:                    ## build TypeScript
	npm run build

run-claude:               ## launch Claude agent locally
	apiary run claude $(ARGS)

run-codex:                ## launch Codex agent locally
	apiary run codex $(ARGS)

ps:                       ## list active sessions
	apiary ps

stop:                     ## stop backgrounded agents
	apiary stop claude $(ARGS)

test:                     ## run tests
	npm test

typecheck:                ## type check
	npm run typecheck
