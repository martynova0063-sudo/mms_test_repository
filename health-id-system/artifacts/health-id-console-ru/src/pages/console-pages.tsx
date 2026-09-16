import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleHelp,
  FileCheck2,
  GitBranch,
  Info,
  LockKeyhole,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  UserRoundCheck,
  X,
} from 'lucide-react';
import {
  getGetResultQueryKey,
  getGetVerificationQueryKey,
  getListReviewsQueryKey,
  getListResultsQueryKey,
  useCalculateHealthId,
  useCreateReview,
  useGetDashboardSummary,
  useGetDriftReport,
  useGetModelCard,
  useGetResult,
  useGetVerification,
  useGetWorkerDynamics,
  useListModelVersions,
  useListResults,
  useListReviews,
  useUpdateReview,
  useVerifyIdentity,
} from '@workspace/api-client-react';
import type { HealthResult, Review } from '@workspace/api-client-react';

const fmt = (value?: string | null) =>
  value
    ? new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
    : '—';
const pct = (value?: number) => `${Math.round((value ?? 0) * 100)}%`;
const score = (value?: number) => (typeof value === 'number' ? value.toFixed(2) : '—');

function PageTitle({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-col justify-between gap-5 border-b border-border pb-7 lg:flex-row lg:items-end">
      <div>
        <div className="mono mb-2 text-[10px] font-medium uppercase tracking-[.18em] text-primary">{eyebrow}</div>
        <h1 className="display text-4xl font-semibold text-foreground md:text-5xl">{title}</h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}

function LoadingRows({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="h-14 animate-pulse bg-muted/70" />
      ))}
    </div>
  );
}

