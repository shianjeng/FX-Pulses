from contextlib import asynccontextmanager

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import router
from app.config import get_settings
from app.database import Base, SessionLocal, engine
from app.seed import seed_demo_history
from app.services import refresh_all_rates

settings = get_settings()


@asynccontextmanager
async def lifespan(_: FastAPI):
    scheduler = AsyncIOScheduler(timezone="UTC")
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as db:
        seed_demo_history(db)
    await refresh_all_rates()
    scheduler.add_job(
        refresh_all_rates,
        "interval",
        minutes=settings.refresh_interval_minutes,
        id="refresh-rates",
        max_instances=1,
        coalesce=True,
        replace_existing=True,
    )
    scheduler.start()
    yield
    scheduler.shutdown(wait=False)


app = FastAPI(
    title="FX Pulse API",
    description="Public, privacy-friendly market midpoint API for the FX Pulse extension.",
    version="2.0.0",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[],
    allow_origin_regex=r"^(chrome-extension|moz-extension)://.*$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(router, prefix=settings.api_prefix)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "provider": settings.fx_provider}
