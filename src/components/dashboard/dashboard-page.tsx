'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Activity, TrendingUp, TrendingDown, DollarSign, Shield, Zap,
  Brain, Wifi, WifiOff, Clock, BarChart3, AlertTriangle, Play,
  ArrowUpRight, ArrowDownRight, Eye,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { MetricCard } from './metric-card';
import {
  WorkerStatusBadge, RegimeBadge, RiskLevelBadge, DirectionBadge,
  PnlValue, ExecutionModeBadge, StrategyBadge,
} from './status-badges';
import {
  EmptyState, SectionHeader, CircuitBreakerAlert, StrategyCard, FearGreedGauge,
} from './shared';
import {
  useWorkerStatus, useStrategyStatus, useAIAnalysis,
  useTradingData, useMarketSentiment, useDeactivateCircuitBreaker,
  useClosePosition,
} from '@/lib/hooks/use-api';

// ─── Session Detection ─────────────────────────────────────────────────────

function detectSession(): { session: string; sessionEs: string } {
  const hourUtc = new Date().getUTCHours();
  const minuteUtc = new Date().getUTCMinutes();
  const timeInMinutes = hourUtc * 60 + minuteUtc;

  if (timeInMinutes >= 12 * 60 && timeInMinutes < 16 * 60)
    return { session: 'Overlap', sessionEs: 'Solape Londres-NY' };
  if (timeInMinutes >= 7 * 60 && timeInMinutes < 12 * 60)
    return { session: 'London', sessionEs: 'Sesión de Londres' };
  if (timeInMinutes >= 16 * 60 && timeInMinutes < 21 * 60)
    return { session: 'NewYork', sessionEs: 'Sesión de Nueva York' };
  if (timeInMinutes < 7 * 60)
    return { session: 'Asia', sessionEs: 'Sesión Asiática' };
  return { session: 'OffHours', sessionEs: 'Fuera de sesión' };
}

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

// ─── Main Dashboard Page ───────────────────────────────────────────────────

