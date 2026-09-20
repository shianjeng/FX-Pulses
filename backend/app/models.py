from datetime import date, datetime, timezone
from decimal import Decimal

from sqlalchemy import Boolean, Date, DateTime, Index, Numeric, String, UniqueConstraint
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


class OfficialRate(Base):
    __tablename__ = "official_rates"
    __table_args__ = (
        UniqueConstraint(
            "base_currency", "quote_currency", "institution", "reference_date",
            name="uq_official_rate_observation",
        ),
        Index(
            "ix_official_pair_date",
            "base_currency", "quote_currency", "reference_date",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    base_currency: Mapped[str] = mapped_column(String(3))
    quote_currency: Mapped[str] = mapped_column(String(3))
    rate: Mapped[Decimal] = mapped_column(Numeric(20, 8))
    institution: Mapped[str] = mapped_column(String(80))
    rate_type: Mapped[str] = mapped_column(String(80))
    reference_date: Mapped[date] = mapped_column(Date)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    source_url: Mapped[str] = mapped_column(String(500))
    is_derived: Mapped[bool] = mapped_column(Boolean, default=False)
