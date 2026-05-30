'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

// ─── Types ────────────────────────────────────────────────────────────────

export interface WorkerStatus {
  workerConnected: boolean;
  autoTraderRunning: boolean;
  lastCheck: string | null;
  lastCheckAgo: string;
  autoExecution: { enabled: boolean; mode: string };
  autoTraderConfig: any;
  strategyManagerConfig: any;
  lastCycleResult: any;
  riskConfig: any;
  account: {
    balance: number;
    equity: number;
    unrealizedPnl: number;
    isLive: boolean;
    isCircuitBreaker: boolean;
    circuitBreakerReason: string | null;
    peakEquity: number;
    maxDrawdown: number;
    lastSyncAt: string | null;
  } | null;
  openPositionsCount: number;
  todaySignalsCount: number;
  todayTradesCount: number;
}

export interface StrategyStatus {
  config: any;
  lastCycle: any;
  regime: string;
  session: string;
  meanReversion: {
    stats: any;
    openPositions: any[];
    signalCount: number;
  };
  orderFlow: {
    stats: any;
    signalCount: number;
  };
  fundingArb: { activePositions: any[] };
  gridTrading: { activeGrids: any[] };
  strategyPositionsCount: number;
}

export interface AIAnalysis {
  aiRegime: string;
  aiRegimeConfidence: number;
  aiRegimeReasoning: string;
  suggestedAdjustments: any;
  walkForwardValid: boolean;
  walkForwardWinRate: number;
  walkForwardProfitFactor: number;
  riskLevel: string;
  positionSizeMultiplier: number;
  detectedEvents: any[];
  shouldTrade: boolean;
  overallReasoning: string;
  timestamp: string | null;
  isStale: boolean;
  walkForward: {
    totalTrades: number;
    recentTrades: number;
    recentWinRate: number;
    recentProfitFactor: number;
  };
}

export interface TradingData {
  engine: any;
  account: any;
  riskState: any;
  riskConfig: any;
  openPositions: any[];
  recentTrades: any[];
  stats: {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnl: number;
    totalCommission: number;
    avgPnl: number;
    profitFactor: number;
  };
}

