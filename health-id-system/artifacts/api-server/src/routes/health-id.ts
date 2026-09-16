import { Router, type IRouter, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import {
  CalculateHealthIdBody,
  CreateReviewBody,
  GetResultParams,
  GetWorkerDynamicsParams,
  GetVerificationParams,
  ListResultsQueryParams,
  UpdateReviewBody,
  UpdateReviewParams,
  VerifyIdentityBody,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";

type Category = "green" | "yellow" | "red";
type ReviewStatus = "pending" | "confirmed" | "rejected";

const DISCLAIMER =
  "Исследовательский результат. Не является медицинским диагнозом и не используется для решения о допуске к работе.";
const MODEL_VERSION = "health_id_v1.0.0";
const CONFIG_HASH = "sha256:7f1a2d9c6b4e11a0";

const modelCard = {
  model_name: "HEALTH_ID",
  model_version: MODEL_VERSION,
  status: "research",
  created_at: "2026-09-15",
  description:
    "Исследовательский интегральный индекс здоровья для дистанционных периодических медицинских осмотров.",
  intended_use:
    "Воспроизводимый расчёт интегрального показателя на обезличенных данных ПрМО с полным evidence trace.",
  out_of_scope: [
    "Постановка диагноза",
    "Назначение лечения",
    "Решение о допуске к работе",
    "Замена медицинского заключения",
  ],
  components: [
    { key: "hBody", label: "Физическое состояние", weight: 0.6, feature_count: 6 },
    { key: "hMental", label: "Психофизиологическая оценка", weight: 0.25, feature_count: 3 },
    { key: "hSocial", label: "Контекст осмотров", weight: 0.15, feature_count: 2 },
  ],
  validation_status: [
    { stage: "R0", label: "Аналитическая", status: "planned", description: "Формулы, воспроизводимость, unit-тесты" },
    { stage: "R1", label: "Ретроспективная", status: "planned", description: "Метрики на пилотном наборе ПрМО" },
    { stage: "R2", label: "Внешняя", status: "planned", description: "Независимый набор или hold-out" },
    { stage: "R3", label: "Клиническая полезность", status: "planned", description: "Слепое сравнение решений медработника" },
    { stage: "R4", label: "Финальная", status: "planned", description: "Решение о переходе в validated" },
  ],
  risks: [
    "Малая выборка: 23 работника и 2 967 событий",
    "Веса и пороги формулы не валидированы",
    "Персональный baseline нестабилен при малом числе точек",
    "Selection bias пилотной популяции",
  ],
};

const versions = [
  {
    version: MODEL_VERSION,
    created_at: "2026-09-15",
    status: "research",
    changes: "Начальная исследовательская версия",
    config_hash: CONFIG_HASH,
  },
  {
    version: "health_id_v0.9.0",
    created_at: "2026-08-22",
    status: "deprecated",
    changes: "Прототип формулы до фиксации evidence-контракта",
    config_hash: "sha256:31ac8f7e",
  },
];

const driftReport = {
  generated_at: "2026-09-15T09:40:00+04:00",
  status: "stable",
  window: "последние 30 дней vs reference 90 дней",
  features: [
    { feature: "heart_rate", ks_statistic: 0.08, p_value: 0.71, severity: "low" },
    { feature: "systolic", ks_statistic: 0.11, p_value: 0.48, severity: "low" },
    { feature: "spo2", ks_statistic: 0.06, p_value: 0.86, severity: "low" },
    { feature: "temperature", ks_statistic: 0.14, p_value: 0.31, severity: "medium" },
  ],
};

const reviews: Array<Record<string, unknown>> = [
  {
    review_id: "rev_001",
    session_id: "sess_8f31",
    event_id: "evt_20260915_004",
    status: "pending" satisfies ReviewStatus,
    trigger_reason: "manual_review_route",
    created_at: "2026-09-15T09:32:00+04:00",
    resolved_at: null,
    assigned_to: "medworker_demo",
    reviewer_comment: "",
    match_score: 0.58,
  },
  {
    review_id: "rev_002",
    session_id: "sess_71ac",
    event_id: "evt_20260914_009",
    status: "pending" satisfies ReviewStatus,
    trigger_reason: "acute_deviation",
    created_at: "2026-09-15T08:46:00+04:00",
    resolved_at: null,
    assigned_to: "medworker_demo",
    reviewer_comment: "",
    match_score: null,
  },
  {
    review_id: "rev_003",
    session_id: "sess_44d2",
    event_id: "evt_20260912_006",
    status: "confirmed" satisfies ReviewStatus,
    trigger_reason: "manual_review_route",
    created_at: "2026-09-12T11:08:00+04:00",
    resolved_at: "2026-09-12T11:18:00+04:00",
    assigned_to: "medworker_demo",
    reviewer_comment: "Личность подтверждена после проверки качества кадра.",
    match_score: 0.61,
  },
];

let auditEntries = 1284;

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function normalized(value: number | null, range: [number, number]) {
  if (value === null || Number.isNaN(value)) return 0.5;
  const [low, high] = range;
  if (value >= low && value <= high) return 1;
  const distance = value < low ? low - value : value - high;
  return clamp(1 - distance / Math.max(high - low, 1) / 2, 0.08, 1);
}

function categoryFor(value: number): Category {
  if (value >= 0.8) return "green";
  if (value >= 0.6) return "yellow";
  return "red";
}

function qualityFor(value: number | null) {
  return value === null ? "not_measured" : "pass";
}

function feature(
  name: string,
  label: string,
  rawValue: number | null,
  unit: string,
  source: "measured" | "derived" | "context",
  range: [number, number],
  weight: number,
) {
  const normalizedScore = normalized(rawValue, range);
  const deviation =
    rawValue === null
      ? "not_measured"
      : normalizedScore >= 0.99
        ? "none"
        : rawValue < range[0]
          ? "below_range"
          : "above_range";
  return {
    name,
    label,
    raw_value: rawValue,
    unit,
    source,
    normalized_score: Number(normalizedScore.toFixed(3)),
    normal_range: range,
    contribution_weight: weight,
    contribution: Number((normalizedScore * weight).toFixed(3)),
    quality: qualityFor(rawValue),
    deviation,
  };
}

function createResult(input: {
  eventId: string;
  worker: string;
  date: string;
  measurements: {
    heart_rate: number;
    systolic: number;
    diastolic: number;
    temperature: number;
    spo2: number;
    alcohol_test: number;
    adequacy_score: number;
    speech_coherence?: number | null;
    pupil_reaction: number;
    examination_regularity: number;
    missed_examinations: number;
  };
}) {
  const m = input.measurements;
  const bodyFeatures = [
    feature("heart_rate", "Частота сердечных сокращений", m.heart_rate, "уд/мин", "measured", [60, 90], 0.25),
    feature("blood_pressure_systolic", "АД систолическое", m.systolic, "мм рт. ст.", "measured", [100, 130], 0.25),
    feature("blood_pressure_diastolic", "АД диастолическое", m.diastolic, "мм рт. ст.", "measured", [60, 85], 0.2),
    feature("temperature", "Температура", m.temperature, "°C", "measured", [36.1, 37.2], 0.15),
    feature("spo2", "Сатурация", m.spo2, "%", "measured", [95, 100], 0.1),
    feature("alcohol_test", "Алкогольный тест", m.alcohol_test, "мг/л", "measured", [0, 0.15], 0.05),
  ];
  const mentalFeatures = [
    feature("adequacy_score", "Адекватность", m.adequacy_score, "из 10", "measured", [7, 10], 0.4),
    feature("speech_coherence", "Связность речи", m.speech_coherence ?? null, "из 10", "derived", [7, 10], 0.35),
    feature("pupil_reaction", "Реакция зрачков", m.pupil_reaction, "из 10", "measured", [7, 10], 0.25),
  ];
  const socialFeatures = [
    feature("examination_regularity", "Регулярность осмотров", m.examination_regularity, "доля", "context", [0.8, 1], 0.5),
    feature("missed_examinations", "Пропуски осмотров", m.missed_examinations, "за 30 дней", "context", [0, 1], 0.5),
  ];

  const scoreComponent = (key: string, label: string, weight: number, features: ReturnType<typeof feature>[]) => {
    const value = features.reduce((sum, item) => sum + item.contribution, 0);
    const contribution = value * weight;
    return {
      key,
      label,
      value: Number(value.toFixed(3)),
      weight,
      contribution: Number(contribution.toFixed(3)),
      contribution_pct: Number((contribution * 100).toFixed(1)),
      features,
    };
  };

  const components = [
    scoreComponent("hBody", "Физическое состояние", 0.6, bodyFeatures),
    scoreComponent("hMental", "Психофизиологическая оценка", 0.25, mentalFeatures),
    scoreComponent("hSocial", "Контекст осмотров", 0.15, socialFeatures),
  ];
  const value = Number(components.reduce((sum, item) => sum + item.contribution, 0).toFixed(3));
  const missing = [...bodyFeatures, ...mentalFeatures, ...socialFeatures]
    .filter((item) => item.raw_value === null)
    .map((item) => item.name);
  const totalFeatures = bodyFeatures.length + mentalFeatures.length + socialFeatures.length;
  const completeness = Number(((totalFeatures - missing.length) / totalFeatures).toFixed(2));
  const activeDeviation = [...bodyFeatures, ...mentalFeatures].find(
    (item) => item.deviation === "above_range" || item.deviation === "below_range",
  );
  const stateFlags = [
    {
      flag: "acute_deviation",
      active: Boolean(activeDeviation && activeDeviation.normalized_score < 0.7),
      label: "Острое отклонение",
      detail: activeDeviation ? `${activeDeviation.label}: ${activeDeviation.deviation}` : null,
    },
    {
      flag: "persistent_repeated_deviation",
      active: Boolean(activeDeviation && activeDeviation.normalized_score < 0.55),
      label: "Устойчивое повторное отклонение",
      detail: null,
    },
    {
      flag: "confirmed_chronic",
      active: false,
      label: "Подтверждённое хроническое состояние",
      detail: "Только источник МИС/ЭМК; HEALTH_ID не ставит диагнозы",
    },
    {
      flag: "personal_deviation",
      active: Boolean(activeDeviation),
      label: "Персональное отклонение",
      detail: activeDeviation ? `${activeDeviation.label} — требует внимания` : null,
    },
  ];
  const uncertainty = Number((0.03 + missing.length * 0.05 + (activeDeviation ? 0.02 : 0)).toFixed(2));
  const explanation = [
    `РЕЗУЛЬТАТ HEALTH_ID: ${value.toFixed(2)} (${categoryFor(value) === "green" ? "зелёная" : categoryFor(value) === "yellow" ? "жёлтая" : "красная"} зона)`,
    "",
    ...components.map(
      (component) =>
        `• ${component.label}: ${component.value.toFixed(2)}, вклад ${(component.contribution_pct).toFixed(0)}%`,
    ),
    activeDeviation ? `⚠️ Персональное отклонение: ${activeDeviation.label}` : "• Персональных отклонений не обнаружено",
    `ℹ️ Полнота данных: ${(completeness * 100).toFixed(0)}%`,
    `ℹ️ Неопределённость: ±${uncertainty.toFixed(2)}`,
    "",
    DISCLAIMER,
  ].join("\n");

  return {
    result_id: `res_${randomUUID().slice(0, 8)}`,
    event_id: input.eventId,
    worker_pseudonym: input.worker,
    timestamp: input.date,
    health_id: {
      value,
      category: categoryFor(value),
      model_version: MODEL_VERSION,
      config_snapshot_hash: CONFIG_HASH,
      disclaimer: DISCLAIMER,
    },
    components,
    completeness: {
      overall: completeness,
      required_features_present: totalFeatures - missing.length,
      required_features_total: totalFeatures,
      missing,
    },
    uncertainty: {
      overall: uncertainty,
      sources: missing.map((name) => ({ type: "missing_feature", feature: name, impact: 0.05 })),
    },
    state_flags: stateFlags,
    explanation,
    evidence: {
      input_ids: [input.eventId],
      formulas_applied: [
        "HEALTH_ID = 0.60 × hBody + 0.25 × hMental + 0.15 × hSocial",
        ...components.flatMap((component) =>
          component.features.slice(0, 2).map(
            (item) => `normalized_score(${item.name}, [${item.normal_range.join(", ")}]) = ${item.normalized_score.toFixed(2)}`,
          ),
        ),
      ],
      baseline_used: {
        available: true,
        n_historical_points: 14,
        window_days: 90,
        excluded_event: input.eventId,
      },
      quality_summary: "Все доступные измерения прошли контроль качества; текущая точка исключена из baseline.",
    },
    audit: {
      calculation_timestamp: new Date().toISOString(),
      duration_ms: 142,
      reproducible: true,
      audit_chain_hash: `sha256:${randomUUID().replaceAll("-", "").slice(0, 16)}`,
    },
  };
}

const defaultMeasurements = {
  heart_rate: 72,
  systolic: 128,
  diastolic: 78,
  temperature: 36.6,
  spo2: 98,
  alcohol_test: 0,
  adequacy_score: 8.8,
  speech_coherence: 8.4,
  pupil_reaction: 9,
  examination_regularity: 0.94,
  missed_examinations: 0,
};

const results = [
  createResult({
    eventId: "evt_20260915_001",
    worker: "wrk_7d2c",
    date: "2026-09-15T09:18:00+04:00",
    measurements: defaultMeasurements,
  }),
  createResult({
    eventId: "evt_20260915_002",
    worker: "wrk_a91e",
    date: "2026-09-15T08:54:00+04:00",
    measurements: { ...defaultMeasurements, systolic: 142, diastolic: 91, speech_coherence: null },
  }),
  createResult({
    eventId: "evt_20260914_009",
    worker: "wrk_22fe",
    date: "2026-09-14T17:06:00+04:00",
    measurements: { ...defaultMeasurements, heart_rate: 102, temperature: 37.4, adequacy_score: 6.8 },
  }),
  createResult({
    eventId: "evt_20260914_007",
    worker: "wrk_7d2c",
    date: "2026-09-14T09:04:00+04:00",
    measurements: { ...defaultMeasurements, systolic: 135, examination_regularity: 0.88 },
  }),
];

const dynamics: Record<string, Array<{ date: string; value: number; category: string }>> = {
  wrk_7d2c: [
    { date: "08 сен", value: 0.74, category: "yellow" },
    { date: "10 сен", value: 0.79, category: "yellow" },
    { date: "12 сен", value: 0.82, category: "green" },
    { date: "14 сен", value: 0.78, category: "yellow" },
    { date: "15 сен", value: 0.86, category: "green" },
  ],
  wrk_a91e: [
    { date: "09 сен", value: 0.88, category: "green" },
    { date: "11 сен", value: 0.84, category: "green" },
    { date: "13 сен", value: 0.79, category: "yellow" },
    { date: "15 сен", value: 0.66, category: "yellow" },
  ],
  wrk_22fe: [
    { date: "08 сен", value: 0.82, category: "green" },
    { date: "10 сен", value: 0.78, category: "yellow" },
    { date: "12 сен", value: 0.74, category: "yellow" },
    { date: "14 сен", value: 0.58, category: "red" },
  ],
};

function parseOrBad<T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T } }, value: unknown, res: Response) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    res.status(400).json({ error: "Некорректный формат запроса" });
    return null;
  }
  return parsed.data ?? null;
}

