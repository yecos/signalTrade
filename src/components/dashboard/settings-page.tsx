'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Shield, Zap, Key, Play, Square, RotateCcw, Settings,
  AlertTriangle, Save, Loader2,
} from 'lucide-react';
import { SectionHeader, CircuitBreakerAlert } from './shared';
import { ExecutionModeBadge } from './status-badges';
import {
  useWorkerStatus, useTradingData,
  useUpdateRiskConfig, useDeactivateCircuitBreaker,
  useSetBrokerKeys, useAutoTraderAction, useSetBalance,
} from '@/lib/hooks/use-api';
import { toast } from 'sonner';

export function SettingsPage() {
  const { data: worker, isLoading: workerLoading } = useWorkerStatus();
  const { data: trading, isLoading: tradingLoading } = useTradingData();

  const updateRiskConfig = useUpdateRiskConfig();
  const deactivateCB = useDeactivateCircuitBreaker();
  const setBrokerKeys = useSetBrokerKeys();
  const autoTraderAction = useAutoTraderAction();
  const setBalance = useSetBalance();

  const account = trading?.account || worker?.account;
  const riskConfig = trading?.riskConfig || worker?.riskConfig;

  // Risk config form
  const [riskPerTrade, setRiskPerTrade] = useState(riskConfig?.riskPerTrade?.toString() || '1');
  const [maxDailyLoss, setMaxDailyLoss] = useState(riskConfig?.maxDailyLoss?.toString() || '3');
  const [maxOpenPositions, setMaxOpenPositions] = useState(riskConfig?.maxOpenPositions?.toString() || '3');
  const [maxDrawdownPct, setMaxDrawdownPct] = useState(riskConfig?.maxDrawdownPct?.toString() || '10');

  // Broker keys form
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [testnet, setTestnet] = useState(true);

  // Balance form
  const [newBalance, setNewBalance] = useState('');

  if (workerLoading && tradingLoading) {
    return (
      <div className="space-y-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}><CardContent className="p-4"><Skeleton className="h-40 w-full" /></CardContent></Card>
        ))}
      </div>
    );
  }

  const handleSaveRiskConfig = () => {
    updateRiskConfig.mutate({
      riskPerTrade: parseFloat(riskPerTrade) || 1,
      maxDailyLoss: parseFloat(maxDailyLoss) || 3,
      maxOpenPositions: parseInt(maxOpenPositions) || 3,
      maxDrawdownPct: parseFloat(maxDrawdownPct) || 10,
    }, {
      onSuccess: () => toast.success('Configuración de riesgo actualizada'),
      onError: () => toast.error('Error al actualizar configuración'),
    });
  };

  const handleSetBrokerKeys = () => {
    if (!apiKey.trim() || !apiSecret.trim()) {
      toast.error('API Key y Secret son requeridos');
      return;
    }
    setBrokerKeys.mutate({ apiKey, apiSecret, testnet }, {
      onSuccess: () => {
        toast.success(`Bybit ${testnet ? 'TESTNET' : 'MAINNET'} keys configuradas`);
        setApiKey('');
        setApiSecret('');
      },
      onError: () => toast.error('Error al configurar broker keys'),
    });
  };

  const handleSetBalance = () => {
    const balance = parseFloat(newBalance);
    if (isNaN(balance) || balance < 0) {
      toast.error('Balance inválido');
      return;
    }
    setBalance.mutate(balance, {
      onSuccess: () => {
        toast.success('Balance actualizado');
        setNewBalance('');
      },
      onError: () => toast.error('Error al actualizar balance'),
    });
  };

  const handlePreset = async (preset: string) => {
    autoTraderAction.mutate(
      { action: 'update-config', config: { preset } },
      {
        onSuccess: () => toast.success(`Preset ${preset} aplicado`),
        onError: () => toast.error('Error al aplicar preset'),
      }
    );
  };

  return (
    <div className="space-y-6">
      {/* Circuit Breaker */}
      {account?.isCircuitBreaker && (
        <CircuitBreakerAlert
          reason={account.circuitBreakerReason}
          onReset={() => deactivateCB.mutate(undefined)}
        />
      )}

      {/* Worker Control */}
      <div>
        <SectionHeader title="Control del Worker" description="Iniciar, detener o ejecutar ciclo manual" />
        <Card>
          <CardContent className="p-4">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <span className={`size-3 rounded-full ${worker?.workerConnected ? 'bg-emerald-500 animate-pulse' : 'bg-red-400'}`} />
                <div>
                  <p className="text-sm font-medium">
                    {worker?.autoTraderRunning ? 'Worker en ejecución' : 'Worker detenido'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Último check: {worker?.lastCheckAgo || 'Nunca'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="default"
                  className="h-8 text-xs gap-1.5"
                  onClick={() => autoTraderAction.mutate(
                    { action: 'start', config: worker?.autoTraderConfig || { enabled: true } },
                    {
                      onSuccess: () => toast.success('Worker iniciado'),
                      onError: () => toast.error('Error al iniciar worker'),
                    }
                  )}
                  disabled={autoTraderAction.isPending || worker?.autoTraderRunning}
                >
                  <Play className="size-3.5" /> Iniciar
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-8 text-xs gap-1.5"
                  onClick={() => autoTraderAction.mutate(
                    { action: 'stop' },
                    {
                      onSuccess: () => toast.success('Worker detenido'),
                      onError: () => toast.error('Error al detener worker'),
                    }
                  )}
                  disabled={autoTraderAction.isPending || !worker?.autoTraderRunning}
                >
                  <Square className="size-3.5" /> Detener
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs gap-1.5"
                  onClick={() => autoTraderAction.mutate(
                    { action: 'run-cycle' },
                    {
                      onSuccess: (data: any) => {
                        toast.success(`Ciclo ejecutado: ${data.signalsGenerated || 0} señales generadas`);
                      },
                      onError: () => toast.error('Error al ejecutar ciclo'),
                    }
                  )}
                  disabled={autoTraderAction.isPending}
                >
                  <RotateCcw className="size-3.5" /> Ejecutar Ciclo
                </Button>
              </div>
            </div>

            {/* Auto-Execution */}
            <Separator className="my-4" />
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Auto-Ejecución</p>
                <p className="text-xs text-muted-foreground">
                  Ejecutar trades automáticamente cuando se generen señales
                </p>
              </div>
              <div className="flex items-center gap-3">
                <ExecutionModeBadge mode={worker?.autoExecution?.mode || 'PAPER'} />
                {worker?.autoExecution?.enabled ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs text-red-500"
                    onClick={() => {
                      fetch('/api/trading', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action: 'disable-auto-execution' }),
                      }).then(() => toast.success('Auto-ejecución deshabilitada'));
                    }}
                  >
                    Deshabilitar
                  </Button>
                ) : (
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => {
                        fetch('/api/trading', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ action: 'enable-auto-execution', mode: 'PAPER' }),
                        }).then(() => toast.success('Auto-ejecución PAPER habilitada'));
                      }}
                    >
                      PAPER
                    </Button>
                    <Button
                      size="sm"
                      variant="default"
                      className="h-7 text-xs"
                      onClick={() => {
                        fetch('/api/trading', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ action: 'enable-auto-execution', mode: 'LIVE' }),
                        }).then(() => toast.success('Auto-ejecución LIVE habilitada'));
                      }}
                    >
                      LIVE
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Strategy Presets */}
      <div>
        <SectionHeader title="Presets de Estrategia" description="Configuraciones predefinidas para el Strategy Manager" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Card className="p-4 hover:shadow-md transition-shadow cursor-pointer" onClick={() => handlePreset('DRY_RUN')}>
            <div className="flex items-center gap-2 mb-2">
              <Badge className="bg-sky-500/10 text-sky-600 border-sky-500/20 border text-[10px]">DRY RUN</Badge>
            </div>
            <p className="text-sm font-medium">Ejecución en Paper</p>
            <p className="text-xs text-muted-foreground mt-1">Mean Reversion H1 + Order Flow. Sin riesgo real.</p>
          </Card>
          <Card className="p-4 hover:shadow-md transition-shadow cursor-pointer" onClick={() => handlePreset('CONSERVATIVE')}>
            <div className="flex items-center gap-2 mb-2">
              <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20 border text-[10px]">CONSERVADOR</Badge>
            </div>
            <p className="text-sm font-medium">Bajo Riesgo</p>
            <p className="text-xs text-muted-foreground mt-1">MR ETH/USD H1 conf≥75%. Exp max $5K.</p>
          </Card>
          <Card className="p-4 hover:shadow-md transition-shadow cursor-pointer" onClick={() => handlePreset('MODERATE')}>
            <div className="flex items-center gap-2 mb-2">
              <Badge className="bg-amber-500/10 text-amber-600 border-amber-500/20 border text-[10px]">MODERADO</Badge>
            </div>
            <p className="text-sm font-medium">Riesgo Medio</p>
            <p className="text-xs text-muted-foreground mt-1">MR + Grid ETH. Exp max $10K.</p>
          </Card>
          <Card className="p-4 hover:shadow-md transition-shadow cursor-pointer" onClick={() => handlePreset('AGGRESSIVE')}>
            <div className="flex items-center gap-2 mb-2">
              <Badge className="bg-red-500/10 text-red-600 border-red-500/20 border text-[10px]">AGRESIVO</Badge>
            </div>
            <p className="text-sm font-medium">Alto Riesgo</p>
            <p className="text-xs text-muted-foreground mt-1">MR + Grid multi-asset. Exp max $20K.</p>
          </Card>
        </div>
      </div>

      {/* Risk Configuration */}
      <div>
        <SectionHeader title="Configuración de Riesgo" />
        <Card>
          <CardContent className="p-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-xs">Riesgo por Trade (%)</Label>
                <Input
                  type="number"
                  value={riskPerTrade}
                  onChange={(e) => setRiskPerTrade(e.target.value)}
                  className="h-8 text-sm"
                  step="0.5"
                  min="0.1"
                  max="5"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-xs">Pérdida Diaria Máxima (%)</Label>
                <Input
                  type="number"
                  value={maxDailyLoss}
                  onChange={(e) => setMaxDailyLoss(e.target.value)}
                  className="h-8 text-sm"
                  step="0.5"
                  min="1"
                  max="10"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-xs">Posiciones Abiertas Máximas</Label>
                <Input
                  type="number"
                  value={maxOpenPositions}
                  onChange={(e) => setMaxOpenPositions(e.target.value)}
                  className="h-8 text-sm"
                  step="1"
                  min="1"
                  max="10"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-xs">Drawdown Máximo (%)</Label>
                <Input
                  type="number"
                  value={maxDrawdownPct}
                  onChange={(e) => setMaxDrawdownPct(e.target.value)}
                  className="h-8 text-sm"
                  step="1"
                  min="3"
                  max="25"
                />
              </div>
            </div>
            <Button
              className="mt-4 h-8 text-xs gap-1.5"
              onClick={handleSaveRiskConfig}
              disabled={updateRiskConfig.isPending}
            >
              {updateRiskConfig.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
              Guardar Configuración
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Broker API Keys */}
      <div>
        <SectionHeader title="Broker API Keys" description="Configurar conexión con Bybit" />
        <Card>
          <CardContent className="p-4">
            <div className="space-y-4">
              <div className="flex items-center gap-3 mb-2">
                <Badge variant="outline" className="text-xs">
                  {account?.isLive ? 'LIVE' : 'PAPER'}
                </Badge>
                <Badge variant="outline" className="text-xs">
                  {account?.broker || 'PAPER'}
                </Badge>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-xs">API Key</Label>
                  <Input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="Bybit API Key"
                    className="h-8 text-sm"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs">API Secret</Label>
                  <Input
                    type="password"
                    value={apiSecret}
                    onChange={(e) => setApiSecret(e.target.value)}
                    placeholder="Bybit API Secret"
                    className="h-8 text-sm"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Switch
                    checked={testnet}
                    onCheckedChange={setTestnet}
                  />
                  <Label className="text-xs">Usar Testnet</Label>
                </div>
                <Button
                  className="h-8 text-xs gap-1.5"
                  onClick={handleSetBrokerKeys}
                  disabled={setBrokerKeys.isPending}
                >
                  {setBrokerKeys.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Key className="size-3.5" />}
                  Configurar Keys
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => {
                    fetch('/api/trading', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ action: 'test-connection' }),
                    }).then(r => r.json()).then(data => {
                      if (data.connected) toast.success('Conexión exitosa con Bybit');
                      else toast.error(`Conexión fallida: ${data.error || 'verificar keys'}`);
                    });
                  }}
                >
                  Test Conexión
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Account Balance */}
      <div>
        <SectionHeader title="Balance de Cuenta" description="Establecer balance manualmente (paper trading)" />
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-4">
              <div className="space-y-2 flex-1 max-w-xs">
                <Label className="text-xs">Nuevo Balance (USD)</Label>
                <Input
                  type="number"
                  value={newBalance}
                  onChange={(e) => setNewBalance(e.target.value)}
                  placeholder={`Actual: $${(account?.balance || 0).toFixed(2)}`}
                  className="h-8 text-sm"
                  step="100"
                  min="0"
                />
              </div>
              <Button
                className="h-8 text-xs gap-1.5 mt-5"
                onClick={handleSetBalance}
                disabled={setBalance.isPending}
              >
                <DollarSign className="size-3.5" />
                Actualizar
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function DollarSign(props: any) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <line x1="12" x2="12" y1="2" y2="22" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  );
}
