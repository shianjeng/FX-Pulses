import hashlib
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from fastapi import Depends, FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api import aware, router
from app.config import get_settings
from app.database import get_db
from app.models import CollectorRun
from app.schemas import CollectorJobOut, HealthOut
from app.services import MARKET_JOB, OFFICIAL_JOB

settings = get_settings()

# Per-client request timestamps. A single shared counter let one client exhaust
# the limit for everybody, and a fixed window allowed a 2x burst on the boundary.
_hits: dict[str, deque[float]] = defaultdict(deque)
_CLIENT_LIMIT = 10_000


@asynccontextmanager
async def lifespan(app: FastAPI):
    # No network I/O, schema mutation, or scheduler in API workers.
    _hits.clear()
    yield
    _hits.clear()


app = FastAPI(title="FX Pulse API", version="2.5.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[],
    allow_origin_regex=r"^(chrome-extension|moz-extension)://[a-zA-Z0-9-]+$",
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["Content-Type", "If-None-Match"],
    expose_headers=["ETag"],
)
app.include_router(router, prefix=settings.api_prefix)


def client_key(request: Request) -> str:
    if settings.trust_forwarded_for:
        forwarded = request.headers.get("x-forwarded-for", "")
        if forwarded:
            return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


@app.middleware("http")
async def conditional_cache(request: Request, call_next):
    """Serve 304s for unchanged cached data instead of re-rendering every read."""
    response = await call_next(request)
    if (
        request.method != "GET"
        or response.status_code != 200
        or not request.url.path.startswith(settings.api_prefix)
        or not hasattr(response, "body_iterator")
    ):
        return response
    body = b"".join([chunk async for chunk in response.body_iterator])
    etag = f'"{hashlib.sha256(body).hexdigest()[:32]}"'
    cache_control = f"public, max-age={settings.response_cache_seconds}"
    if request.headers.get("if-none-match") == etag:
        headers = {
            key: value for key, value in response.headers.items()
            if key.lower() not in {"content-length", "etag", "cache-control"}
        }
        headers.update({"ETag": etag, "Cache-Control": cache_control})
        return Response(status_code=304, headers=headers)
    headers = {
        key: value
        for key, value in response.headers.items()
        if key.lower() not in {"content-length", "etag", "cache-control"}
    }
    headers["ETag"] = etag
    headers["Cache-Control"] = cache_control
    return Response(
        content=body, status_code=200, headers=headers, media_type=response.media_type,
    )


@app.middleware("http")
async def limit_reads(request: Request, call_next):
    if request.url.path.startswith(settings.api_prefix):
        now = time.monotonic()
        hits = _hits[client_key(request)]
        while hits and now - hits[0] > 60:
            hits.popleft()
        if len(hits) >= settings.api_requests_per_minute:
            return JSONResponse(
                {"detail": "Request limit exceeded"}, status_code=429,
                headers={"Retry-After": "60"},
            )
        hits.append(now)
        if len(_hits) > _CLIENT_LIMIT:
            for key in [k for k, v in _hits.items() if not v or now - v[-1] > 300]:
                _hits.pop(key, None)
    return await call_next(request)


@app.get("/health", response_model=HealthOut)
def health(db: Session = Depends(get_db)) -> HealthOut:
    """`status` stays "ok" while the API itself is serving; collector trouble is
    reported separately so clients can distinguish stale data from a dead job."""
    intervals = {
        MARKET_JOB: settings.refresh_interval_minutes,
        OFFICIAL_JOB: settings.official_refresh_interval_minutes,
    }
    now = datetime.now(timezone.utc)
    runs = {run.job: run for run in db.scalars(select(CollectorRun)).all()}
    jobs = []
    for job, interval in intervals.items():
        run = runs.get(job)
        if run is None:
            jobs.append(CollectorJobOut(job=job, is_stalled=True, last_error="never ran"))
            continue
        success = aware(run.last_success_at) if run.last_success_at else None
        limit = timedelta(minutes=interval * settings.collector_stall_factor)
        jobs.append(CollectorJobOut(
            job=job,
            finished_at=aware(run.finished_at),
            last_success_at=success,
            consecutive_failures=run.consecutive_failures or 0,
            last_error=run.last_error,
            is_stalled=success is None or now - success > limit,
        ))
    return HealthOut(status="ok", provider=settings.fx_provider, collector=jobs)