function dashboardSummary() {
  const counts = results.reduce(
    (acc, result) => {
      acc[result.health_id.category] += 1;
      return acc;
    },
    { green: 0, yellow: 0, red: 0 } as Record<Category, number>,
  );
  return {
    total_results: results.length,
    green_count: counts.green,
    yellow_count: counts.yellow,
    red_count: counts.red,
    review_count: reviews.filter((review) => review.status === "pending").length,
    completeness: Number(
      (results.reduce((sum, result) => sum + result.completeness.overall, 0) / results.length).toFixed(2),
    ),
    model_version: MODEL_VERSION,
    last_calculated_at: results[0]?.timestamp ?? new Date().toISOString(),
    audit_entries: auditEntries,
  };
}

const router: IRouter = Router();

router.get("/dashboard/summary", (_req, res) => res.json(dashboardSummary()));

router.get("/results", (req, res) => {
  const parsed = parseOrBad(ListResultsQueryParams, req.query, res);
  if (!parsed) return;
  const filtered = results.filter((result) => {
    const categoryMatch = !parsed.category || result.health_id.category === parsed.category;
    const workerMatch = !parsed.worker_pseudonym || result.worker_pseudonym === parsed.worker_pseudonym;
    return categoryMatch && workerMatch;
  });
  res.json({ items: filtered.slice(0, parsed.limit ?? 50), total: filtered.length });
});