function ErrorState({ message = 'Исследовательский API не смог вернуть этот экран.' }: { message?: string }) {
  return (
    <div className="border border-destructive/30 bg-destructive/5 p-5 text-sm">
      <div className="flex items-center gap-2 font-semibold text-destructive">
        <AlertTriangle size={16} />
        Данные недоступны
      </div>
      <p className="mt-2 text-muted-foreground">{message}</p>
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="border border-dashed border-border bg-card p-10 text-center">
      <CircleHelp className="mx-auto mb-3 text-muted-foreground" size={24} />
      <p className="font-semibold">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

function Stat({
  label,
  value,
  detail,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  detail: string;
  tone?: 'default' | 'green' | 'yellow' | 'red';
}) {
  return (
    <div
      className={`border border-border bg-card p-5 ${
        tone === 'green'
          ? 'border-t-2 border-t-primary'
          : tone === 'yellow'
            ? 'border-t-2 border-t-accent'
            : tone === 'red'
              ? 'border-t-2 border-t-destructive'
              : ''
      }`}
    >
      <p className="text-[10px] font-bold uppercase tracking-[.16em] text-muted-foreground">{label}</p>
      <p className="display mt-3 text-3xl font-semibold">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function CategoryBadge({ category }: { category?: string }) {
  const value = category?.toLowerCase();
  const label = value === 'green' ? 'зелёная' : value === 'yellow' ? 'жёлтая' : value === 'red' ? 'красная' : 'неизвестно';
  return (
    <span
      className={`inline-flex items-center gap-2 border px-2 py-1 text-[10px] font-bold uppercase tracking-[.1em] ${
        value === 'green'
          ? 'border-primary/30 bg-primary/10 text-primary'
          : value === 'yellow'
            ? 'border-accent/40 bg-accent/15 text-foreground'
            : value === 'red'
              ? 'border-destructive/30 bg-destructive/10 text-destructive'
              : 'border-border bg-muted text-muted-foreground'
      }`}
    >
      <span
        className={`status-dot ${
          value === 'green' ? 'status-green' : value === 'yellow' ? 'status-yellow' : value === 'red' ? 'status-red' : 'status-muted'
        }`}
      />
      {label}
    </span>
  );
}

export function DashboardPage() {
  const summary = useGetDashboardSummary();
  const reviews = useListReviews();
  const results = useListResults({ limit: 8 });
  const s = summary.data;

  return (
    <div className="rise">
      <PageTitle
        eyebrow="Исследовательские операции / обзор"
        title="Сигнал, а не заключение."
        description="Контролируемый обзор объяснимых результатов HEALTH_ID в исследовании дистанционных осмотров. Каждый показатель — исследовательский сигнал с видимой неопределённостью."
        action={
          <Link href="/results" className="flex items-center gap-2 bg-primary px-4 py-3 text-xs font-bold text-primary-foreground hover:opacity-90">
            Открыть журнал результатов <ArrowUpRight size={15} />
          </Link>
        }
      />
      <div className="mb-6 flex items-start gap-3 border border-accent/40 bg-accent/10 p-4 text-sm">
        <Info size={17} className="mt-0.5 shrink-0 text-foreground" />
        <div>
          <span className="font-semibold">Только исследовательский контур.</span> HEALTH_ID не ставит диагнозы, не определяет пригодность к работе и не заменяет клиническое решение. Данные корпоративной идентичности отделены от медицинских свидетельств.
        </div>
      </div>
      {summary.isLoading ? (
        <LoadingRows count={2} />
      ) : summary.isError ? (
        <ErrorState />
      ) : (
        <>
          <QuickCalculation />
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <Stat label="Рассчитано результатов" value={s?.total_results ?? 0} detail={`Модель ${s?.model_version ?? '—'}`} />
            <Stat label="Зелёный сигнал" value={s?.green_count ?? 0} detail="В ожидаемом диапазоне" tone="green" />
            <Stat label="Жёлтый сигнал" value={s?.yellow_count ?? 0} detail="Требует интерпретации" tone="yellow" />
            <Stat label="Красный сигнал" value={s?.red_count ?? 0} detail="Только индикатор эскалации" tone="red" />
            <Stat label="Открытые проверки" value={s?.review_count ?? 0} detail="Очередь ручной проверки" />
          </div>
          <div className="mt-6 grid gap-6 xl:grid-cols-[1.25fr_.75fr]">
            <section className="border border-border bg-card p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="mono text-[10px] uppercase tracking-[.16em] text-primary">Целостность набора</p>
                  <h2 className="mt-1 text-lg font-bold">Полнота рассчитанных результатов</h2>
                </div>
                <span className="display text-3xl font-semibold">{pct(s?.completeness)}</span>
              </div>
              <div className="mt-6 h-3 bg-muted">
                <div className="h-full bg-primary transition-all" style={{ width: `${(s?.completeness ?? 0) * 100}%` }} />
              </div>
              <div className="mt-4 flex justify-between text-xs text-muted-foreground">
                <span>Обязательные входные данные на месте</span>
                <span>Последний расчёт {fmt(s?.last_calculated_at)}</span>
              </div>
              <div className="mt-8 grid grid-cols-2 gap-3">
                <div className="bg-muted/60 p-4">
                  <p className="mono text-[10px] uppercase text-muted-foreground">Записи аудита</p>
                  <p className="mt-2 text-2xl font-semibold">{s?.audit_entries ?? 0}</p>
                </div>
                <div className="bg-muted/60 p-4">
                  <p className="mono text-[10px] uppercase text-muted-foreground">Текущая модель</p>
                  <p className="mt-2 text-2xl font-semibold">{s?.model_version ?? '—'}</p>
                </div>
              </div>
            </section>
            <section className="border border-border bg-card p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="mono text-[10px] uppercase tracking-[.16em] text-primary">Участие человека</p>
                  <h2 className="mt-1 text-lg font-bold">Очередь проверки</h2>
                </div>
                <Link href="/reviews" className="text-xs font-bold text-primary">Открыть очередь <ArrowUpRight className="inline" size={13} /></Link>
              </div>
              {reviews.isLoading ? (
                <div className="mt-5"><LoadingRows count={3} /></div>
              ) : reviews.data?.items?.length ? (
                <div className="mt-5 space-y-3">
                  {reviews.data.items.slice(0, 4).map((r) => (
                    <div key={r.review_id} className="flex items-center justify-between border-b border-border pb-3 text-sm">
                      <div><p className="font-semibold">{r.trigger_reason}</p><p className="mono mt-1 text-[10px] text-muted-foreground">{r.event_id} · {fmt(r.created_at)}</p></div>
                      <span className="text-[10px] font-bold uppercase text-accent-foreground">{r.status === 'pending' ? 'ожидает' : r.status === 'confirmed' ? 'подтверждено' : 'отклонено'}</span>
                    </div>
                  ))}
                </div>
              ) : <EmptyState title="Нет случаев для проверки" body="За выбранное окно очередь пуста." />}
            </section>
          </div>
          <section className="mt-6 border border-border bg-card p-6">
            <div className="mb-5 flex items-center justify-between">
              <div><p className="mono text-[10px] uppercase tracking-[.16em] text-primary">Последняя активность</p><h2 className="mt-1 text-lg font-bold">Журнал результатов</h2></div>
              <span className="mono text-[10px] text-muted-foreground">ТОЛЬКО ПРОСМОТР</span>
            </div>
            {results.isLoading ? <LoadingRows /> : results.isError ? <ErrorState /> : results.data?.items?.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[680px] text-left text-sm">
                  <thead className="border-b border-border text-[10px] uppercase tracking-[.14em] text-muted-foreground"><tr><th className="pb-3">Результат</th><th className="pb-3">Псевдоним</th><th className="pb-3">Сигнал</th><th className="pb-3">Полнота</th><th className="pb-3">Рассчитан</th></tr></thead>
                  <tbody>{results.data.items.slice(0, 6).map((r) => <tr key={r.result_id} className="border-b border-border/70"><td className="py-4"><Link href={`/results?result=${r.result_id}`} className="mono text-xs font-medium text-primary hover:underline">{r.result_id}</Link></td><td className="py-4 mono text-xs">{r.worker_pseudonym}</td><td className="py-4"><CategoryBadge category={r.health_id.category} /></td><td className="py-4 mono text-xs">{pct(r.completeness.overall)}</td><td className="py-4 text-xs text-muted-foreground">{fmt(r.timestamp)}</td></tr>)}</tbody>
                </table>
              </div>
            ) : <EmptyState title="Нет рассчитанных результатов" body="Результаты появятся после оценки первого исследовательского события." />}
          </section>
        </>
      )}
    </div>
  );
}

function QuickCalculation() {
  const qc = useQueryClient();
  const calculate = useCalculateHealthId();
  const [eventId, setEventId] = useState('');
  const [worker, setWorker] = useState('');
  const [result, setResult] = useState<HealthResult | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    calculate.mutate(
      { data: { event_id: eventId, worker_pseudonym: worker, measurements: { heart_rate: 72, systolic: 120, diastolic: 78, temperature: 36.6, spo2: 98, alcohol_test: 0, adequacy_score: 1, speech_coherence: null, pupil_reaction: 1, examination_regularity: 1, missed_examinations: 0 } } },
      { onSuccess: (value) => { setResult(value); qc.invalidateQueries({ queryKey: getListResultsQueryKey({ limit: 100 }) }); } },
    );
  };
  return (
    <details className="group mb-6 border border-primary/25 bg-primary/5">
      <summary className="flex cursor-pointer list-none items-center justify-between p-4"><span><span className="mono text-[10px] uppercase tracking-[.16em] text-primary">Лаборатория расчёта</span><span className="ml-3 text-sm font-semibold">Рассчитать исследовательское событие</span></span><ChevronDown size={16} className="transition-transform group-open:rotate-180" /></summary>
      <form onSubmit={submit} className="grid gap-3 border-t border-primary/20 p-4 sm:grid-cols-[1fr_1fr_auto]">
        <input required value={eventId} onChange={(e) => setEventId(e.target.value)} placeholder="ID события" className="border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary" />
        <input required value={worker} onChange={(e) => setWorker(e.target.value)} placeholder="Псевдоним работника" className="border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary" />
        <button disabled={calculate.isPending} className="flex items-center justify-center gap-2 bg-primary px-4 py-2 text-xs font-bold text-primary-foreground disabled:opacity-50"><Sparkles size={14} />{calculate.isPending ? 'Расчёт…' : 'Рассчитать HEALTH_ID'}</button>
        {result && <div className="flex items-center gap-3 border-t border-primary/20 pt-3 text-sm sm:col-span-3"><span className="font-semibold">Новый результат: {result.health_id.value.toFixed(2)}</span><CategoryBadge category={result.health_id.category} /><span className="text-muted-foreground">{result.health_id.disclaimer}</span></div>}
      </form>
    </details>
  );
}

export function ResultsPage() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<'green' | 'yellow' | 'red' | undefined>();
  const [selected, setSelected] = useState<string | null>(null);
  const params = useMemo(() => ({ limit: 100, ...(category ? { category } : {}) }), [category]);
  const list = useListResults(params);
  const items = useMemo(() => (list.data?.items ?? []).filter((r) => `${r.result_id} ${r.event_id} ${r.worker_pseudonym}`.toLowerCase().includes(query.toLowerCase())), [list.data?.items, query]);
  const chosenId = selected ?? items[0]?.result_id ?? '';
  const detail = useGetResult(chosenId, { query: { enabled: !!chosenId, queryKey: getGetResultQueryKey(chosenId) } });
  const createReview = useCreateReview();
  const dynamics = useGetWorkerDynamics(detail.data?.worker_pseudonym ?? '', { query: { enabled: !!detail.data?.worker_pseudonym, queryKey: [`/api/dynamics/${detail.data?.worker_pseudonym}`] } });
  const qc = useQueryClient();
  const createCase = () => { if (detail.data) createReview.mutate({ data: { event_id: detail.data.event_id, session_id: detail.data.event_id, trigger_reason: 'Проверка по запросу аналитика' } }, { onSuccess: () => qc.invalidateQueries({ queryKey: getListReviewsQueryKey() }) }); };
  return (
    <div className="rise">
      <PageTitle eyebrow="Журнал свидетельств / результаты" title="Результаты HEALTH_ID" description="Ищите рассчитанные события и прослеживайте каждый сигнал до вкладов компонентов, признаков и аудита." action={<button onClick={() => list.refetch()} className="flex items-center gap-2 border border-border bg-card px-4 py-3 text-xs font-bold hover:bg-muted"><RefreshCw size={14} /> Обновить журнал</button>} />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,.85fr)_minmax(0,1.4fr)]">
        <section className="min-h-[600px] border border-border bg-card">
          <div className="border-b border-border p-4"><div className="relative"><Search size={15} className="absolute left-3 top-3 text-muted-foreground" /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по результату, событию, псевдониму" className="w-full border border-input bg-background py-2.5 pl-9 pr-3 text-sm outline-none focus:border-primary" /></div><div className="mt-3 flex gap-2 overflow-x-auto"><button onClick={() => setCategory(undefined)} className={`whitespace-nowrap border px-3 py-2 text-[10px] font-bold uppercase ${!category ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'}`}>Все сигналы</button>{(['green', 'yellow', 'red'] as const).map((c) => <button key={c} onClick={() => setCategory(c)} className={`whitespace-nowrap border px-3 py-2 text-[10px] font-bold uppercase ${category === c ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'}`}>{c === 'green' ? 'зелёный' : c === 'yellow' ? 'жёлтый' : 'красный'}</button>)}</div></div>
          {list.isLoading ? <div className="p-4"><LoadingRows count={6} /></div> : list.isError ? <div className="p-4"><ErrorState /></div> : items.length ? <div>{items.map((r) => <button key={r.result_id} onClick={() => setSelected(r.result_id)} className={`flex w-full items-center justify-between border-b border-border p-4 text-left hover:bg-muted/60 ${chosenId === r.result_id ? 'border-l-2 border-l-primary bg-primary/5' : ''}`}><div><p className="mono text-xs font-semibold text-primary">{r.result_id}</p><p className="mt-1 text-sm font-semibold">{r.worker_pseudonym}</p><p className="mono mt-1 text-[10px] text-muted-foreground">{r.event_id} · {fmt(r.timestamp)}</p></div><div className="text-right"><CategoryBadge category={r.health_id.category} /><p className="mono mt-2 text-[10px] text-muted-foreground">{pct(r.completeness.overall)} полноты</p></div></button>)}</div> : <div className="p-4"><EmptyState title="Совпадений нет" body="Попробуйте другой псевдоним, ID события или фильтр сигнала." /></div>}
        </section>
        <section>{detail.isLoading ? <div className="border border-border bg-card p-6"><LoadingRows count={5} /></div> : detail.isError || !detail.data ? <EmptyState title="Выберите результат" body="Выберите событие в журнале, чтобы изучить цепочку свидетельств." /> : <ResultDetail result={detail.data} dynamics={dynamics.data} onCreateReview={createCase} reviewPending={createReview.isPending} />}</section>
      </div>
    </div>
  );
}

