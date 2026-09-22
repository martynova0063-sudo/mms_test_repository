"""create media_registry table

Revision ID: 0001
Revises:
"""
from alembic import op
import sqlalchemy as sa

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "media_registry",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("employee_uuid", sa.String(36), nullable=False),
        sa.Column("event_uuid", sa.String(256), nullable=False),
        sa.Column("media_type", sa.String(10), nullable=False),
        sa.Column("relative_path", sa.String(512), nullable=False),
        sa.Column("file_name", sa.String(256), nullable=False),
        sa.Column("size_bytes", sa.Integer, nullable=False),
        sa.Column("sha256_hash", sa.String(64), nullable=True),
        sa.Column("exam_date", sa.DateTime, nullable=False),
        sa.Column("stored_locally", sa.Boolean, default=False),
        sa.Column("last_write_time", sa.DateTime, nullable=False),
        sa.Column("created_at", sa.DateTime, nullable=False),
    )
    op.create_index("ix_media_employee", "media_registry", ["employee_uuid"])
    op.create_index("ix_media_event", "media_registry", ["event_uuid"])
    op.create_index("ix_media_type", "media_registry", ["media_type"])


def downgrade() -> None:
    op.drop_index("ix_media_type", table_name="media_registry")
    op.drop_index("ix_media_event", table_name="media_registry")
    op.drop_index("ix_media_employee", table_name="media_registry")
    op.drop_table("media_registry")