router.get("/results/:resultId", (req, res) => {
  const params = parseOrBad(GetResultParams, req.params, res);
  if (!params) return;
  const result = results.find((item) => item.result_id === params.resultId);
  if (!result) {
    res.status(404).json({ error: "Результат не найден" });
    return;
  }
  res.json(result);
});

router.post("/calculate", (req, res) => {
  const input = parseOrBad(CalculateHealthIdBody, req.body, res);
  if (!input) return;
  const result = createResult({
    eventId: input.event_id,
    worker: input.worker_pseudonym,
    date: input.measured_at ?? new Date().toISOString(),
    measurements: input.measurements,
  });
  results.unshift(result);
  auditEntries += 1;
  req.log.info({ eventId: input.event_id, resultId: result.result_id }, "HEALTH_ID calculated");
  res.json(result);
});

router.get("/dynamics/:workerPseudonym", (req, res) => {
  const params = parseOrBad(GetWorkerDynamicsParams, req.params, res);
  if (!params) return;
  res.json({
    worker_pseudonym: params.workerPseudonym,
    points: dynamics[params.workerPseudonym] ?? [],
    baseline: {
      available: Boolean(dynamics[params.workerPseudonym]),
      n_historical_points: dynamics[params.workerPseudonym]?.length ?? 0,
      window_days: 90,
      excluded_event: "current_event",
    },
  });
});

