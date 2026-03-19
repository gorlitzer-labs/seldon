.PHONY: build up down logs run-claude run-codex ps stop test typecheck

build:                    ## build TypeScript
	npm run build

up:                       ## start room server (Docker)
	docker compose up -d --build

down:                     ## stop room server
	docker compose down

logs:                     ## tail server logs
	docker compose logs -f

run-claude:               ## launch Claude agent locally
	node dist/cli/index.js run claude $(ARGS)

run-codex:                ## launch Codex agent locally
	node dist/cli/index.js run codex $(ARGS)

ps:                       ## list active sessions
	node dist/cli/index.js ps

stop:                     ## stop backgrounded agents
	node dist/cli/index.js stop claude $(ARGS)

test:                     ## run tests
	npm test

typecheck:                ## type check
	npm run typecheck
