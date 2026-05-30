'use client';

import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ChevronLeft, ChevronRight, Eye, Filter } from 'lucide-react';
import { DirectionBadge, ResultBadge, ExecutionModeBadge, SessionBadge, PnlValue } from './status-badges';
import { EmptyState, SectionHeader } from './shared';
import { useSignals, useSignalsStats } from '@/lib/hooks/use-api';

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function formatPrice(price: number, asset: string): string {
  if (asset?.includes('JPY')) return price.toFixed(3);
  if (asset?.includes('BTC')) return price.toFixed(1);
  if (asset?.includes('ETH')) return price.toFixed(2);
  return price.toFixed(5);
}

const PATTERN_NAMES: Record<string, string> = {
  breakout: 'Ruptura',
  liquidity_sweep: 'Barrido Liq.',
  engulfing: 'Envolvente',
  fakeout: 'Falsa Ruptura',
  reversal: 'Reversión',
  trend_continuation: 'Continuación',
  mean_reversion: 'Mean Reversion',
  orderflow: 'Order Flow',
};

export function SignalsPage() {
  const [page, setPage] = useState(1);
  const [filterDirection, setFilterDirection] = useState('ALL');
  const [filterAsset, setFilterAsset] = useState('ALL');
  const [filterStatus, setFilterStatus] = useState('ALL');

  const { data: signalsData, isLoading } = useSignals({
    page,
    limit: 20,
    direction: filterDirection,
    asset: filterAsset,
    status: filterStatus,
  });
  const { data: stats } = useSignalsStats();

  const signals = signalsData?.signals || [];
  const pagination = signalsData?.pagination;
  const totalPages = pagination?.totalPages || 1;

  return (
    <div className="space-y-6">
      {/* Stats Summary */}
      <div>
        <SectionHeader title="Estadísticas de Señales" />
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
          <Card className="p-3">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Total</span>
            <p className="text-lg font-bold">{stats?.totalSignals || 0}</p>
          </Card>
          <Card className="p-3">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Wins</span>
            <p className="text-lg font-bold text-emerald-500">{stats?.winCount || 0}</p>
          </Card>
          <Card className="p-3">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Losses</span>
            <p className="text-lg font-bold text-red-500">{stats?.lossCount || 0}</p>
          </Card>
          <Card className="p-3">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Win Rate</span>
            <p className="text-lg font-bold">{(stats?.winRate || 0).toFixed(1)}%</p>
          </Card>
          <Card className="p-3">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Conf. Media</span>
            <p className="text-lg font-bold">{(stats?.averageConfidence || 0).toFixed(1)}%</p>
          </Card>
          <Card className="p-3">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Profit Factor</span>
            <p className="text-lg font-bold">{(stats?.profitFactor || 0).toFixed(2)}</p>
          </Card>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <Filter className="size-4 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Filtros:</span>
        </div>
        <Select value={filterDirection} onValueChange={(v) => { setFilterDirection(v); setPage(1); }}>
          <SelectTrigger className="w-32 h-8 text-xs"><SelectValue placeholder="Dirección" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Todas</SelectItem>
            <SelectItem value="HIGHER">LONG ↑</SelectItem>
            <SelectItem value="LOWER">SHORT ↓</SelectItem>
            <SelectItem value="NO_OPERAR">NO OPERAR</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filterAsset} onValueChange={(v) => { setFilterAsset(v); setPage(1); }}>
          <SelectTrigger className="w-36 h-8 text-xs"><SelectValue placeholder="Asset" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Todos</SelectItem>
            <SelectItem value="BTC/USD">BTC/USD</SelectItem>
            <SelectItem value="ETH/USD">ETH/USD</SelectItem>
            <SelectItem value="EUR/USD">EUR/USD</SelectItem>
            <SelectItem value="GBP/USD">GBP/USD</SelectItem>
            <SelectItem value="USD/JPY">USD/JPY</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filterStatus} onValueChange={(v) => { setFilterStatus(v); setPage(1); }}>
          <SelectTrigger className="w-28 h-8 text-xs"><SelectValue placeholder="Estado" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Todos</SelectItem>
            <SelectItem value="PENDING">Pendiente</SelectItem>
            <SelectItem value="CLOSED">Cerrado</SelectItem>
            <SelectItem value="CANCELLED">Cancelado</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">
          {pagination?.total || 0} señal(es)
        </span>
      </div>

      {/* Signals Table */}
      {isLoading ? (
        <Card>
          <CardContent className="p-4 space-y-3">
            {Array.from({ length: 10 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </CardContent>
        </Card>
      ) : signals.length === 0 ? (
        <Card>
          <EmptyState icon={Eye} title="Sin señales" description="No se encontraron señales con los filtros seleccionados" />
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50">
                  <th className="text-left p-3 text-xs font-medium text-muted-foreground">Tiempo</th>
                  <th className="text-left p-3 text-xs font-medium text-muted-foreground">Asset</th>
                  <th className="text-left p-3 text-xs font-medium text-muted-foreground">Dir.</th>
                  <th className="text-right p-3 text-xs font-medium text-muted-foreground">Entrada</th>
                  <th className="text-right p-3 text-xs font-medium text-muted-foreground">Salida</th>
                  <th className="text-left p-3 text-xs font-medium text-muted-foreground">Patrón</th>
                  <th className="text-center p-3 text-xs font-medium text-muted-foreground">Conf.</th>
                  <th className="text-left p-3 text-xs font-medium text-muted-foreground">Resultado</th>
                  <th className="text-right p-3 text-xs font-medium text-muted-foreground">P&L Est.</th>
                  <th className="text-left p-3 text-xs font-medium text-muted-foreground">Fuente</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((signal: any) => (
                  <tr key={signal.id} className="border-b border-border/30 hover:bg-muted/30 transition-colors">
                    <td className="p-3 text-xs text-muted-foreground whitespace-nowrap">
                      {formatTime(signal.entryTime || signal.createdAt)}
                    </td>
                    <td className="p-3 font-medium text-xs">{signal.asset}</td>
                    <td className="p-3"><DirectionBadge direction={signal.direction} /></td>
                    <td className="p-3 text-right font-mono text-xs">{formatPrice(signal.entryPrice, signal.asset)}</td>
                    <td className="p-3 text-right font-mono text-xs">{signal.exitPrice ? formatPrice(signal.exitPrice, signal.asset) : '—'}</td>
                    <td className="p-3">
                      <Badge variant="outline" className="text-[10px]">
                        {PATTERN_NAMES[signal.patternType] || signal.patternType || '—'}
                      </Badge>
                    </td>
                    <td className="p-3 text-center">
                      <span className={`text-xs font-mono ${
                        signal.confidence >= 70 ? 'text-emerald-500' :
                        signal.confidence >= 50 ? 'text-amber-500' : 'text-red-500'
                      }`}>
                        {signal.confidence?.toFixed(0)}%
                      </span>
                    </td>
                    <td className="p-3"><ResultBadge result={signal.result} /></td>
                    <td className="p-3 text-right text-xs">
                      {signal.estimatedProfit != null || signal.estimatedLoss != null ? (
                        <PnlValue value={signal.estimatedProfit || -(signal.estimatedLoss || 0)} className="text-xs" />
                      ) : '—'}
                    </td>
                    <td className="p-3">
                      <Badge variant="outline" className="text-[10px]">{signal.source || 'MANUAL'}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Página {page} de {totalPages}
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 w-8 p-0"
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page <= 1}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 w-8 p-0"
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
