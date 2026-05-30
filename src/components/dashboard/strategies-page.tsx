'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import {
  TrendingUp, TrendingDown, Brain, BarChart3, Shield,
  Activity, Zap, Eye, Layers, AlertTriangle,
} from 'lucide-react';
import { StrategyCard } from './shared';
import { RegimeBadge, RiskLevelBadge, DirectionBadge, SessionBadge, PnlValue } from './status-badges';
import { SectionHeader } from './shared';
import { useStrategyStatus, useAIAnalysis } from '@/lib/hooks/use-api';

export function StrategiesPage() {
  const { data: strategy, isLoading: strategyLoading } = useStrategyStatus();
  const { data: aiAnalysis, isLoading: aiLoading } = useAIAnalysis();

  if (strategyLoading && aiLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}><CardContent className="p-4"><Skeleton className="h-60 w-full" /></CardContent></Card>
          ))}
        </div>
      </div>
    );
  }

  const config = strategy?.config;
  const lastCycle = strategy?.lastCycle;
  const mrStats = strategy?.meanReversion?.stats;

  return (
    <div className="space-y-6">
      {/* Strategy Manager Overview */}
      <div>
        <SectionHeader
          title="Strategy Manager"
          description="Orquestador central de estrategias"
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-4">
              <span className="text-xs text-muted-foreground uppercase tracking-wider">Estado</span>
              <div className="flex items-center gap-2 mt-1">
                <span className={`size-2.5 rounded-full ${config?.enabled ? 'bg-emerald-500' : 'bg-zinc-400'}`} />
                <p className="text-lg font-bold">{config?.enabled ? 'Activo' : 'Inactivo'}</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <span className="text-xs text-muted-foreground uppercase tracking-wider">Régimen</span>
              <div className="mt-1"><RegimeBadge regime={strategy?.regime || 'UNKNOWN'} /></div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <span className="text-xs text-muted-foreground uppercase tracking-wider">Sesión</span>
              <div className="mt-1"><SessionBadge session={strategy?.session || 'OffHours'} /></div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <span className="text-xs text-muted-foreground uppercase tracking-wider">Exposición Total</span>
              <p className="text-lg font-bold mt-1">${(lastCycle?.totalExposureUsd || 0).toFixed(2)}</p>
              <p className="text-xs text-muted-foreground">Máx: ${config?.maxTotalExposureUsd || 10000}</p>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Strategy Toggles */}
      <div>
        <SectionHeader title="Estrategias Activas" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card className="p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Funding Arb</span>
              <Badge className={`${config?.strategies?.fundingArb?.enabled ? 'bg-emerald-500/10 text-emerald-600' : 'bg-zinc-500/10 text-zinc-500'} text-[10px] border`}>
                {config?.strategies?.fundingArb?.enabled ? 'ON' : 'OFF'}
              </Badge>
            </div>
          </Card>
          <Card className="p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Grid Trading</span>
              <Badge className={`${config?.strategies?.gridTrading?.enabled ? 'bg-emerald-500/10 text-emerald-600' : 'bg-zinc-500/10 text-zinc-500'} text-[10px] border`}>
                {config?.strategies?.gridTrading?.enabled ? 'ON' : 'OFF'}
              </Badge>
            </div>
          </Card>
          <Card className="p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Mean Reversion</span>
              <Badge className={`${config?.strategies?.meanReversion?.enabled ? 'bg-emerald-500/10 text-emerald-600' : 'bg-zinc-500/10 text-zinc-500'} text-[10px] border`}>
                {config?.strategies?.meanReversion?.enabled ? 'ON' : 'OFF'}
              </Badge>
            </div>
          </Card>
          <Card className="p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Order Flow</span>
              <Badge className={`${config?.strategies?.orderFlow?.enabled ? 'bg-emerald-500/10 text-emerald-600' : 'bg-zinc-500/10 text-zinc-500'} text-[10px] border`}>
                {config?.strategies?.orderFlow?.enabled ? 'ON' : 'OFF'}
              </Badge>
            </div>
          </Card>
        </div>
      </div>

      {/* Detailed Strategy Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Mean Reversion Detail */}
        <StrategyCard
          title="Mean Reversion — Detalle"
          enabled={config?.strategies?.meanReversion?.enabled ?? true}
          icon={TrendingUp}
          stats={[
            { label: 'Profit Factor', value: mrStats?.profitFactor?.toFixed(2) || '2.32' },
            { label: 'Win Rate', value: `${(mrStats?.winRate || 62.3).toFixed(1)}%` },
            { label: 'Sharpe Ratio', value: mrStats?.sharpeRatio?.toFixed(2) || '6.04' },
            { label: 'Total Trades', value: mrStats?.totalTrades || 0 },
            { label: 'Total Wins', value: mrStats?.totalWins || 0 },
            { label: 'Total Losses', value: mrStats?.totalLosses || 0 },
            { label: 'Total P&L', value: `$${(mrStats?.totalPnl || 0).toFixed(2)}` },
            { label: 'Avg P&L/Trade', value: `$${(mrStats?.avgPnlPerTrade || 0).toFixed(2)}` },
          ]}
        >
          {/* Config details */}
          {config?.strategies?.meanReversion && (
            <div className="mt-3 pt-2 border-t border-border/50">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">Configuración</p>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div>
                  <span className="text-muted-foreground">Assets</span>
                  <p className="font-medium">{config.strategies.meanReversion.assets?.join(', ') || 'ETH/USD'}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Timeframe</span>
                  <p className="font-medium">{config.strategies.meanReversion.timeframe || 'H1'}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Min Conf.</span>
                  <p className="font-medium">{config.strategies.meanReversion.minConfidence || 60}%</p>
                </div>
              </div>
            </div>
          )}
        </StrategyCard>

        {/* AI Analyzer Detail */}
        <StrategyCard
          title="AI Market Analyzer — Detalle"
          enabled={true}
          icon={Brain}
          stats={[
            { label: 'Régimen IA', value: aiAnalysis?.aiRegime || 'N/A' },
            { label: 'Confianza', value: `${aiAnalysis?.aiRegimeConfidence || 0}%` },
            { label: 'Riesgo', value: aiAnalysis?.riskLevel || 'N/A' },
            { label: 'Size Mult.', value: `${((aiAnalysis?.positionSizeMultiplier || 1) * 100).toFixed(0)}%` },
          ]}
        >
          {/* Walk-forward */}
          <div className="mt-2">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">Walk-Forward Validation</p>
            <div className="grid grid-cols-4 gap-2 text-xs">
              <div>
                <span className="text-muted-foreground">Estado</span>
                <p className={`font-semibold ${aiAnalysis?.walkForwardValid ? 'text-emerald-500' : 'text-red-500'}`}>
                  {aiAnalysis?.walkForwardValid ? 'Válido' : 'Inválido'}
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">WR Reciente</span>
                <p className="font-semibold">{(aiAnalysis?.walkForwardWinRate || 0).toFixed(1)}%</p>
              </div>
              <div>
                <span className="text-muted-foreground">PF Reciente</span>
                <p className="font-semibold">{(aiAnalysis?.walkForwardProfitFactor || 0).toFixed(2)}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Trades</span>
                <p className="font-semibold">{aiAnalysis?.walkForward?.totalTrades || 0}</p>
              </div>
            </div>
          </div>

          {/* Parameter Adjustments */}
          {aiAnalysis?.suggestedAdjustments && (
            <div className="mt-3 pt-2 border-t border-border/50">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">Ajustes de Parámetros</p>
              <div className="space-y-1.5">
                {Object.entries(aiAnalysis.suggestedAdjustments).map(([key, adj]: [string, any]) => {
                  const defaults: Record<string, number> = {
                    rsiOversold: 30, rsiOverbought: 70, adxMaxRange: 25,
                    volumeConfirmMin: 1.2, stopLossATRMultiplier: 1.5,
                    trailingATRMultiplier: 1.0, minConfidence: 60,
                  };
                  const defaultVal = defaults[key];
                  const isChanged = defaultVal !== undefined && adj.value !== defaultVal;
                  return (
                    <div key={key} className="flex items-center gap-2 text-xs">
                      <span className={`size-1.5 rounded-full ${isChanged ? 'bg-amber-500' : 'bg-emerald-500'}`} />
                      <span className="text-muted-foreground w-36 truncate">{key.replace(/([A-Z])/g, ' $1').trim()}</span>
                      <span className="font-mono text-muted-foreground/60">{defaultVal}</span>
                      <span className="text-muted-foreground/40">→</span>
                      <span className={`font-mono font-medium ${isChanged ? 'text-amber-500' : 'text-foreground'}`}>
                        {typeof adj.value === 'number' ? adj.value.toFixed(adj.value < 10 ? 1 : 0) : adj.value}
                      </span>
                      {isChanged && (
                        <span className="text-[9px] text-amber-500/80 truncate max-w-28">{adj.reason}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Detected Events */}
          {aiAnalysis?.detectedEvents && aiAnalysis.detectedEvents.length > 0 && (
            <div className="mt-3 pt-2 border-t border-border/50">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">Eventos Detectados</p>
              <div className="space-y-1">
                {aiAnalysis.detectedEvents.map((evt: any, i: number) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <AlertTriangle className={`size-3 ${evt.impact === 'HIGH' ? 'text-red-500' : evt.impact === 'MEDIUM' ? 'text-amber-500' : 'text-muted-foreground'}`} />
                    <span className="text-foreground">{evt.description}</span>
                    <Badge variant="outline" className="text-[9px] ml-auto">
                      {evt.impact}
                    </Badge>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Reasoning */}
          {aiAnalysis?.overallReasoning && (
            <div className="mt-3 pt-2 border-t border-border/50">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Razonamiento</p>
              <p className="text-xs text-muted-foreground leading-relaxed">{aiAnalysis.overallReasoning}</p>
            </div>
          )}
        </StrategyCard>
      </div>

      {/* Last Cycle Results */}
      {lastCycle && (
        <div>
          <SectionHeader
            title="Último Ciclo"
            description={lastCycle.timestamp ? new Date(lastCycle.timestamp).toLocaleString('es-ES') : ''}
          />
          <Card>
            <CardContent className="p-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                <div>
                  <span className="text-xs text-muted-foreground">MR Señales</span>
                  <p className="font-semibold">{lastCycle.meanReversion?.signalsGenerated || 0}</p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">MR Trades</span>
                  <p className="font-semibold">{lastCycle.meanReversion?.tradesOpened || 0}</p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">OF Snapshots</span>
                  <p className="font-semibold">{lastCycle.orderFlow?.snapshotsTaken || 0}</p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">P&L Ciclo</span>
                  <PnlValue value={lastCycle.totalPnl || 0} />
                </div>
              </div>

              {/* Recommendations */}
              {lastCycle.strategyRecommendations?.length > 0 && (
                <div className="mt-4 pt-3 border-t border-border/30">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Recomendaciones</p>
                  <div className="space-y-1">
                    {lastCycle.strategyRecommendations.map((rec: string, i: number) => (
                      <p key={i} className="text-xs text-muted-foreground">• {rec}</p>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