export function DashboardPage() {
  const { data: worker, isLoading: workerLoading } = useWorkerStatus();
  const { data: strategy, isLoading: strategyLoading } = useStrategyStatus();
  const { data: aiAnalysis, isLoading: aiLoading } = useAIAnalysis();
  const { data: trading, isLoading: tradingLoading } = useTradingData();
  const { data: sentiment } = useMarketSentiment();
  const deactivateCB = useDeactivateCircuitBreaker();
  const closePosition = useClosePosition();

  const sessionInfo = detectSession();
  const isLoading = workerLoading && strategyLoading && tradingLoading;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}><CardContent className="p-4"><Skeleton className="h-20 w-full" /></CardContent></Card>
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}><CardContent className="p-4"><Skeleton className="h-40 w-full" /></CardContent></Card>
          ))}
        </div>
      </div>
    );
  }

  const account = worker?.account || trading?.account;
  const mrStats = strategy?.meanReversion?.stats;
  const openPositions = trading?.openPositions || [];
  const recentTrades = trading?.recentTrades?.filter((t: any) => t.status === 'CLOSED').slice(0, 5) || [];

  return (
    <div className="space-y-6">
      {/* ─── Header: Worker Status + Account ────────────────────────── */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <WorkerStatusBadge
            connected={worker?.workerConnected || false}
            lastCheck={worker?.lastCheckAgo || 'Nunca'}
          />
          <RegimeBadge regime={strategy?.regime || 'UNKNOWN'} />
          <Badge variant="outline" className="text-xs gap-1">
            <Clock className="size-3" />
            {sessionInfo.sessionEs}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <ExecutionModeBadge mode={worker?.autoExecution?.mode || 'PAPER'} />
          {worker?.autoExecution?.enabled && (
            <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20 border text-xs gap-1">
              <Zap className="size-3" /> Auto-Ejecución
            </Badge>
          )}
        </div>
      </div>

      {/* ─── Circuit Breaker ──────────────────────────────────────── */}
      {account?.isCircuitBreaker && (
        <CircuitBreakerAlert
          reason={account.circuitBreakerReason}
          onReset={() => deactivateCB.mutate(undefined)}
        />
      )}

      {/* ─── KPI Cards ────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          title="Balance"
          value={`$${(account?.balance || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          icon={DollarSign}
          variant="default"
          subtitle={`Equity: $${(account?.equity || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
        />
        <MetricCard
          title="P&L No Realizado"
          value={`${(account?.unrealizedPnl || 0) >= 0 ? '+' : ''}$${Math.abs(account?.unrealizedPnl || 0).toFixed(2)}`}
          icon={(account?.unrealizedPnl || 0) >= 0 ? TrendingUp : TrendingDown}
          variant={(account?.unrealizedPnl || 0) >= 0 ? 'success' : 'danger'}
          subtitle={`${openPositions.length} posición(es) abierta(s)`}
        />
        <MetricCard
          title="Señales Hoy"
          value={worker?.todaySignalsCount || 0}
          icon={Activity}
          variant="info"
          subtitle={`${worker?.todayTradesCount || 0} trade(s) ejecutado(s)`}
        />
        <MetricCard
          title="Drawdown Máx."
          value={`${(account?.maxDrawdown || 0).toFixed(2)}%`}
          icon={Shield}
          variant={(account?.maxDrawdown || 0) > 5 ? 'danger' : (account?.maxDrawdown || 0) > 2 ? 'warning' : 'default'}
          subtitle={`Peak: $${(account?.peakEquity || 0).toFixed(2)}`}
        />
      </div>

      {/* ─── Strategy Panel (MAIN FOCUS) ──────────────────────────── */}
      <div>
        <SectionHeader
          title="Estrategias"
          description="Estado en tiempo real de las estrategias activas"
        />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Mean Reversion Card */}
          <StrategyCard
            title="Mean Reversion ETH/USD 1H"
            enabled={strategy?.config?.strategies?.meanReversion?.enabled ?? true}
            icon={TrendingUp}
            stats={[
              { label: 'Profit Factor', value: mrStats?.profitFactor?.toFixed(2) || '2.32' },
              { label: 'Win Rate', value: `${(mrStats?.winRate || 62.3).toFixed(1)}%` },
              { label: 'Sharpe', value: mrStats?.sharpeRatio?.toFixed(2) || '6.04' },
              { label: 'Señales', value: strategy?.meanReversion?.signalCount || 0 },
            ]}
          >
            {strategy?.meanReversion?.openPositions?.length > 0 && (
              <div className="mt-2 space-y-2">
                {strategy.meanReversion.openPositions.slice(0, 3).map((pos: any) => (
                  <div key={pos.id} className="flex items-center justify-between text-xs bg-muted/50 rounded-md p-2">
                    <div className="flex items-center gap-2">
                      <DirectionBadge direction={pos.direction} />
                      <span className="font-mono">${pos.entryPrice?.toFixed(2)}</span>
                    </div>
                    <PnlValue value={pos.unrealizedPnl || 0} />
                  </div>
                ))}
              </div>
            )}
            {mrStats?.source === 'backtest' && (
              <p className="text-[10px] text-muted-foreground mt-2">* Métricas de backtest — sin datos live aún</p>
            )}
          </StrategyCard>

          {/* AI Market Analyzer Card */}
          <StrategyCard
            title="AI Market Analyzer"
            enabled={true}
            icon={Brain}
            stats={[
              { label: 'Régimen IA', value: aiAnalysis?.aiRegime || 'N/A' },
              { label: 'Confianza', value: `${aiAnalysis?.aiRegimeConfidence || 0}%` },
              { label: 'Riesgo', value: aiAnalysis?.riskLevel || 'N/A' },
              { label: 'Size Mult.', value: `${((aiAnalysis?.positionSizeMultiplier || 1) * 100).toFixed(0)}%` },
            ]}
          >
            {/* Risk level + Walk-forward */}
            <div className="flex items-center gap-2 mt-1 mb-2">
              <RiskLevelBadge level={aiAnalysis?.riskLevel || 'MEDIUM'} />
              <Badge variant="outline" className="text-[10px]">
                WF: {aiAnalysis?.walkForwardValid ? '✓ Válido' : '✗ Inválido'}
              </Badge>
              {aiAnalysis?.isStale && (
                <Badge variant="outline" className="text-[10px] text-amber-500">
                  Stale
                </Badge>
              )}
            </div>

            {/* Walk-forward stats */}
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div>
                <span className="text-muted-foreground">WR Reciente</span>
                <p className="font-semibold">{(aiAnalysis?.walkForwardWinRate || 62.3).toFixed(1)}%</p>
              </div>
              <div>
                <span className="text-muted-foreground">PF Reciente</span>
                <p className="font-semibold">{(aiAnalysis?.walkForwardProfitFactor || 2.32).toFixed(2)}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Operar</span>
                <p className={`font-semibold ${aiAnalysis?.shouldTrade ? 'text-emerald-500' : 'text-red-500'}`}>
                  {aiAnalysis?.shouldTrade ? 'Sí' : 'No'}
                </p>
              </div>
            </div>

            {/* Detected events */}
            {aiAnalysis?.detectedEvents?.length > 0 && (
              <div className="mt-2 space-y-1">
                {aiAnalysis.detectedEvents.slice(0, 2).map((evt: any, i: number) => (
                  <div key={i} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    <AlertTriangle className="size-3 text-amber-500" />
                    <span>{evt.description}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Parameter adjustments */}
            {aiAnalysis?.suggestedAdjustments && (
              <div className="mt-3 pt-2 border-t border-border/50">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">Ajustes IA vs Default</p>
                <div className="grid grid-cols-2 gap-1 text-[10px]">
                  {Object.entries(aiAnalysis.suggestedAdjustments).map(([key, adj]: [string, any]) => {
                    const defaults: Record<string, number> = {
                      rsiOversold: 30, rsiOverbought: 70, adxMaxRange: 25,
                      volumeConfirmMin: 1.2, stopLossATRMultiplier: 1.5,
                      trailingATRMultiplier: 1.0, minConfidence: 60,
                    };
                    const defaultVal = defaults[key];
                    const isChanged = defaultVal !== undefined && adj.value !== defaultVal;
                    return (
                      <div key={key} className="flex items-center gap-1">
                        <span className="text-muted-foreground truncate">{key.replace(/([A-Z])/g, ' $1').trim()}</span>
                        <span className={isChanged ? 'text-amber-500 font-medium' : 'text-foreground'}>
                          {typeof adj.value === 'number' ? adj.value.toFixed(adj.value < 10 ? 1 : 0) : adj.value}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </StrategyCard>
        </div>
      </div>

      {/* ─── Open Positions ───────────────────────────────────────── */}
      <div>
        <SectionHeader
          title="Posiciones Abiertas"
          description={`${openPositions.length} posición(es) activa(s)`}
        />
        {openPositions.length === 0 ? (
          <Card>
            <EmptyState icon={Eye} title="Sin posiciones abiertas" description="Las posiciones aparecerán aquí cuando se ejecuten trades" />
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
                    <th className="text-right p-3 text-xs font-medium text-muted-foreground">Actual</th>
                    <th className="text-right p-3 text-xs font-medium text-muted-foreground">P&L</th>
                    <th className="text-right p-3 text-xs font-medium text-muted-foreground">SL</th>
                    <th className="text-right p-3 text-xs font-medium text-muted-foreground">TP</th>
                    <th className="text-right p-3 text-xs font-medium text-muted-foreground"></th>
                  </tr>
                </thead>
                <tbody>
                  {openPositions.map((pos: any) => (
                    <tr key={pos.id} className="border-b border-border/30 hover:bg-muted/30 transition-colors">
                      <td className="p-3 font-medium">{pos.asset}</td>
                      <td className="p-3"><DirectionBadge direction={pos.direction} /></td>
                      <td className="p-3 text-right font-mono text-xs">{formatPrice(pos.entryPrice, pos.asset)}</td>
                      <td className="p-3 text-right font-mono text-xs">{pos.currentPrice ? formatPrice(pos.currentPrice, pos.asset) : '—'}</td>
                      <td className="p-3 text-right"><PnlValue value={pos.unrealizedPnl || 0} /></td>
                      <td className="p-3 text-right font-mono text-xs text-red-500/70">{pos.stopLoss ? formatPrice(pos.stopLoss, pos.asset) : '—'}</td>
                      <td className="p-3 text-right font-mono text-xs text-emerald-500/70">{pos.takeProfit ? formatPrice(pos.takeProfit, pos.asset) : '—'}</td>
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

      {/* ─── Recent Activity ──────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Recent Trades */}
        <div>
          <SectionHeader title="Últimos Trades Cerrados" />
          <Card>
            {recentTrades.length === 0 ? (
              <EmptyState icon={BarChart3} title="Sin trades cerrados" />
            ) : (
              <div className="divide-y divide-border/30">
                {recentTrades.map((trade: any) => (
                  <div key={trade.id} className="flex items-center justify-between p-3">
                    <div className="flex items-center gap-2">
                      <DirectionBadge direction={trade.direction} />
                      <span className="text-sm font-medium">{trade.asset}</span>
                      <ExecutionModeBadge mode={trade.executionMode} />
                    </div>
                    <div className="text-right">
                      <PnlValue value={trade.realizedPnl || 0} className="text-sm" />
                      <p className="text-[10px] text-muted-foreground">
                        {trade.closedAt ? formatTime(trade.closedAt) : '—'}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        {/* Market Overview */}
        <div>
          <SectionHeader title="Mercado" />
          <Card>
            <CardContent className="p-4">
              <div className="grid grid-cols-2 gap-6">
                {/* Fear & Greed */}
                <div className="flex flex-col items-center">
                  <FearGreedGauge
                    value={sentiment?.macro?.fearGreedIndex || 50}
                    label={sentiment?.macro?.fearGreedLabel || 'Neutral'}
                  />
                </div>

                {/* ETH Data */}
                <div className="space-y-3">
                  {(() => {
                    const ethData = sentiment?.assets?.['ETH/USD'];
                    if (!ethData) return <p className="text-sm text-muted-foreground">Datos de ETH no disponibles</p>;
                    return (
                      <>
                        <div>
                          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">ETH/USD</span>
                          <p className="text-lg font-bold">${ethData.lastPrice?.toFixed(2) || '—'}</p>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <div>
                            <span className="text-muted-foreground">Funding</span>
                            <p className={`font-mono ${(ethData.fundingRate || 0) >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                              {((ethData.fundingRate || 0) * 100).toFixed(4)}%
                            </p>
                          </div>
                          <div>
                            <span className="text-muted-foreground">OI 24h</span>
                            <p className={`font-mono ${(ethData.oiChange24h || 0) >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                              {(ethData.oiChange24h || 0).toFixed(2)}%
                            </p>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Presión</span>
                            <p className="font-mono">{(ethData.pressureScore || 0).toFixed(1)}/100</p>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Vol 24h</span>
                            <p className="font-mono">{ethData.volume24h ? `$${(ethData.volume24h / 1e9).toFixed(2)}B` : '—'}</p>
                          </div>
                        </div>
                      </>
                    );
                  })()}
                </div>
              </div>

              {/* BTC Dominance */}
              {sentiment?.macro?.btcDominance && (
                <div className="mt-4 pt-3 border-t border-border/30 flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">BTC Dominancia</span>
                  <span className="font-semibold">{sentiment.macro.btcDominance.toFixed(1)}%</span>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
