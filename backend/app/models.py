from datetime import date, datetime, timezone
from decimal import Decimal

from sqlalchemy import Date, DateTime, Index, Integer, Numeric, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class RateSnapshot(Base):
    __tablename__ = "rate_snapshots"
    __table_args__ = (Index("ix_rate_pair_time", "base_currency", "quote_currency", "captured_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    base_currency: Mapped[str] = mapped_column(String(3))
    quote_currency: Mapped[str] = mapped_column(String(3))
    bid: Mapped[Decimal] = mapped_column(Numeric(20, 8))
    ask: Mapped[Decimal] = mapped_column(Numeric(20, 8))
    midpoint: Mapped[Decimal] = mapped_column(Numeric(20, 8))
    provider: Mapped[str] = mapped_column(String(40))
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ProviderRequest(Base):
    __tablename__ = "provider_requests"
    id: Mapped[int] = mapped_column(primary_key=True)
    attempted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, index=True
    )


class OfficialAnchorRate(Base):
    """One institution's observation for one currency against its anchor currency.

    Storing the whole published table (rather than only the tracked pairs) lets the
    API derive any pair the institution covers without another upstream request.
    """

    __tablename__ = "official_anchor_rates"
    __table_args__ = (
        UniqueConstraint(
            "institution", "anchor_currency", "currency", "reference_date",
            name="uq_official_anchor_observation",
        ),
        Index("ix_official_anchor_lookup", "institution", "reference_date"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    institution: Mapped[str] = mapped_column(String(80))
    anchor_currency: Mapped[str] = mapped_column(String(3))
    currency: Mapped[str] = mapped_column(String(3))
    # Units of `currency` per one unit of `anchor_currency`; 12 decimals keep the
    # reciprocal of a published rate (Bank of Canada) lossless for our purposes.
    units_per_anchor: Mapped[Decimal] = mapped_column(Numeric(28, 12))
    rate_type: Mapped[str] = mapped_column(String(80))
    reference_date: Mapped[date] = mapped_column(Date)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    source_url: Mapped[str] = mapped_column(String(500))


class CollectorRun(Base):
    """Heartbeat per collector job so /health can tell 'stopped' from 'stale'."""

    __tablename__ = "collector_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    job: Mapped[str] = mapped_column(String(40), unique=True)
    finished_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_success_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    consecutive_failures: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str | None] = mapped_column(String(300), nullable=True)