export interface SignalsData {
  signals: any[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface MarketSentiment {
  macro: {
    fearGreedIndex: number;
    fearGreedLabel: string;
    btcDominance: number;
    totalMarketCap: number;
    totalVolume24h: number;
    timestamp: string;
  } | null;
  assets: Record<string, any>;
  lastUpdated: string | null;
}

export interface SignalsStats {
  totalSignals: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  averageConfidence: number;
  profitFactor: number;
}

// ─── Hooks ────────────────────────────────────────────────────────────────

export function useWorkerStatus() {
  return useQuery<WorkerStatus>({
    queryKey: ['worker-status'],
    queryFn: async () => {
      const res = await fetch('/api/worker-status');
      if (!res.ok) throw new Error('Error fetching worker status');
      return res.json();
    },
    refetchInterval: 15000,
  });
}

export function useStrategyStatus() {
  return useQuery<StrategyStatus>({
    queryKey: ['strategy-status'],
    queryFn: async () => {
      const res = await fetch('/api/strategy-status');
      if (!res.ok) throw new Error('Error fetching strategy status');
      return res.json();
    },
    refetchInterval: 30000,
  });
}

export function useAIAnalysis() {
  return useQuery<AIAnalysis>({
    queryKey: ['ai-analysis'],
    queryFn: async () => {
      const res = await fetch('/api/ai-analysis');
      if (!res.ok) throw new Error('Error fetching AI analysis');
      return res.json();
    },
    refetchInterval: 60000, // AI analysis cached for 30 min, no need to poll fast
  });
}

export function useTradingData() {
  return useQuery<TradingData>({
    queryKey: ['trading'],
    queryFn: async () => {
      const res = await fetch('/api/trading');
      if (!res.ok) throw new Error('Error fetching trading data');
      return res.json();
    },
    refetchInterval: 15000,
  });
}

export function useSignals(params?: {
  page?: number;
  limit?: number;
  direction?: string;
  asset?: string;
  timeframe?: string;
  status?: string;
}) {
  const searchParams = new URLSearchParams();
  if (params?.page) searchParams.set('page', params.page.toString());
  if (params?.limit) searchParams.set('limit', params.limit.toString());
  if (params?.direction && params.direction !== 'ALL') searchParams.set('direction', params.direction);
  if (params?.asset && params.asset !== 'ALL') searchParams.set('asset', params.asset);
  if (params?.timeframe && params.timeframe !== 'ALL') searchParams.set('timeframe', params.timeframe);
  if (params?.status && params.status !== 'ALL') searchParams.set('status', params.status);

  return useQuery<SignalsData>({
    queryKey: ['signals', params],
    queryFn: async () => {
      const res = await fetch(`/api/signals?${searchParams.toString()}`);
      if (!res.ok) throw new Error('Error fetching signals');
      return res.json();
    },
    refetchInterval: 30000,
  });
}

export function useSignalsStats() {
  return useQuery<SignalsStats>({
    queryKey: ['signals-stats'],
    queryFn: async () => {
      const res = await fetch('/api/signals/stats');
      if (!res.ok) throw new Error('Error fetching stats');
      return res.json();
    },
    refetchInterval: 30000,
  });
}

export function useMarketSentiment() {
  return useQuery<MarketSentiment>({
    queryKey: ['market-sentiment'],
    queryFn: async () => {
      const res = await fetch('/api/market-sentiment');
      if (!res.ok) throw new Error('Error fetching market sentiment');
      return res.json();
    },
    refetchInterval: 60000,
  });
}

export function useAlerts() {
  return useQuery<any[]>({
    queryKey: ['alerts'],
    queryFn: async () => {
      const res = await fetch('/api/signals/alerts');
      if (!res.ok) throw new Error('Error fetching alerts');
      return res.json();
    },
    refetchInterval: 30000,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────

export function useClosePosition() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (positionId: string) => {
      const res = await fetch('/api/trading', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'close-position', positionId }),
      });
      if (!res.ok) throw new Error('Error closing position');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trading'] });
      queryClient.invalidateQueries({ queryKey: ['worker-status'] });
    },
  });
}

export function useCloseAllPositions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/trading', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'close-all' }),
      });
      if (!res.ok) throw new Error('Error closing all positions');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trading'] });
      queryClient.invalidateQueries({ queryKey: ['worker-status'] });
    },
  });
}

export function useUpdateRiskConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (config: any) => {
      const res = await fetch('/api/trading', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update-risk-config', config }),
      });
      if (!res.ok) throw new Error('Error updating risk config');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trading'] });
      queryClient.invalidateQueries({ queryKey: ['worker-status'] });
    },
  });
}

export function useDeactivateCircuitBreaker() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/trading', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'deactivate-circuit-breaker' }),
      });
      if (!res.ok) throw new Error('Error deactivating circuit breaker');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trading'] });
      queryClient.invalidateQueries({ queryKey: ['worker-status'] });
    },
  });
}

export function useSetBrokerKeys() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ apiKey, apiSecret, testnet }: { apiKey: string; apiSecret: string; testnet?: boolean }) => {
      const res = await fetch('/api/trading', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-broker-keys', apiKey, apiSecret, testnet }),
      });
      if (!res.ok) throw new Error('Error setting broker keys');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trading'] });
      queryClient.invalidateQueries({ queryKey: ['worker-status'] });
    },
  });
}

export function useAutoTraderAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ action, config }: { action: string; config?: any }) => {
      const res = await fetch('/api/auto-trader', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, config }),
      });
      if (!res.ok) throw new Error(`Error with auto-trader action: ${action}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['worker-status'] });
      queryClient.invalidateQueries({ queryKey: ['strategy-status'] });
      queryClient.invalidateQueries({ queryKey: ['signals'] });
    },
  });
}

export function useSetBalance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (balance: number) => {
      const res = await fetch('/api/trading', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-balance', balance }),
      });
      if (!res.ok) throw new Error('Error setting balance');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trading'] });
      queryClient.invalidateQueries({ queryKey: ['worker-status'] });
    },
  });
}
