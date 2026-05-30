'use client';

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

// ─── Loading Skeleton ────────────────────────────────────────────────────────

export function DashboardSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Card key={i}>
          <CardContent className="p-4">
            <Skeleton className="h-3 w-20 mb-2" />
            <Skeleton className="h-8 w-24 mb-1" />
            <Skeleton className="h-3 w-16" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-3">
      <div className="flex gap-4">
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className="h-4 w-24" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex gap-4">
          {Array.from({ length: cols }).map((_, j) => (
            <Skeleton key={j} className="h-4 w-20" />
          ))}
        </div>
      ))}
    </div>
  );
}

// ─── Empty State ────────────────────────────────────────────────────────────

export function EmptyState({ icon: Icon, title, description }: { icon: any; title: string; description?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="size-12 rounded-xl bg-muted flex items-center justify-center mb-4">
        <Icon className="size-6 text-muted-foreground" />
      </div>
      <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      {description && <p className="text-xs text-muted-foreground/70 mt-1 max-w-xs">{description}</p>}
    </div>
  );
}

// ─── Section Header ─────────────────────────────────────────────────────────

export function SectionHeader({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}

// ─── Circuit Breaker Alert ──────────────────────────────────────────────────

export function CircuitBreakerAlert({ reason, onReset }: { reason: string | null; onReset: () => void }) {
  return (
    <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="size-3 rounded-full bg-red-500 animate-pulse" />
        <div>
          <p className="text-sm font-semibold text-red-600">Circuit Breaker Activado</p>
          <p className="text-xs text-red-500/80">{reason || 'Drawdown máximo alcanzado'}</p>
        </div>
      </div>
      <button
        onClick={onReset}
        className="px-3 py-1.5 text-xs font-medium bg-red-500/20 text-red-600 rounded-md hover:bg-red-500/30 transition-colors"
      >
        Reiniciar
      </button>
    </div>
  );
}

// ─── Strategy Card ──────────────────────────────────────────────────────────

export function StrategyCard({
  title,
  enabled,
  icon: Icon,
  stats,
  children,
}: {
  title: string;
  enabled: boolean;
  icon: any;
  stats?: { label: string; value: string | number }[];
  children?: React.ReactNode;
}) {
  return (
    <Card className={`${!enabled ? 'opacity-60' : ''}`}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={`size-8 rounded-lg flex items-center justify-center ${enabled ? 'bg-emerald-500/10 text-emerald-500' : 'bg-muted text-muted-foreground'}`}>
              <Icon className="size-4" />
            </div>
            <CardTitle className="text-base">{title}</CardTitle>
          </div>
          <Badge className={`${enabled ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' : 'bg-zinc-500/10 text-zinc-500 border-zinc-500/20'} border text-xs font-medium`}>
            {enabled ? 'Activo' : 'Inactivo'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {stats && stats.length > 0 && (
          <div className="grid grid-cols-2 gap-2 mb-3">
            {stats.map((s, i) => (
              <div key={i} className="flex flex-col">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{s.label}</span>
                <span className="text-sm font-semibold">{s.value}</span>
              </div>
            ))}
          </div>
        )}
        {children}
      </CardContent>
    </Card>
  );
}

// ─── Fear & Greed Gauge ─────────────────────────────────────────────────────

export function FearGreedGauge({ value, label }: { value: number; label: string }) {
  // Clamp 0-100
  const clamped = Math.max(0, Math.min(100, value));
  const angle = (clamped / 100) * 180 - 90; // -90 to 90 degrees

  const getColor = (v: number) => {
    if (v <= 25) return 'text-red-500';
    if (v <= 45) return 'text-orange-500';
    if (v <= 55) return 'text-amber-500';
    if (v <= 75) return 'text-emerald-500';
    return 'text-emerald-600';
  };

  return (
    <div className="flex flex-col items-center">
      <div className="relative w-28 h-14 overflow-hidden">
        <svg viewBox="0 0 120 60" className="w-full">
          {/* Gauge background */}
          <path d="M 10 55 A 50 50 0 0 1 110 55" fill="none" stroke="currentColor" strokeWidth="8" className="text-muted/30" />
          {/* Gradient segments */}
          <path d="M 10 55 A 50 50 0 0 1 30 15" fill="none" stroke="#ef4444" strokeWidth="8" />
          <path d="M 30 15 A 50 50 0 0 1 50 5" fill="none" stroke="#f97316" strokeWidth="8" />
          <path d="M 50 5 A 50 50 0 0 1 70 5" fill="none" stroke="#eab308" strokeWidth="8" />
          <path d="M 70 5 A 50 50 0 0 1 90 15" fill="none" stroke="#22c55e" strokeWidth="8" />
          <path d="M 90 15 A 50 50 0 0 1 110 55" fill="none" stroke="#16a34a" strokeWidth="8" />
          {/* Needle */}
          <line
            x1="60" y1="55"
            x2={60 + 45 * Math.cos((angle - 90) * Math.PI / 180)}
            y2={55 + 45 * Math.sin((angle - 90) * Math.PI / 180)}
            stroke="currentColor"
            strokeWidth="2"
            className={getColor(clamped)}
          />
          <circle cx="60" cy="55" r="4" fill="currentColor" className={getColor(clamped)} />
        </svg>
      </div>
      <div className="text-center -mt-1">
        <span className={`text-2xl font-bold ${getColor(clamped)}`}>{clamped}</span>
        <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</p>
      </div>
    </div>
  );
}
