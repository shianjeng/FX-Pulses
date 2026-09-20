import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api import router
from app.config import get_settings

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # No network I/O, schema mutation, or scheduler in API workers.
    app.state.request_window = (0, 0)
    yield


app = FastAPI(title="FX Pulse API", version="2.2.1", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[],
    allow_origin_regex=r"^(chrome-extension|moz-extension)://[a-zA-Z0-9-]+$",
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["Content-Type"],
)
app.include_router(router, prefix=settings.api_prefix)


@app.middleware("http")
async def limit_reads(request: Request, call_next):
    if request.url.path.startswith(settings.api_prefix):
        window = int(time.monotonic() // 60)
        previous, count = getattr(app.state, "request_window", (window, 0))
        count = count + 1 if previous == window else 1
        app.state.request_window = (window, count)
        if count > settings.api_requests_per_minute:
            return JSONResponse(
                {"detail": "Request limit exceeded"}, status_code=429,
                headers={"Retry-After": "60"},
            )
    return await call_next(request)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "provider": settings.fx_provider}
