.PHONY: dev test lint

dev:
	docker compose up --build

test:
	cd backend && pytest

lint:
	cd backend && ruff check .
