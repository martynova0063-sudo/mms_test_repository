"""SQL DDL — схема БД."""
from __future__ import annotations

SCHEMA_SQL = """
-- Верификации
CREATE TABLE IF NOT EXISTS verifications (
    verification_id UUID PRIMARY KEY,
    worker_pseudonym VARCHAR(64) NOT NULL,
    event_id VARCHAR(128),
    status VARCHAR(20) NOT NULL CHECK (status IN ('verified', 'manual_review', 'not_verified')),
    face_match_score FLOAT,
    liveness_score FLOAT,
    quality_score FLOAT,
    pipeline_version VARCHAR(32) NOT NULL,
    config_hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMP,
    full_result JSONB NOT NULL
);

-- Версии модели
CREATE TABLE IF NOT EXISTS model_versions (
    version_id UUID PRIMARY KEY,
    model_version VARCHAR(64) UNIQUE NOT NULL,
    parent_version VARCHAR(64),
    change_type VARCHAR(10) NOT NULL,
    change_description TEXT,
    config_snapshot JSONB NOT NULL,
    config_hash VARCHAR(64) NOT NULL,
    created_by VARCHAR(128) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    status VARCHAR(20) NOT NULL DEFAULT 'experimental'
);

-- Расчёты HEALTH_ID
CREATE TABLE IF NOT EXISTS health_id_calculations (
    calculation_id UUID PRIMARY KEY,
    worker_pseudonym VARCHAR(64) NOT NULL,
    event_id VARCHAR(128),
    model_version VARCHAR(64) NOT NULL REFERENCES model_versions(model_version),
    config_hash VARCHAR(64) NOT NULL,
    health_id_value FLOAT NOT NULL,
    completeness FLOAT NOT NULL,
    uncertainty_score FLOAT NOT NULL,
    is_acute BOOLEAN DEFAULT FALSE,
    is_persistent BOOLEAN DEFAULT FALSE,
    is_chronic BOOLEAN DEFAULT FALSE,
    full_result JSONB NOT NULL,
    evidence JSONB NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Review tasks
CREATE TABLE IF NOT EXISTS review_tasks (
    review_id UUID PRIMARY KEY,
    calculation_id UUID NOT NULL REFERENCES health_id_calculations(calculation_id),
    status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected')),
    priority VARCHAR(10) NOT NULL CHECK (priority IN ('routine', 'urgent')),
    trigger VARCHAR(50) NOT NULL,
    reviewer_id VARCHAR(128),
    reviewer_qualification VARCHAR(128),
    comment TEXT,
    decision_rationale TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    reviewed_at TIMESTAMP,
    audit_trail JSONB NOT NULL DEFAULT '[]'
);

-- Baseline
CREATE TABLE IF NOT EXISTS baselines (
    baseline_id UUID PRIMARY KEY,
    worker_pseudonym VARCHAR(64) NOT NULL,
    model_version VARCHAR(64) NOT NULL,
    baseline_version VARCHAR(64) NOT NULL,
    n_historical_points INT NOT NULL,
    current_point_excluded BOOLEAN NOT NULL DEFAULT TRUE,
    corridors JSONB NOT NULL,
    fallback_used BOOLEAN NOT NULL DEFAULT FALSE,
    fallback_reason TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Журнал аудита
CREATE TABLE IF NOT EXISTS audit_log (
    audit_id UUID PRIMARY KEY,
    entity_type VARCHAR(50) NOT NULL,
    entity_id UUID NOT NULL,
    action VARCHAR(50) NOT NULL,
    actor VARCHAR(128) NOT NULL,
    actor_role VARCHAR(50) NOT NULL,
    timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
    details JSONB,
    ip_address INET,
    user_agent TEXT
);

-- Дрейф данных
CREATE TABLE IF NOT EXISTS drift_reports (
    report_id UUID PRIMARY KEY,
    model_version VARCHAR(64) NOT NULL,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    metrics JSONB NOT NULL,
    alerts JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Индексы
CREATE INDEX IF NOT EXISTS idx_verifications_worker ON verifications(worker_pseudonym);
CREATE INDEX IF NOT EXISTS idx_verifications_event ON verifications(event_id);
CREATE INDEX IF NOT EXISTS idx_verifications_status ON verifications(status);
CREATE INDEX IF NOT EXISTS idx_model_versions_version ON model_versions(model_version);
CREATE INDEX IF NOT EXISTS idx_health_id_worker ON health_id_calculations(worker_pseudonym);
CREATE INDEX IF NOT EXISTS idx_health_id_model ON health_id_calculations(model_version);
CREATE INDEX IF NOT EXISTS idx_review_tasks_calc ON review_tasks(calculation_id);
CREATE INDEX IF NOT EXISTS idx_review_tasks_status ON review_tasks(status);
CREATE INDEX IF NOT EXISTS idx_review_tasks_priority ON review_tasks(priority);
CREATE INDEX IF NOT EXISTS idx_baselines_worker ON baselines(worker_pseudonym);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_drift_model ON drift_reports(model_version);
CREATE INDEX IF NOT EXISTS idx_drift_period ON drift_reports(period_start, period_end);
"""

def init_schema(conn):
    """Создаёт все таблицы и индексы."""
    cur = conn.cursor()
    cur.execute(SCHEMA_SQL)
    conn.commit()
    cur.close()
    print("Schema initialized successfully.")

def get_schema_sql() -> str:
    return SCHEMA_SQL
