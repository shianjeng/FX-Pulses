.PHONY: dev test test-backend test-extension test-userscript lint lint-python lint-js

dev:
	docker compose up --build

test: test-backend test-extension test-userscript

test-backend:
	cd backend && pytest

test-extension:
	npm test

test-userscript:
	node userscript/node-check.mjs
	node userscript/dom-smoke.cjs

lint: lint-python lint-js

lint-python:
	cd backend && ruff check .

lint-js:
	npm run lint
