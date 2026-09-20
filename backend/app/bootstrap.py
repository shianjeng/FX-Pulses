"""Run once after alembic upgrade head; never makes upstream requests."""
from app.database import SessionLocal
from app.seed import seed_demo_history

if __name__ == "__main__":
    with SessionLocal() as db:
        seed_demo_history(db)
