'use client';

import { Badge } from '@/components/ui/badge';

// ─── Status Badge Components ────────────────────────────────────────────────

export function WorkerStatusBadge({ connected, lastCheck }: { connected: boolean; lastCheck: string | null }) {
  return (
    <Badge variant={connected ? 'default' : 'destructive'} className="gap-1.5">
      <span className={`size-2 rounded-full ${connected ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
      {connected ? 'Conectado' : 'Desconectado'}
      {lastCheck && <span className="text-[10px] opacity-70 ml-1">{lastCheck}</span>}
    </Badge>
  );
}

export function RegimeBadge({ regime }: { regime: string }) {
  const config: Record<string, { label: string; className: string }> = {
    RANGING: { label: 'Rango', className: 'bg-amber-500/10 text-amber-600 border-amber-500/20' },
    TRENDING: { label: 'Tendencia', className: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' },
    VOLATILE: { label: 'Volátil', className: 'bg-red-500/10 text-red-600 border-red-500/20' },
    LOW_VOL: { label: 'Baja Vol.', className: 'bg-zinc-500/10 text-zinc-500 border-zinc-500/20' },
    TRANSITIONAL: { label: 'Transición', className: 'bg-sky-500/10 text-sky-600 border-sky-500/20' },
    UNKNOWN: { label: 'Desconocido', className: 'bg-zinc-500/10 text-zinc-500 border-zinc-500/20' },
  };
  const c = config[regime] || config.UNKNOWN;
  return <Badge className={`${c.className} border text-xs font-medium`}>{c.label}</Badge>;
}

export function RiskLevelBadge({ level }: { level: string }) {
  const config: Record<string, { label: string; className: string }> = {
    LOW: { label: 'Bajo', className: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' },
    MEDIUM: { label: 'Medio', className: 'bg-amber-500/10 text-amber-600 border-amber-500/20' },
    HIGH: { label: 'Alto', className: 'bg-orange-500/10 text-orange-600 border-orange-500/20' },
    EXTREME: { label: 'Extremo', className: 'bg-red-500/10 text-red-600 border-red-500/20' },
  };
  const c = config[level] || config.MEDIUM;
  return <Badge className={`${c.className} border text-xs font-medium`}>{c.label}</Badge>;
}

export function DirectionBadge({ direction }: { direction: string }) {
  if (direction === 'HIGHER' || direction === 'BUY') {
    return <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20 border text-xs">LONG ↑</Badge>;
  }
  if (direction === 'LOWER' || direction === 'SELL') {
    return <Badge className="bg-red-500/10 text-red-600 border-red-500/20 border text-xs">SHORT ↓</Badge>;
  }
  return <Badge variant="secondary" className="text-xs">{direction}</Badge>;
}

export function ResultBadge({ result }: { result: string | null }) {
  const config: Record<string, { label: string; className: string }> = {
    WIN: { label: 'WIN', className: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' },
    LOSS: { label: 'LOSS', className: 'bg-red-500/10 text-red-600 border-red-500/20' },
    DRAW: { label: 'DRAW', className: 'bg-amber-500/10 text-amber-600 border-amber-500/20' },
    NO_OPERAR: { label: 'NO OPERAR', className: 'bg-sky-500/10 text-sky-600 border-sky-500/20' },
  };
  if (!result) return <Badge variant="outline" className="text-xs text-muted-foreground">PENDING</Badge>;
  const c = config[result] || config.NO_OPERAR;
  return <Badge className={`${c.className} border text-xs font-medium`}>{c.label}</Badge>;
}

export function ExecutionModeBadge({ mode }: { mode: string }) {
  const config: Record<string, { label: string; className: string }> = {
    PAPER: { label: 'PAPER', className: 'bg-sky-500/10 text-sky-600 border-sky-500/20' },
    LIVE: { label: 'LIVE', className: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' },
  };
  const c = config[mode] || config.PAPER;
  return <Badge className={`${c.className} border text-xs font-medium`}>{c.label}</Badge>;
}

export function SessionBadge({ session }: { session: string }) {
  const config: Record<string, { label: string; className: string }> = {
    Asia: { label: 'Asia', className: 'bg-orange-500/10 text-orange-600 border-orange-500/20' },
    London: { label: 'Londres', className: 'bg-sky-500/10 text-sky-600 border-sky-500/20' },
    Overlap: { label: 'Solape', className: 'bg-amber-500/10 text-amber-600 border-amber-500/20' },
    NewYork: { label: 'Nueva York', className: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' },
    OffHours: { label: 'Fuera de sesión', className: 'bg-zinc-500/10 text-zinc-500 border-zinc-500/20' },
  };
  const c = config[session] || config.OffHours;
  return <Badge className={`${c.className} border text-xs font-medium`}>{c.label}</Badge>;
}

export function StrategyBadge({ enabled, label }: { enabled: boolean; label: string }) {
  return (
    <Badge className={`${enabled ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' : 'bg-zinc-500/10 text-zinc-500 border-zinc-500/20'} border text-xs font-medium`}>
      <span className={`size-1.5 rounded-full mr-1.5 ${enabled ? 'bg-emerald-500' : 'bg-zinc-400'}`} />
      {label}
    </Badge>
  );
}

export function PnlValue({ value, className }: { value: number; className?: string }) {
  const isPositive = value >= 0;
  return (
    <span className={`font-mono font-semibold ${isPositive ? 'text-emerald-500' : 'text-red-500'} ${className || ''}`}>
      {isPositive ? '+' : ''}{value.toFixed(2)}
    </span>
  );
}
