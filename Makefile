.PHONY: dev preview test lint check test-backend test-extension lint-backend lint-extension

dev:
	docker compose up --build

# The popup, settings and a hover demo in an ordinary browser, on live data.
preview:
	python3 tools/preview.py

# Every stack; the per-stack targets below still run on their own (from #9 by @Z-Han-Z).
test: test-backend test-extension

test-backend:
	cd backend && pytest

test-extension:
	npm test
	npm run test:userscript

lint: lint-backend lint-extension

lint-backend:
	cd backend && ruff check .

lint-extension:
	npm run lint

# What CI checks beyond tests and lint.
check:
	npm run check:i18n
	npm run check:config
	npm run check:parser
