"""create examination tables and health_id_results

Revision ID: 0002
Revises: 0001
"""
from alembic import op
import sqlalchemy as sa

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # examination_events
    op.create_table(
        "examination_events",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("event_id", sa.String(64), nullable=False, unique=True),
        sa.Column("event_type", sa.String(64), nullable=False),
        sa.Column("worker_pseudonym", sa.String(64), nullable=False),
        sa.Column("timestamp", sa.DateTime, nullable=False),
        sa.Column("mis_source", sa.String(32), nullable=False),
        sa.Column("transmission_id", sa.String(64), nullable=True),
        sa.Column("transmission_timestamp", sa.DateTime, nullable=True),
        sa.Column("quality_status", sa.String(32), nullable=False),
        sa.Column("quality_report", sa.JSON, nullable=True),
        sa.Column("raw_payload_hash", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.Column("updated_at", sa.DateTime, nullable=False),
    )
    op.create_index("ix_event_event_id", "examination_events", ["event_id"])
    op.create_index("ix_event_worker", "examination_events", ["worker_pseudonym"])
    op.create_index("ix_event_timestamp", "examination_events", ["timestamp"])
    op.create_index("ix_event_worker_ts", "examination_events", ["worker_pseudonym", "timestamp"])

    # vital_measurements
    op.create_table(
        "vital_measurements",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("event_id", sa.String(36),
                  sa.ForeignKey("examination_events.id"), nullable=False),
        sa.Column("feature_name", sa.String(32), nullable=False),
        sa.Column("value", sa.Float, nullable=False),
        sa.Column("unit", sa.String(16), nullable=False),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("confidence", sa.Float, nullable=True),
        sa.Column("artifact_pct", sa.Float, nullable=True),
        sa.Column("measurement_protocol", sa.String(32), nullable=True),
        sa.Column("device_id", sa.String(64), nullable=True),
        sa.Column("device_model", sa.String(64), nullable=True),
        sa.Column("measured_at", sa.DateTime, nullable=True),
        sa.Column("unit_mismatch", sa.Boolean, default=False),
        sa.Column("low_quality", sa.Boolean, default=False),
        sa.Column("high_artifact", sa.Boolean, default=False),
        sa.Column("protocol_violation", sa.Boolean, default=False),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.UniqueConstraint("event_id", "feature_name", name="uq_vital_event_feature"),
    )
    op.create_index("ix_vital_event", "vital_measurements", ["event_id"])
    op.create_index("ix_vital_feature", "vital_measurements", ["feature_name"])
    op.create_index("ix_vital_event_feature", "vital_measurements", ["event_id", "feature_name"])

    # mental_assessments
    op.create_table(
        "mental_assessments",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("event_id", sa.String(36),
                  sa.ForeignKey("examination_events.id"), nullable=False, unique=True),
        sa.Column("adequacy_score", sa.Float, nullable=True),
        sa.Column("adequacy_source", sa.String(16), nullable=False),
        sa.Column("adequacy_confidence", sa.Float, nullable=True),
        sa.Column("speech_coherence", sa.Float, nullable=True),
        sa.Column("speech_source", sa.String(16), nullable=False),
        sa.Column("speech_confidence", sa.Float, nullable=True),
        sa.Column("pupil_reaction", sa.Float, nullable=True),
        sa.Column("pupil_source", sa.String(16), nullable=False),
        sa.Column("pupil_confidence", sa.Float, nullable=True),
        sa.Column("reviewer_notes", sa.Text, nullable=True),
        sa.Column("created_at", sa.DateTime, nullable=False),
    )
    op.create_index("ix_mental_event", "mental_assessments", ["event_id"])

    # social_context
    op.create_table(
        "social_context",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("event_id", sa.String(36),
                  sa.ForeignKey("examination_events.id"), nullable=False, unique=True),
        sa.Column("workplace", sa.String(128), nullable=True),
        sa.Column("shift", sa.String(32), nullable=True),
        sa.Column("examination_type", sa.String(32), nullable=False),
        sa.Column("examination_regularity", sa.Float, nullable=True),
        sa.Column("missed_examinations", sa.Integer, nullable=True),
        sa.Column("missed_window_days", sa.Integer, nullable=True),
        sa.Column("regularity_calculated_at", sa.DateTime, nullable=True),
        sa.Column("regularity_window_days", sa.Integer, nullable=True),
        sa.Column("created_at", sa.DateTime, nullable=False),
    )
    op.create_index("ix_social_event", "social_context", ["event_id"])

    # health_id_results
    op.create_table(
        "health_id_results",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("event_id", sa.String(36),
                  sa.ForeignKey("examination_events.id"), nullable=False, unique=True),
        sa.Column("value", sa.Float, nullable=False),
        sa.Column("category", sa.String(16), nullable=False),
        sa.Column("model_version", sa.String(32), nullable=False),
        sa.Column("config_snapshot_hash", sa.String(64), nullable=False),
        sa.Column("hbody_value", sa.Float, nullable=False),
        sa.Column("hbody_weight", sa.Float, nullable=False),
        sa.Column("hbody_contribution", sa.Float, nullable=False),
        sa.Column("hmental_value", sa.Float, nullable=False),
        sa.Column("hmental_weight", sa.Float, nullable=False),
        sa.Column("hmental_contribution", sa.Float, nullable=False),
        sa.Column("hsocial_value", sa.Float, nullable=False),
        sa.Column("hsocial_weight", sa.Float, nullable=False),
        sa.Column("hsocial_contribution", sa.Float, nullable=False),
        sa.Column("completeness", sa.Float, nullable=False),
        sa.Column("uncertainty", sa.Float, nullable=False),
        sa.Column("missing_features", sa.JSON, nullable=True),
        sa.Column("acute_deviation", sa.Boolean, default=False),
        sa.Column("persistent_repeated_deviation", sa.Boolean, default=False),
        sa.Column("confirmed_chronic", sa.Boolean, default=False),
        sa.Column("personal_deviation", sa.Boolean, default=False),
        sa.Column("personal_deviation_feature", sa.String(32), nullable=True),
        sa.Column("personal_deviation_detail", sa.JSON, nullable=True),
        sa.Column("evidence", sa.JSON, nullable=True),
        sa.Column("human_readable", sa.Text, nullable=True),
        sa.Column("disclaimer", sa.Text, nullable=False),
        sa.Column("calculated_at", sa.DateTime, nullable=False),
        sa.Column("calculation_duration_ms", sa.Integer, nullable=True),
        sa.Column("reproducible", sa.Boolean, default=True),
    )
    op.create_index("ix_result_event", "health_id_results", ["event_id"])
    op.create_index("ix_result_version", "health_id_results", ["model_version"])


def downgrade() -> None:
    op.drop_index("ix_result_version", table_name="health_id_results")
    op.drop_index("ix_result_event", table_name="health_id_results")
    op.drop_table("health_id_results")

    op.drop_index("ix_social_event", table_name="social_context")
    op.drop_table("social_context")

    op.drop_index("ix_mental_event", table_name="mental_assessments")
    op.drop_table("mental_assessments")

    op.drop_index("ix_vital_event_feature", table_name="vital_measurements")
    op.drop_index("ix_vital_feature", table_name="vital_measurements")
    op.drop_index("ix_vital_event", table_name="vital_measurements")
    op.drop_table("vital_measurements")

    op.drop_index("ix_event_worker_ts", table_name="examination_events")
    op.drop_index("ix_event_timestamp", table_name="examination_events")
    op.drop_index("ix_event_worker", table_name="examination_events")
    op.drop_index("ix_event_event_id", table_name="examination_events")
    op.drop_table("examination_events")