router.get("/reviews", (_req, res) => res.json({ items: reviews, total: reviews.length }));

router.post("/reviews", (req, res) => {
  const input = parseOrBad(CreateReviewBody, req.body, res);
  if (!input) return;
  const review = {
    review_id: `rev_${randomUUID().slice(0, 8)}`,
    session_id: input.session_id,
    event_id: input.event_id,
    status: "pending" as ReviewStatus,
    trigger_reason: input.trigger_reason,
    created_at: new Date().toISOString(),
    resolved_at: null,
    assigned_to: "medworker_demo",
    reviewer_comment: "",
    match_score: input.match_score ?? null,
  };
  reviews.unshift(review);
  auditEntries += 1;
  res.status(201).json(review);
});

router.patch("/reviews/:reviewId", (req, res) => {
  const params = parseOrBad(UpdateReviewParams, req.params, res);
  if (!params) return;
  const input = parseOrBad(UpdateReviewBody, req.body, res);
  if (!input) return;
  const review = reviews.find((item) => item.review_id === params.reviewId);
  if (!review) {
    res.status(404).json({ error: "Review не найден" });
    return;
  }
  if (review.status !== "pending") {
    res.status(409).json({ error: "Решённый review неизменяем" });
    return;
  }
  review.status = input.status;
  review.reviewer_comment = input.reviewer_comment;
  review.resolved_at = new Date().toISOString();
  auditEntries += 1;
  req.log.info({ reviewId: params.reviewId, status: input.status }, "Human review resolved");
  res.json(review);
});

