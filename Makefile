.PHONY: setup dev backend frontend test lint build prod-smoke

setup:
	cd backend && uv sync
	npm --prefix frontend ci

dev:
	@printf "Run 'make backend' and 'make frontend' in separate terminals.\n"

backend:
	cd backend && uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8040

frontend:
	npm --prefix frontend run dev -- --host 127.0.0.1 --port 3040

test:
	cd backend && uv run pytest
	npm --prefix frontend test -- --run

lint:
	cd backend && uv run ruff check app tests
	npm --prefix frontend run typecheck

build:
	npm --prefix frontend run build

prod-smoke:
	cd backend && uv run python -m scripts.prod_smoke
