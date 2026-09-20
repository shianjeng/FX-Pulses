"""Add normalized official reference-rate observations."""
import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade():
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


def downgrade():
    op.drop_table("official_rates")
