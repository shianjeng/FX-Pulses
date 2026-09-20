import os

os.environ["DATABASE_URL"] = "sqlite:///./test_fx_pulse.db"
os.environ["FX_PROVIDER"] = "mock"

import pytest
from fastapi.testclient import TestClient

from app.database import Base, SessionLocal, engine
from app.main import app
from app.seed import seed_demo_history


@pytest.fixture(autouse=True)
def reset_database():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture
def client():
    with SessionLocal() as db:
        seed_demo_history(db)
    with TestClient(app) as test_client:
        yield test_client
