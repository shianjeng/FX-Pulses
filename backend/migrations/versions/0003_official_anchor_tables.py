"""Store whole official tables and a collector heartbeat.

`official_rates` held one row per tracked pair, so only three pairs could ever be
answered. The anchor table keeps every currency an institution publishes, which
lets the API cross any covered pair without another upstream request.
"""
import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "official_anchor_rates",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("institution", sa.String(80), nullable=False),
        sa.Column("anchor_currency", sa.String(3), nullable=False),
        sa.Column("currency", sa.String(3), nullable=False),
        sa.Column("units_per_anchor", sa.Numeric(28, 12), nullable=False),
        sa.Column("rate_type", sa.String(80), nullable=False),
        sa.Column("reference_date", sa.Date(), nullable=False),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("source_url", sa.String(500), nullable=False),
        sa.UniqueConstraint(
            "institution", "anchor_currency", "currency", "reference_date",
            name="uq_official_anchor_observation",
        ),
    )
    op.create_index(
        "ix_official_anchor_lookup", "official_anchor_rates",
        ["institution", "reference_date"],
    )
    op.create_table(
        "collector_runs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("job", sa.String(40), nullable=False, unique=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_success_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("consecutive_failures", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_error", sa.String(300), nullable=True),
    )
    # Derived pair rows are rebuilt from the next collection; nothing is lost.
    op.drop_index("ix_official_pair_date", table_name="official_rates")
    op.drop_table("official_rates")


def downgrade():
    op.create_table(
        "official_rates",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("base_currency", sa.String(3), nullable=False),
        sa.Column("quote_currency", sa.String(3), nullable=False),
        sa.Column("rate", sa.Numeric(20, 8), nullable=False),
        sa.Column("institution", sa.String(80), nullable=False),
        sa.Column("rate_type", sa.String(80), nullable=False),
        sa.Column("reference_date", sa.Date(), nullable=False),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("source_url", sa.String(500), nullable=False),
        sa.Column("is_derived", sa.Boolean(), nullable=False),
        sa.UniqueConstraint(
            "base_currency", "quote_currency", "institution", "reference_date",
            name="uq_official_rate_observation",
        ),
    )
    op.create_index(
        "ix_official_pair_date", "official_rates",
        ["base_currency", "quote_currency", "reference_date"],
    )
    op.drop_table("collector_runs")
    op.drop_index("ix_official_anchor_lookup", table_name="official_anchor_rates")
    op.drop_table("official_anchor_rates")
