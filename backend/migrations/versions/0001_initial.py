"""Baseline existing v2 snapshots; add persisted provider request budget."""
import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    # v2 installations already have snapshots. Preserve their data.
    if not sa.inspect(op.get_bind()).has_table("rate_snapshots"):
        op.create_table(
            "rate_snapshots",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("base_currency", sa.String(3), nullable=False),
            sa.Column("quote_currency", sa.String(3), nullable=False),
            sa.Column("bid", sa.Numeric(20, 8), nullable=False),
            sa.Column("ask", sa.Numeric(20, 8), nullable=False),
            sa.Column("midpoint", sa.Numeric(20, 8), nullable=False),
            sa.Column("provider", sa.String(40), nullable=False),
            sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_rate_pair_time", "rate_snapshots",
                        ["base_currency", "quote_currency", "captured_at"])
    op.create_table(
        "provider_requests",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("attempted_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_provider_requests_attempted_at", "provider_requests", ["attempted_at"])


def downgrade():
    op.drop_table("provider_requests")
    # Never silently destroy existing snapshots when rolling back this baseline.
