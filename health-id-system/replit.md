# HEALTH_ID Research Module

Исследовательская консоль для дистанционных периодических медосмотров: воспроизводимый расчёт HEALTH_ID, персональные baseline-коридоры, human review, sandbox-верификация и governance модели.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/health-id-console/` — основное веб-приложение и research console.
- `artifacts/api-server/src/routes/health-id.ts` — демо API и исследовательская логика на обезличенных данных.
- `lib/api-spec/openapi.yaml` — единый источник API-контрактов.
- `lib/api-client-react/src/generated/` — сгенерированные React Query hooks и типы.
- `screenshots/health-id-console-dashboard.jpg` — проверенный снимок dashboard.

## Architecture decisions

- Все результаты маркируются как `research`; HEALTH_ID не используется для диагноза или решения о допуске.
- Биометрия реализована только как sandbox-адаптер с числовыми score: изображения, видео и шаблоны не сохраняются.
- Текущая точка явно исключена из baseline; evidence-контракт сохраняет `excluded_event`, конфигурационный hash и trace формул.
- Медицинский и корпоративный контуры разделены на уровне контракта: API отдаёт псевдонимы и статусы, а не ФИО или рабочие решения.
- Для первого инкремента используется детерминированный in-memory демо-набор; подключение PostgreSQL и реальных ML-провайдеров остаётся отдельным production-этапом.

## Product

- Dashboard с completeness, распределением сигналов, review queue и audit entries.
- Ledger результатов с фильтрами, деталями компонентов, uncertainty, state flags, baseline и evidence trace.
- Очередь human review с обязательным комментарием и неизменяемым resolved-статусом.
- Sandbox identity verification с маршрутизацией `verified` / `manual_review` / `not_verified`.
- Governance экран с model card, версиями, R0–R4 и отчётом о drift.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- После изменения `lib/api-spec/openapi.yaml` запускать `pnpm --filter @workspace/api-spec run codegen`.
- Сервисы запускаются только через managed workflows; для API запросы идут через прокси `/api`.
- Перед переходом от research к production необходимо заменить in-memory хранилище, sandbox-верификацию и демонстрационные модели на защищённые контуры и валидированные провайдеры.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