function ResultDetail({ result, dynamics, onCreateReview, reviewPending }: { result: HealthResult; dynamics?: { points: { date: string; value: number; category: string }[]; baseline: { available: boolean; n_historical_points: number } }; onCreateReview: () => void; reviewPending: boolean }) {
  return (
    <div className="space-y-5">
      <div className="border border-border bg-card p-6">
        <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-start">
          <div>
            <p className="mono text-[10px] uppercase tracking-[.16em] text-primary">Выбранный результат</p>
            <p className="mono mt-2 text-xs text-muted-foreground">{result.result_id} · {result.event_id}</p>
            <div className="mt-4 flex items-end gap-5"><p className="display text-6xl font-semibold">{score(result.health_id.value)}</p><CategoryBadge category={result.health_id.category} /></div>
            <p className="mt-3 max-w-xl whitespace-pre-line text-sm text-muted-foreground">{result.explanation}</p>
          </div>
          <button onClick={onCreateReview} disabled={reviewPending} className="flex items-center justify-center gap-2 border border-primary px-4 py-3 text-xs font-bold text-primary hover:bg-primary/10 disabled:opacity-50"><FileCheck2 size={14} />{reviewPending ? 'Открытие дела…' : 'Передать на проверку'}</button>
        </div>
        <div className="mt-6 grid gap-3 sm:grid-cols-3"><Stat label="Неопределённость" value={pct(result.uncertainty.overall)} detail="оценка сигнала" /><Stat label="Полнота" value={pct(result.completeness.overall)} detail="входные данные" /><Stat label="Версия модели" value={result.health_id.model_version} detail="зафиксированная версия" /></div>
      </div>
      <div className="border border-border bg-card p-6">
        <div className="mb-5 flex items-center justify-between"><div><p className="mono text-[10px] uppercase tracking-[.16em] text-primary">Цепочка атрибуции</p><h2 className="mt-1 text-lg font-bold">Вклады компонентов</h2></div><span className="text-xs text-muted-foreground">{result.components.length} компонента</span></div>
        <div className="space-y-5">{result.components.map((c) => <div key={c.key}><div className="flex items-center justify-between text-sm"><span className="font-semibold">{c.label}</span><span className="mono text-xs">{c.contribution_pct.toFixed(1)}%</span></div><div className="mt-2 h-2 bg-muted"><div className={`h-full ${c.contribution >= 0 ? 'bg-primary' : 'bg-destructive'}`} style={{ width: `${Math.min(Math.abs(c.contribution_pct), 100)}%` }} /></div><div className="mt-2 flex flex-wrap gap-2">{c.features.map((f) => <span key={f.name} className="border border-border px-2 py-1 text-[10px] text-muted-foreground">{f.label}: <b className="text-foreground">{f.raw_value ?? 'нет данных'} {f.unit}</b></span>)}</div></div>)}</div>
      </div>
      <div className="grid gap-5 md:grid-cols-2">
        <div className="border border-border bg-card p-6">
          <p className="mono text-[10px] uppercase tracking-[.16em] text-primary">Журнал свидетельств</p>
          <h2 className="mt-1 text-lg font-bold">Входные данные и воспроизводимость</h2>
          <dl className="mt-5 space-y-3 text-sm">
            <div className="flex justify-between gap-4 border-b border-border pb-2"><dt className="text-muted-foreground">ID входных данных</dt><dd className="mono text-right text-xs">{result.evidence.input_ids.join(', ') || 'Не записаны'}</dd></div>
            <div className="flex justify-between gap-4 border-b border-border pb-2"><dt className="text-muted-foreground">Baseline</dt><dd className="text-right text-xs">{result.evidence.baseline_used.available ? `${result.evidence.baseline_used.n_historical_points} точек / ${result.evidence.baseline_used.window_days} дней` : 'Недоступен'}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Цепочка аудита</dt><dd className="mono max-w-[190px] truncate text-right text-xs">{result.audit.audit_chain_hash}</dd></div>
          </dl>
          <p className="mt-5 border-l-2 border-primary pl-3 text-xs leading-relaxed text-muted-foreground">{result.evidence.quality_summary}</p>
        </div>
        <div className="border border-border bg-card p-6">
          <p className="mono text-[10px] uppercase tracking-[.16em] text-primary">Состояние и история</p>
          <h2 className="mt-1 text-lg font-bold">Контекстные флаги</h2>
          <div className="mt-5 space-y-2">{result.state_flags.map((f) => <div key={f.flag} className="flex items-start gap-2 text-sm"><span className={`mt-1 status-dot ${f.active ? 'status-yellow' : 'status-muted'}`} /><div><p className="font-semibold">{f.label}</p>{f.detail && <p className="text-xs text-muted-foreground">{f.detail}</p>}</div></div>)}</div>
          {dynamics && <div className="mt-5 border-t border-border pt-4 text-xs text-muted-foreground"><span className="font-semibold text-foreground">Динамика:</span> {dynamics.points.length} исторических точек, baseline {dynamics.baseline.available ? 'доступен' : 'недоступен'}.</div>}
        </div>
      </div>
    </div>
  );
}