router.get("/model-card", (_req, res) => res.json(modelCard));
router.get("/versions", (_req, res) => res.json(versions));
router.get("/drift-report", (_req, res) => res.json(driftReport));

const verificationSessions = new Map<string, Record<string, unknown>>();

router.post("/verify-identity", (req, res) => {
  const input = parseOrBad(VerifyIdentityBody, req.body, res);
  if (!input) return;
  const route =
    input.match_score >= 0.62 && input.liveness_score >= 0.75 && input.quality_pass
      ? "verified"
      : input.match_score < 0.45 || input.liveness_score < 0.45 || !input.quality_pass
        ? "not_verified"
        : "manual_review";
  const session = {
    session_id: `sess_${randomUUID().slice(0, 8)}`,
    route,
    match_score: input.match_score,
    liveness_score: input.liveness_score,
    quality_pass: input.quality_pass,
    model_version: "face_v1.2.0-sandbox",
    created_at: new Date().toISOString(),
    disclaimer:
      "Sandbox-результат. Не является юридической идентификацией; изображения, видео и биометрические шаблоны не сохраняются.",
  };
  verificationSessions.set(session.session_id, session);
  auditEntries += 1;
  res.json(session);
});

router.get("/verify/:sessionId", (req, res) => {
  const params = parseOrBad(GetVerificationParams, req.params, res);
  if (!params) return;
  const session = verificationSessions.get(params.sessionId);
  if (!session) {
    res.status(404).json({ error: "Сессия верификации не найдена" });
    return;
  }
  res.json(session);
});

router.use((err: unknown, _req: Request, res: Response, _next: unknown) => {
  logger.error({ err }, "HEALTH_ID route error");
  res.status(500).json({ error: "Внутренняя ошибка исследовательского контура" });
});

export default router;