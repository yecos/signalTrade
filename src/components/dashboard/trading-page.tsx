'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  TrendingUp, TrendingDown, DollarSign, Shield, BarChart3,
  Activity, AlertTriangle, Eye,
} from 'lucide-react';
import { MetricCard } from './metric-card';
import { DirectionBadge, PnlValue, ExecutionModeBadge, ResultBadge } from './status-badges';
import { EmptyState, SectionHeader, CircuitBreakerAlert } from './shared';
import { useTradingData, useDeactivateCircuitBreaker, useClosePosition, useCloseAllPositions } from '@/lib/hooks/use-api';

function formatPrice(price: number, asset: string): string {
  if (asset?.includes('JPY')) return price.toFixed(3);
  if (asset?.includes('BTC')) return price.toFixed(1);
  if (asset?.includes('ETH')) return price.toFixed(2);
  return price.toFixed(5);
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export function TradingPage() {
  const { data: trading, isLoading } = useTradingData();
  const deactivateCB = useDeactivateCircuitBreaker();
  const closePosition = useClosePosition();
  const closeAll = useCloseAllPositions();

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}><CardContent className="p-4"><Skeleton className="h-20 w-full" /></CardContent></Card>
          ))}
        </div>
      </div>
    );
  }

  const account = trading?.account;
  const riskState = trading?.riskState;
  const riskConfig = trading?.riskConfig;
  const openPositions = trading?.openPositions || [];
  const recentTrades = trading?.recentTrades || [];
  const stats = trading?.stats;
  const closedTrades = recentTrades.filter((t: any) => t.status === 'CLOSED');

  return (
    <div className="space-y-6">
      {/* Circuit Breaker */}
      {account?.isCircuitBreaker && (
        <CircuitBreakerAlert
          reason={account.circuitBreakerReason}
          onReset={() => deactivateCB.mutate(undefined)}
        />
      )}

      {/* Account Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          title="Balance"
          value={`$${(account?.balance || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          icon={DollarSign}
          variant="default"
          subtitle={`Equity: $${(account?.equity || 0).toFixed(2)}`}
        />
        <MetricCard
          title="P&L No Realizado"
          value={`${(account?.unrealizedPnl || 0) >= 0 ? '+' : ''}$${Math.abs(account?.unrealizedPnl || 0).toFixed(2)}`}
          icon={(account?.unrealizedPnl || 0) >= 0 ? TrendingUp : TrendingDown}
          variant={(account?.unrealizedPnl || 0) >= 0 ? 'success' : 'danger'}
        />
        <MetricCard
          title="Win Rate"
          value={`${(stats?.winRate || 0).toFixed(1)}%`}
          icon={BarChart3}
          variant={(stats?.winRate || 0) > 50 ? 'success' : 'danger'}
          subtitle={`${stats?.wins || 0}W / ${stats?.losses || 0}L`}
        />
        <MetricCard
          title="Profit Factor"
          value={(stats?.profitFactor || 0).toFixed(2)}
          icon={Activity}
          variant={(stats?.profitFactor || 0) > 1 ? 'success' : 'danger'}
          subtitle={`P&L Total: $${(stats?.totalPnl || 0).toFixed(2)}`}
        />
      </div>

      {/* Risk Manager */}
      <div>
        <SectionHeader title="Gestor de Riesgo" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-1">
                <Shield className="size-4 text-amber-500" />
                <span className="text-xs text-muted-foreground uppercase tracking-wider">Pérdida Diaria</span>
              </div>
              <p className={`text-lg font-bold ${(riskState?.dailyPnl || 0) >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                ${(riskState?.dailyPnl || 0).toFixed(2)}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Límite: -{riskConfig?.maxDailyLoss || 3}% del balance
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-1">
                <Activity className="size-4 text-sky-500" />
                <span className="text-xs text-muted-foreground uppercase tracking-wider">Trades Hoy</span>
              </div>
              <p className="text-lg font-bold">{riskState?.dailyTrades || 0}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {riskState?.dailyWins || 0}W / {riskState?.dailyLosses || 0}L
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-1">
                <AlertTriangle className="size-4 text-red-500" />
                <span className="text-xs text-muted-foreground uppercase tracking-wider">Drawdown</span>
              </div>
              <p className={`text-lg font-bold ${(riskState?.currentDrawdownPct || 0) > 5 ? 'text-red-500' : 'text-foreground'}`}>
                {(riskState?.currentDrawdownPct || 0).toFixed(2)}%
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Máx: {riskConfig?.maxDrawdownPct || 10}%
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-1">
                <Shield className="size-4 text-emerald-500" />
                <span className="text-xs text-muted-foreground uppercase tracking-wider">Circuit Breaker</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`size-3 rounded-full ${account?.isCircuitBreaker ? 'bg-red-500' : 'bg-emerald-500'}`} />
                <p className="text-lg font-bold">{account?.isCircuitBreaker ? 'ACTIVO' : 'OK'}</p>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Pérdidas consecutivas: {riskState?.consecutiveLosses || 0}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Open Positions */}
      <div>
        <SectionHeader
          title="Posiciones Abiertas"
          description={`${openPositions.length} posición(es)`}
          action={
            openPositions.length > 0 ? (
              <Button
                size="sm"
                variant="destructive"
                className="h-7 text-xs"
                onClick={() => closeAll.mutate(undefined)}
                disabled={closeAll.isPending}
              >
                Cerrar Todas
              </Button>
            ) : undefined
          }
        />
        {openPositions.length === 0 ? (
          <Card>
            <EmptyState icon={Eye} title="Sin posiciones abiertas" />
          </Card>
        ) : (
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/50">
                    <th className="text-left p-3 text-xs font-medium text-muted-foreground">Asset</th>
                    <th className="text-left p-3 text-xs font-medium text-muted-foreground">Dir.</th>
                    <th className="text-right p-3 text-xs font-medium text-muted-foreground">Qty</th>
                    <th className="text-right p-3 text-xs font-medium text-muted-foreground">Entrada</th>
                    <th className="text-right p-3 text-xs font-medium text-muted-foreground">Actual</th>
                    <th className="text-right p-3 text-xs font-medium text-muted-foreground">P&L</th>
                    <th className="text-right p-3 text-xs font-medium text-muted-foreground">P&L %</th>
                    <th className="text-right p-3 text-xs font-medium text-muted-foreground">SL</th>
                    <th className="text-right p-3 text-xs font-medium text-muted-foreground">TP</th>
                    <th className="text-right p-3 text-xs font-medium text-muted-foreground">Modo</th>
                    <th className="p-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {openPositions.map((pos: any) => (
                    <tr key={pos.id} className="border-b border-border/30 hover:bg-muted/30 transition-colors">
                      <td className="p-3 font-medium">{pos.asset}</td>
                      <td className="p-3"><DirectionBadge direction={pos.direction} /></td>
                      <td className="p-3 text-right font-mono text-xs">{pos.quantity?.toFixed(6)}</td>
                      <td className="p-3 text-right font-mono text-xs">{formatPrice(pos.entryPrice, pos.asset)}</td>
                      <td className="p-3 text-right font-mono text-xs">{pos.currentPrice ? formatPrice(pos.currentPrice, pos.asset) : '—'}</td>
                      <td className="p-3 text-right"><PnlValue value={pos.unrealizedPnl || 0} className="text-xs" /></td>
                      <td className="p-3 text-right font-mono text-xs">
                        <span className={(pos.unrealizedPnlPct || 0) >= 0 ? 'text-emerald-500' : 'text-red-500'}>
                          {(pos.unrealizedPnlPct || 0).toFixed(2)}%
                        </span>
                      </td>
                      <td className="p-3 text-right font-mono text-xs text-red-500/70">{pos.stopLoss ? formatPrice(pos.stopLoss, pos.asset) : '—'}</td>
                      <td className="p-3 text-right font-mono text-xs text-emerald-500/70">{pos.takeProfit ? formatPrice(pos.takeProfit, pos.asset) : '—'}</td>
                      <td className="p-3 text-right"><ExecutionModeBadge mode={pos.executionMode} /></td>
                      <td className="p-3 text-right">
                        <Button
                          size="sm"
                          variant="destructive"
                          className="h-6 text-[10px] px-2"
                          onClick={() => closePosition.mutate(pos.id)}
                          disabled={closePosition.isPending}
                        >
                          Cerrar
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>

      {/* Trade History */}
      <div>
        <SectionHeader title="Historial de Trades" description={`${closedTrades.length} trade(s) reciente(s)`} />
        {closedTrades.length === 0 ? (
          <Card>
            <EmptyState icon={BarChart3} title="Sin trades cerrados" description="Los trades cerrados aparecerán aquí" />
          </Card>
        ) : (
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/50">
                    <th className="text-left p-3 text-xs font-medium text-muted-foreground">Asset</th>
                    <th className="text-left p-3 text-xs font-medium text-muted-foreground">Dir.</th>
                    <th className="text-right p-3 text-xs font-medium text-muted-foreground">Entrada</th>
                    <th className="text-right p-3 text-xs font-medium text-muted-foreground">Salida</th>
                    <th className="text-right p-3 text-xs font-medium text-muted-foreground">P&L</th>
                    <th className="text-right p-3 text-xs font-medium text-muted-foreground">P&L %</th>
                    <th className="text-left p-3 text-xs font-medium text-muted-foreground">Modo</th>
                    <th className="text-left p-3 text-xs font-medium text-muted-foreground">Cerrado</th>
                  </tr>
                </thead>
                <tbody>
                  {closedTrades.map((trade: any) => (
                    <tr key={trade.id} className="border-b border-border/30 hover:bg-muted/30 transition-colors">
                      <td className="p-3 font-medium">{trade.asset}</td>
                      <td className="p-3"><DirectionBadge direction={trade.direction} /></td>
                      <td className="p-3 text-right font-mono text-xs">{trade.entryPrice ? formatPrice(trade.entryPrice, trade.asset) : '—'}</td>
                      <td className="p-3 text-right font-mono text-xs">{trade.exitPrice ? formatPrice(trade.exitPrice, trade.asset) : '—'}</td>
                      <td className="p-3 text-right"><PnlValue value={trade.realizedPnl || 0} className="text-xs" /></td>
                      <td className="p-3 text-right font-mono text-xs">
                        <span className={(trade.realizedPnlPct || 0) >= 0 ? 'text-emerald-500' : 'text-red-500'}>
                          {(trade.realizedPnlPct || 0).toFixed(2)}%
                        </span>
                      </td>
                      <td className="p-3"><ExecutionModeBadge mode={trade.executionMode} /></td>
                      <td className="p-3 text-xs text-muted-foreground">{trade.closedAt ? formatTime(trade.closedAt) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