export function ReviewsPage() {
  const qc = useQueryClient();
  const reviews = useListReviews();
  const update = useUpdateReview();
  const [comment, setComment] = useState<Record<string, string>>({});
  const resolve = (r: Review, status: 'confirmed' | 'rejected') => update.mutate({ reviewId: r.review_id, data: { status, reviewer_comment: comment[r.review_id] || (status === 'confirmed' ? 'Подтверждено проверяющим.' : 'Отклонено проверяющим.') } }, { onSuccess: () => qc.invalidateQueries({ queryKey: getListReviewsQueryKey() }) });
  return (
    <div className="rise">
      <PageTitle eyebrow="Участие человека / очередь" title="Очередь проверки" description="Результаты модели, которым требуется решение человека. Решения становятся неизменяемыми после записи в аудит." action={<div className="flex items-center gap-2 border border-accent/40 bg-accent/10 px-3 py-2 text-[10px] font-bold uppercase"><LockKeyhole size={14} /> Решения необратимы</div>} />
      {reviews.isLoading ? <LoadingRows count={5} /> : reviews.isError ? <ErrorState /> : !reviews.data?.items?.length ? <EmptyState title="Очередь пуста" body="Нет случаев, ожидающих ручной проверки." /> : <div className="space-y-4">{reviews.data.items.map((r) => <div key={r.review_id} className={`border bg-card p-5 ${r.status === 'pending' ? 'border-accent/50' : 'border-border opacity-80'}`}><div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start"><div><div className="flex flex-wrap items-center gap-3"><span className="mono text-xs text-primary">{r.review_id}</span><span className={`border px-2 py-1 text-[10px] font-bold uppercase ${r.status === 'pending' ? 'border-accent/50 bg-accent/10' : 'border-border bg-muted'}`}>{r.status === 'pending' ? 'ожидает' : r.status === 'confirmed' ? 'подтверждено' : 'отклонено'}</span></div><h2 className="mt-3 text-lg font-bold">{r.trigger_reason}</h2><p className="mono mt-2 text-xs text-muted-foreground">Событие {r.event_id} · сессия {r.session_id} · назначено: {r.assigned_to || 'не назначено'}</p></div>{r.match_score != null && <div className="text-left lg:text-right"><p className="mono text-[10px] uppercase text-muted-foreground">Оценка совпадения</p><p className="display text-3xl font-semibold">{score(r.match_score)}</p></div>}</div>{r.status === 'pending' ? <div className="mt-5 flex flex-col gap-3 border-t border-border pt-4 lg:flex-row"><input value={comment[r.review_id] ?? ''} onChange={(e) => setComment((old) => ({ ...old, [r.review_id]: e.target.value }))} placeholder="Комментарий проверяющего обязателен" className="min-w-0 flex-1 border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary" /><button onClick={() => resolve(r, 'confirmed')} disabled={update.isPending || !comment[r.review_id]?.trim()} className="flex items-center justify-center gap-2 border border-primary px-4 py-2 text-xs font-bold text-primary hover:bg-primary/10 disabled:opacity-50"><Check size={15} /> Подтвердить</button><button onClick={() => resolve(r, 'rejected')} disabled={update.isPending || !comment[r.review_id]?.trim()} className="flex items-center justify-center gap-2 border border-destructive px-4 py-2 text-xs font-bold text-destructive hover:bg-destructive/10 disabled:opacity-50"><X size={15} /> Отклонить</button></div> : <div className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">Решено {fmt(r.resolved_at)}{r.reviewer_comment ? ` · ${r.reviewer_comment}` : ''}</div>}</div>)}</div>}
    </div>
  );
}

