"""create model_versions, drift_records, validation_reports

Revision ID: 0004
Revises: 0003
"""
from alembic import op
import sqlalchemy as sa

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # model_versions
    op.create_table(
        "model_versions",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("config_yaml", sa.Text, nullable=False),
        sa.Column("config_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("description", sa.Text, nullable=True),
        sa.Column("created_by", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.Column("published_at", sa.DateTime, nullable=True),
        sa.Column("deprecated_at", sa.DateTime, nullable=True),
        sa.Column("validation_status", sa.String(16), nullable=True),
        sa.Column("validation_report_path", sa.String(256), nullable=True),
        sa.Column("validation_metrics", sa.JSON, nullable=True),
    )

    # drift_records
    op.create_table(
        "drift_records",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("model_version_id", sa.String(64),
                  sa.ForeignKey("model_versions.id"), nullable=False),
        sa.Column("drift_type", sa.String(24), nullable=False),
        sa.Column("feature_name", sa.String(64), nullable=True),
        sa.Column("detected_at", sa.DateTime, nullable=False),
        sa.Column("window_start", sa.DateTime, nullable=False),
        sa.Column("window_end", sa.DateTime, nullable=False),
        sa.Column("reference_mean", sa.Float, nullable=True),
        sa.Column("reference_std", sa.Float, nullable=True),
        sa.Column("current_mean", sa.Float, nullable=True),
        sa.Column("current_std", sa.Float, nullable=True),
        sa.Column("test_name", sa.String(64), nullable=True),
        sa.Column("statistic", sa.Float, nullable=True),
        sa.Column("p_value", sa.Float, nullable=True),
        sa.Column("threshold", sa.Float, nullable=True),
        sa.Column("severity", sa.String(16), nullable=False),
        sa.Column("description", sa.Text, nullable=True),
        sa.Column("recommended_action", sa.Text, nullable=True),
        sa.Column("resolved", sa.Boolean, default=False),
        sa.Column("resolved_at", sa.DateTime, nullable=True),
        sa.Column("resolved_by", sa.String(64), nullable=True),
    )
    op.create_index("ix_drift_model", "drift_records", ["model_version_id"])
    op.create_index("ix_drift_type", "drift_records", ["drift_type"])
    op.create_index("ix_drift_feature", "drift_records", ["feature_name"])

    # validation_reports
    op.create_table(
        "validation_reports",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("stage", sa.String(8), nullable=False),
        sa.Column("model_version_id", sa.String(64),
                  sa.ForeignKey("model_versions.id"), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("started_at", sa.DateTime, nullable=False),
        sa.Column("completed_at", sa.DateTime, nullable=True),
        sa.Column("metrics", sa.JSON, nullable=True),
        sa.Column("summary", sa.Text, nullable=True),
        sa.Column("report_path", sa.String(256), nullable=True),
        sa.Column("n_samples", sa.Integer, nullable=True),
        sa.Column("n_workers", sa.Integer, nullable=True),
        sa.Column("reproducibility_score", sa.Float, nullable=True),
        sa.Column("created_at", sa.DateTime, nullable=False),
    )
    op.create_index("ix_validation_stage", "validation_reports", ["stage"])
    op.create_index("ix_validation_model", "validation_reports", ["model_version_id"])


def downgrade() -> None:
    op.drop_index("ix_validation_model", table_name="validation_reports")
    op.drop_index("ix_validation_stage", table_name="validation_reports")
    op.drop_table("validation_reports")

    op.drop_index("ix_drift_feature", table_name="drift_records")
    op.drop_index("ix_drift_type", table_name="drift_records")
    op.drop_index("ix_drift_model", table_name="drift_records")
    op.drop_table("drift_records")

    op.drop_table("model_versions")
