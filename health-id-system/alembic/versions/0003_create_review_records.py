"""create review_records table

Revision ID: 0003
Revises: 0002
"""
from alembic import op
import sqlalchemy as sa

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "review_records",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("review_type", sa.String(32), nullable=False),
        sa.Column("target_id", sa.String(36), nullable=False),
        sa.Column("event_id", sa.String(36),
                  sa.ForeignKey("examination_events.id"), nullable=True),
        sa.Column("worker_pseudonym", sa.String(64), nullable=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("assigned_by", sa.String(64), nullable=False),
        sa.Column("assigned_reason", sa.Text, nullable=True),
        sa.Column("priority", sa.String(16), nullable=False),
        sa.Column("reviewer_id", sa.String(64), nullable=True),
        sa.Column("reviewer_name", sa.String(128), nullable=True),
        sa.Column("reviewer_role", sa.String(64), nullable=True),
        sa.Column("decision", sa.String(16), nullable=True),
        sa.Column("decision_comment", sa.Text, nullable=True),
        sa.Column("decision_evidence", sa.JSON, nullable=True),
        sa.Column("decided_at", sa.DateTime, nullable=True),
        sa.Column("context", sa.JSON, nullable=True),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.Column("updated_at", sa.DateTime, nullable=False),
        sa.Column("expires_at", sa.DateTime, nullable=True),
    )
    op.create_index("ix_review_type_status", "review_records", ["review_type", "status"])
    op.create_index("ix_review_target", "review_records", ["review_type", "target_id"])
    op.create_index("ix_review_event", "review_records", ["event_id"])
    op.create_index("ix_review_worker", "review_records", ["worker_pseudonym"])
    op.create_index("ix_review_status", "review_records", ["status"])


def downgrade() -> None:
    op.drop_index("ix_review_status", table_name="review_records")
    op.drop_index("ix_review_worker", table_name="review_records")
    op.drop_index("ix_review_event", table_name="review_records")
    op.drop_index("ix_review_target", table_name="review_records")
    op.drop_index("ix_review_type_status", table_name="review_records")
    op.drop_table("review_records")