export function VerificationPage() {
  const verify = useVerifyIdentity();
  const [worker, setWorker] = useState('');
  const [match, setMatch] = useState('0.86');
  const [live, setLive] = useState('0.91');
  const [quality, setQuality] = useState(true);
  const [session, setSession] = useState('');
  const [recentSessions, setRecentSessions] = useState<string[]>([]);
  const detail = useGetVerification(session, { query: { enabled: !!session, queryKey: getGetVerificationQueryKey(session) } });
  const run = (e: FormEvent) => { e.preventDefault(); verify.mutate({ data: { worker_pseudonym: worker, match_score: Number(match), liveness_score: Number(live), quality_pass: quality, active_liveness: true } }, { onSuccess: (value) => { setSession(value.session_id); setRecentSessions((old) => [value.session_id, ...old.filter((id) => id !== value.session_id)].slice(0, 5)); } }); };
  return (
    <div className="rise">
      <PageTitle eyebrow="Песочница / маршрут идентичности" title="Ограниченная верификация." description="Непроизводственная песочница для оценки маршрутизации идентичности рядом с медицинским сигналом. Это не юридическая идентификация, биометрические данные не хранятся." action={<div className="flex items-center gap-2 border border-primary/30 bg-primary/10 px-3 py-2 text-[10px] font-bold uppercase text-primary"><ShieldAlert size={14} /> Биометрия не хранится</div>} />
      <div className="mb-6 grid gap-4 md:grid-cols-3"><div className="border border-border bg-card p-4"><LockKeyhole className="text-primary" size={18} /><p className="mt-4 font-semibold">Только псевдоним</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Используйте псевдоним исследования, а не государственный идентификатор.</p></div><div className="border border-border bg-card p-4"><Activity className="text-primary" size={18} /><p className="mt-4 font-semibold">Смоделированные оценки</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Поля ниже представляют результаты модели песочницы.</p></div><div className="border border-border bg-card p-4"><FileCheck2 className="text-primary" size={18} /><p className="mt-4 font-semibold">Маршрут аудируется</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Каждый ответ содержит ссылку на сессию и версию модели.</p></div></div>
      <div className="grid gap-5 xl:grid-cols-[.9fr_1.1fr]">
        <form onSubmit={run} className="border border-border bg-card p-6"><p className="mono text-[10px] uppercase tracking-[.16em] text-primary">Запуск сессии песочницы</p><h2 className="mt-1 text-lg font-bold">Входные данные маршрута</h2><label className="mt-6 block text-xs font-semibold">Псевдоним работника<input required value={worker} onChange={(e) => setWorker(e.target.value)} placeholder="WRK-042" className="mt-2 w-full border border-input bg-background px-3 py-3 text-sm outline-none focus:border-primary" /></label><div className="mt-4 grid gap-4 sm:grid-cols-2"><label className="text-xs font-semibold">Оценка совпадения<input type="number" min="0" max="1" step=".01" value={match} onChange={(e) => setMatch(e.target.value)} className="mono mt-2 w-full border border-input bg-background px-3 py-3 text-sm outline-none focus:border-primary" /></label><label className="text-xs font-semibold">Оценка живости<input type="number" min="0" max="1" step=".01" value={live} onChange={(e) => setLive(e.target.value)} className="mono mt-2 w-full border border-input bg-background px-3 py-3 text-sm outline-none focus:border-primary" /></label></div><label className="mt-5 flex items-center gap-3 text-sm"><input type="checkbox" checked={quality} onChange={(e) => setQuality(e.target.checked)} className="accent-[hsl(var(--primary))]" /> Проверки качества изображения пройдены <span className="text-xs text-muted-foreground">(только метаданные)</span></label><button disabled={verify.isPending} className="mt-7 flex w-full items-center justify-center gap-2 bg-primary px-4 py-3 text-xs font-bold text-primary-foreground disabled:opacity-50">{verify.isPending ? 'Запуск маршрута…' : 'Запустить верификацию'} <ArrowUpRight size={14} /></button>{verify.isError && <p className="mt-3 text-xs text-destructive">Запрос песочницы не выполнен. Проверьте поля и повторите попытку.</p>}</form>
        <div className="border border-border bg-card p-6">{detail.isLoading ? <LoadingRows count={4} /> : detail.data ? <div><div className="flex items-center justify-between"><div><p className="mono text-[10px] uppercase text-primary">Последняя сессия</p><h2 className="mt-1 text-lg font-bold">{detail.data.session_id}</h2></div><span className={`border px-3 py-2 text-xs font-bold uppercase ${detail.data.route === 'verified' ? 'border-primary/30 bg-primary/10 text-primary' : detail.data.route === 'manual_review' ? 'border-accent/40 bg-accent/10' : 'border-destructive/30 bg-destructive/10 text-destructive'}`}>{detail.data.route === 'verified' ? 'подтверждено' : detail.data.route === 'manual_review' ? 'ручная проверка' : 'не подтверждено'}</span></div><div className="mt-7 grid gap-3 sm:grid-cols-3"><Stat label="Совпадение" value={pct(detail.data.match_score)} detail="оценка песочницы" /><Stat label="Живость" value={pct(detail.data.liveness_score)} detail="оценка песочницы" /><Stat label="Качество" value={detail.data.quality_pass ? 'ПРОЙДЕНО' : 'ОТКЛОНЕНО'} detail={`Модель ${detail.data.model_version}`} /></div><p className="mt-6 border-l-2 border-accent pl-3 text-xs leading-relaxed text-muted-foreground">{detail.data.disclaimer}</p>{recentSessions.length > 1 && <div className="mt-6 border-t border-border pt-4"><p className="mono text-[10px] uppercase text-muted-foreground">Недавние сессии</p><div className="mt-2 flex flex-wrap gap-2">{recentSessions.map((id) => <button key={id} onClick={() => setSession(id)} className="mono border border-border px-2 py-1 text-[10px] text-primary hover:bg-muted">{id}</button>)}</div></div>}</div> : <div className="grid-paper flex h-full min-h-[330px] flex-col items-center justify-center p-10 text-center"><UserRoundCheck size={34} className="text-primary" /><p className="mt-4 font-semibold">Нет активной сессии песочницы</p><p className="mt-2 max-w-sm text-sm text-muted-foreground">Отправьте ограниченные оценки, чтобы получить маршрут и аудируемую ссылку на сессию.</p></div>}</div>
      </div>
    </div>
  );
}

