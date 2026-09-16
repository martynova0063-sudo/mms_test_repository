import { useState, type ReactNode } from 'react';
import { Activity, ChevronRight, ClipboardCheck, FlaskConical, Gauge, Menu, ShieldCheck, X } from 'lucide-react';
import { Link, useLocation } from 'wouter';
import { useHealthCheck } from '@workspace/api-client-react';

const navItems = [
  { href: '/', label: 'Обзор', icon: Gauge },
  { href: '/results', label: 'Результаты HEALTH_ID', icon: Activity },
  { href: '/reviews', label: 'Очередь проверки', icon: ClipboardCheck },
  { href: '/verification', label: 'Песочница верификации', icon: ShieldCheck },
  { href: '/governance', label: 'Управление и дрейф', icon: FlaskConical },
];

export function ConsoleShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [open, setOpen] = useState(false);
  const health = useHealthCheck();
  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <aside className={`fixed inset-y-0 left-0 z-30 w-[264px] bg-sidebar text-sidebar-foreground transition-transform md:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between border-b border-sidebar-border px-6 py-6">
            <Link href="/" onClick={() => setOpen(false)} className="flex items-center gap-3" data-testid="link-brand">
              <span className="grid h-9 w-9 place-items-center border border-sidebar-primary/50 bg-sidebar-primary/10 text-sidebar-primary">
                <span className="display text-lg">H</span>
              </span>
               <span><span className="block text-[10px] font-bold uppercase tracking-[.24em] text-sidebar-primary">Исследовательская консоль</span><span className="display text-lg">HEALTH_ID</span></span>
            </Link>
             <button className="md:hidden text-sidebar-foreground/60" onClick={() => setOpen(false)} aria-label="Закрыть навигацию" data-testid="button-close-navigation"><X size={18} /></button>
          </div>
          <div className="mx-5 mt-6 border border-sidebar-border bg-sidebar-accent/40 p-3">
             <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.16em] text-sidebar-primary"><span className="status-dot status-green" />Только исследовательский режим</div>
             <p className="mt-2 text-xs leading-relaxed text-sidebar-foreground/65">Оценка клинических сигналов. Не диагноз и не система юридической идентификации.</p>
          </div>
          <nav className="mt-8 flex-1 px-3">
             <p className="px-3 pb-3 text-[10px] font-bold uppercase tracking-[.2em] text-sidebar-foreground/40">Рабочая область</p>
            {navItems.map(({ href, label, icon: Icon }) => {
              const active = href === '/' ? location === '/' : location.startsWith(href);
              return <Link href={href} onClick={() => setOpen(false)} key={href} data-testid={`link-nav-${label.toLowerCase().replaceAll(' ', '-')}`} className={`group mb-1 flex items-center gap-3 border-l-2 px-3 py-3 text-sm ${active ? 'border-sidebar-primary bg-sidebar-accent text-sidebar-foreground' : 'border-transparent text-sidebar-foreground/60 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'}`}>
                <Icon size={16} className={active ? 'text-sidebar-primary' : ''} /><span className="flex-1">{label}</span>{active && <ChevronRight size={14} className="text-sidebar-primary" />}
              </Link>;
            })}
          </nav>
          <div className="border-t border-sidebar-border p-5">
             <div className="flex items-center gap-3"><div className="grid h-8 w-8 place-items-center rounded-full bg-sidebar-primary text-xs font-bold text-sidebar-primary-foreground">SR</div><div><p className="text-xs font-semibold">Исследовательская зона</p><p className="mono text-[10px] text-sidebar-foreground/50">ЛОКАЛЬНО / R0</p></div></div>
          </div>
        </div>
      </aside>
      {open && <button className="fixed inset-0 z-20 bg-foreground/20 md:hidden" onClick={() => setOpen(false)} aria-label="Close navigation overlay" data-testid="button-overlay-navigation" />}
      <main className="md:pl-[264px]">
        <header className="sticky top-0 z-10 flex h-[72px] items-center justify-between border-b border-border/80 bg-background/90 px-5 backdrop-blur md:px-9">
           <div className="flex items-center gap-3"><button className="md:hidden" onClick={() => setOpen(true)} aria-label="Открыть навигацию" data-testid="button-open-navigation"><Menu size={20} /></button><div className="hidden text-xs text-muted-foreground sm:block"><span className="mono">ИССЛЕДОВАНИЕ / R0</span><span className="mx-2">·</span>Дистанционный периодический осмотр</div></div>
           <div className="flex items-center gap-4 text-xs"><span className="hidden items-center gap-2 text-muted-foreground sm:flex"><span className={`status-dot ${health.isError ? 'status-red' : health.isLoading ? 'status-muted' : 'status-green'}`} />{health.isError ? 'API недоступен' : health.isLoading ? 'Проверка API' : 'API подключён'}</span><span className="mono border border-border bg-card px-2 py-1 text-[10px] text-muted-foreground">БИОМЕТРИЯ НЕ ХРАНИТСЯ</span></div>
        </header>
        <div className="mx-auto max-w-[1500px] px-5 py-7 md:px-9 md:py-9">{children}</div>
      </main>
    </div>
  );
}