export function GovernancePage() {
  const card = useGetModelCard();
  const versions = useListModelVersions();
  const drift = useGetDriftReport();
  return (
    <div className="rise">
      <PageTitle eyebrow="Управление / сопровождение модели" title="Свидетельства за сигналом." description="Неизменяемый контекст модели, поэтапная валидация и дрейф признаков — полноправные части исследовательской записи." action={<span className="flex items-center gap-2 border border-border bg-card px-3 py-2 text-[10px] font-bold uppercase"><GitBranch size={14} /> Неизменяемый реестр</span>} />
      {card.isLoading ? <LoadingRows count={4} /> : card.isError ? <ErrorState /> : <div className="space-y-5"><section className="border border-border bg-card p-6"><div className="flex flex-col justify-between gap-4 md:flex-row"><div><p className="mono text-[10px] uppercase text-primary">Текущая карточка модели</p><h2 className="display mt-2 text-3xl font-semibold">{card.data?.model_name} <span className="mono text-sm text-primary">{card.data?.model_version}</span></h2><p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted-foreground">{card.data?.description}</p></div><div className="h-fit border border-primary/30 bg-primary/10 px-3 py-2 text-[10px] font-bold uppercase text-primary">{card.data?.status === 'research' ? 'исследование' : card.data?.status}</div></div><div className="mt-7 grid gap-5 md:grid-cols-2"><div><p className="mono text-[10px] uppercase text-muted-foreground">Назначение</p><p className="mt-2 text-sm leading-relaxed">{card.data?.intended_use}</p></div><div><p className="mono text-[10px] uppercase text-muted-foreground">Вне области применения</p><ul className="mt-2 space-y-2 text-sm">{card.data?.out_of_scope.map((item) => <li key={item} className="flex gap-2"><X size={14} className="mt-0.5 text-destructive" />{item}</li>)}</ul></div></div></section><div className="grid gap-5 xl:grid-cols-[1.2fr_.8fr]"><section className="border border-border bg-card p-6"><div className="flex items-center justify-between"><div><p className="mono text-[10px] uppercase text-primary">Путь валидации</p><h2 className="mt-1 text-lg font-bold">R0 → R4</h2></div><span className="mono text-[10px] text-muted-foreground">ПОЭТАПНЫЕ СВИДЕТЕЛЬСТВА</span></div><div className="mt-6 grid gap-3 sm:grid-cols-2">{card.data?.validation_status.map((stage) => <div key={stage.stage} className="border border-border p-4"><div className="flex items-center justify-between"><span className="mono text-lg font-semibold text-primary">{stage.stage}</span><span className={`text-[10px] font-bold uppercase ${stage.status === 'passed' ? 'text-primary' : 'text-accent-foreground'}`}>{stage.status === 'passed' ? 'пройдено' : 'запланировано'}</span></div><p className="mt-3 font-semibold">{stage.label}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{stage.description}</p></div>)}</div></section><section className="border border-border bg-card p-6"><p className="mono text-[10px] uppercase text-primary">Веса компонентов</p><h2 className="mt-1 text-lg font-bold">Архитектура индекса</h2><div className="mt-5 space-y-4">{card.data?.components.map((c) => <div key={c.key}><div className="flex justify-between text-sm"><span>{c.label}</span><span className="mono text-xs">{pct(c.weight)}</span></div><div className="mt-2 h-2 bg-muted"><div className="h-full bg-primary" style={{ width: `${c.weight * 100}%` }} /></div><p className="mt-1 text-[10px] text-muted-foreground">{c.feature_count} признаков</p></div>)}</div></section></div><div className="grid gap-5 xl:grid-cols-[.9fr_1.1fr]"><section className="border border-border bg-card p-6"><p className="mono text-[10px] uppercase text-primary">Реестр версий</p><h2 className="mt-1 text-lg font-bold">Неизменяемые версии</h2>{versions.isLoading ? <div className="mt-4"><LoadingRows count={3} /></div> : <div className="mt-5 space-y-3">{(versions.data ?? []).map((v) => <div key={v.version} className="border-b border-border pb-3"><div className="flex justify-between text-sm font-semibold"><span className="mono">{v.version}</span><span className="text-[10px] uppercase text-muted-foreground">{v.status === 'research' ? 'исследование' : 'устарела'}</span></div><p className="mt-1 text-xs text-muted-foreground">{v.changes}</p><p className="mono mt-2 text-[10px] text-muted-foreground">{v.config_hash} · {fmt(v.created_at)}</p></div>)}</div>}</section><section className="border border-border bg-card p-6"><div className="flex items-center justify-between"><div><p className="mono text-[10px] uppercase text-primary">Отчёт о дрейфе</p><h2 className="mt-1 text-lg font-bold">{drift.data?.status === 'stable' ? 'стабильно' : drift.data?.status ?? 'Ожидается отчёт'}</h2></div><span className="mono text-[10px] text-muted-foreground">{drift.data?.window}</span></div>{drift.isLoading ? <div className="mt-4"><LoadingRows count={3} /></div> : drift.data?.features?.length ? <div className="mt-5 overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-b border-border text-[10px] uppercase text-muted-foreground"><tr><th className="pb-2">Признак</th><th className="pb-2">KS</th><th className="pb-2">p-value</th><th className="pb-2">Серьёзность</th></tr></thead><tbody>{drift.data.features.map((f) => <tr key={f.feature} className="border-b border-border/70"><td className="py-3">{f.feature}</td><td className="mono py-3 text-xs">{f.ks_statistic.toFixed(3)}</td><td className="mono py-3 text-xs">{f.p_value.toFixed(3)}</td><td className="py-3"><span className={`text-[10px] font-bold uppercase ${f.severity === 'high' ? 'text-destructive' : f.severity === 'moderate' ? 'text-accent-foreground' : 'text-primary'}`}>{f.severity === 'low' ? 'низкая' : f.severity === 'medium' || f.severity === 'moderate' ? 'средняя' : 'высокая'}</span></td></tr>)}</tbody></table></div> : <EmptyState title="Признаки дрейфа не найдены" body="Отчёт появится после следующего окна валидации." />}</section></div></div>}
    </div>
  );
}