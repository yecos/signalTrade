"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  Tabs, TabsContent, TabsList, TabsTrigger,
} from "@/components/ui/tabs";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  ResponsiveContainer, LineChart, Line, PieChart, Pie, Cell, Legend,
} from "recharts";
import {
  TrendingUp, TrendingDown, Activity, BarChart3, Bell, Bot,
  RefreshCw, CheckCircle, XCircle, MinusCircle, AlertTriangle,
  Clock, Zap, Target, Shield, Brain, Eye, Loader2, ChevronLeft, ChevronRight,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Signal {
  id: string;
  asset: string;
  timeframe: string;
  direction: string;
  entryPrice: number;
  entryTime: string;
  expirationMinutes: number;
  expirationTime: string;
  confidence: number;
  aiReason: string | null;
  technicalJson: string | null;
  patternsJson: string | null;
  volumeJson: string | null;
  newsJson: string | null;
  sentimentJson: string | null;
  macroJson: string | null;
  fullAnalysisJson: string | null;
  exitPrice: number | null;
  result: string | null;
  priceDifference: number | null;
  estimatedProfit: number | null;
  estimatedLoss: number | null;
  status: string;
  analysisMode: string | null;
  dataAvailability: string | null;
  statisticalReliability: string | null;
  historicalSampleSize: number | null;
  createdAt: string;
  updatedAt: string;
}

interface Stats {
  totalSignals: number;
  winCount: number;
  lossCount: number;
  drawCount: number;
  noOperarCount: number;
  pendingCount: number;
  winRate: number;
  averageConfidence: number;
  profitFactor: number;
  totalEstimatedProfit: number;
  totalEstimatedLoss: number;
  netResult: number;
  winRateByAsset: Record<string, { wins: number; total: number; rate: number }>;
  winRateByTimeframe: Record<string, { wins: number; total: number; rate: number }>;
  winRateByDirection: Record<string, { wins: number; total: number; rate: number }>;
  winRateByHour: Record<string, { wins: number; total: number; rate: number }>;
  bestAsset: string | null;
  worstAsset: string | null;
  bestTimeframe: string | null;
  worstTimeframe: string | null;
  bestHour: string | null;
  worstHour: string | null;
  currentConsecutiveWins: number;
  currentConsecutiveLosses: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  weeklyPerformance: Array<{ week: string; wins: number; losses: number; draws: number; total: number; winRate: number }>;
  monthlyPerformance: Array<{ month: string; wins: number; losses: number; draws: number; total: number; winRate: number }>;
  recommendedConfidenceThreshold: number;
}

interface Alert {
  id: string;
  type: string;
  message: string;
  severity: string;
  isActive: boolean;
  dismissedAt: string | null;
  createdAt: string;
}

interface BacktestingInsights {
  summary: {
    totalSignals: number;
    overallWinRate: number;
    profitFactor: number;
    recommendedConfidenceThreshold: number;
    bestThresholdWinRate: number;
  };
  assetPerformance: Array<{ asset: string; wins: number; total: number; winRate: number; recommendation: string }>;
  timeframePerformance: Array<{ timeframe: string; wins: number; total: number; winRate: number; recommendation: string }>;
  directionPerformance: Array<{ direction: string; wins: number; total: number; winRate: number }>;
  hourPerformance: Array<{ hour: string; wins: number; total: number; winRate: number; recommendation: string }>;
  confidenceAnalysis: Array<{ range: string; wins: number; total: number; winRate: number }>;
  recommendedFilters: {
    goodAssets: string[];
    badAssets: string[];
    goodTimeframes: string[];
    goodHours: string[];
    badHours: string[];
    minimumConfidence: number;
    avoidConsecutiveLosses: boolean;
  };
  warnings: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ASSETS = ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "EUR/GBP", "BTC/USD", "ETH/USD"];
const TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1"];
const DIRECTIONS = ["HIGHER", "LOWER", "NO_OPERAR"];
const EXP_MAP: Record<string, number> = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60 };

const NEON_GREEN = "#00ff88";
const NEON_RED = "#ff3366";
const NEON_YELLOW = "#ffcc00";
const NEON_BLUE = "#00aaff";
const NEON_PURPLE = "#aa66ff";
const NEON_CYAN = "#00ffcc";
const CHART_COLORS = [NEON_GREEN, NEON_RED, NEON_YELLOW, NEON_BLUE, NEON_PURPLE, NEON_CYAN];

function resultColor(result: string | null): string {
  switch (result) {
    case "WIN": return "text-[#00ff88]";
    case "LOSS": return "text-[#ff3366]";
    case "DRAW": return "text-[#ffcc00]";
    case "NO_OPERAR": return "text-[#00aaff]";
    default: return "text-[#ffcc00]";
  }
}

function resultBg(result: string | null): string {
  switch (result) {
    case "WIN": return "bg-[#00ff88]/15 text-[#00ff88] border-[#00ff88]/30";
    case "LOSS": return "bg-[#ff3366]/15 text-[#ff3366] border-[#ff3366]/30";
    case "DRAW": return "bg-[#ffcc00]/15 text-[#ffcc00] border-[#ffcc00]/30";
    case "NO_OPERAR": return "bg-[#00aaff]/15 text-[#00aaff] border-[#00aaff]/30";
    default: return "bg-[#ffcc00]/15 text-[#ffcc00] border-[#ffcc00]/30";
  }
}

function statusBg(status: string): string {
  switch (status) {
    case "PENDING": return "bg-[#ffcc00]/15 text-[#ffcc00] border-[#ffcc00]/30";
    case "CLOSED": return "bg-[#00aaff]/15 text-[#00aaff] border-[#00aaff]/30";
    case "CANCELLED": return "bg-[#ff3366]/15 text-[#ff3366] border-[#ff3366]/30";
    default: return "";
  }
}

function directionIcon(direction: string) {
  if (direction === "HIGHER") return <TrendingUp className="size-3 text-[#00ff88]" />;
  if (direction === "LOWER") return <TrendingDown className="size-3 text-[#ff3366]" />;
  return <MinusCircle className="size-3 text-[#00aaff]" />;
}

function severityColor(severity: string): string {
  switch (severity) {
    case "critical": return "bg-[#ff3366]/20 text-[#ff3366] border-[#ff3366]/40";
    case "warning": return "bg-[#ffcc00]/20 text-[#ffcc00] border-[#ffcc00]/40";
    default: return "bg-[#00aaff]/20 text-[#00aaff] border-[#00aaff]/40";
  }
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("es-ES", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

function formatPrice(price: number, asset: string): string {
  if (asset.includes("JPY")) return price.toFixed(3);
  if (asset.includes("BTC")) return price.toFixed(1);
  if (asset.includes("ETH")) return price.toFixed(2);
  return price.toFixed(5);
}

function analysisModeConfig(mode: string | null): { label: string; color: string; bg: string } {
  switch (mode) {
    case "FULL": return { label: "FULL ANALYSIS", color: "#00ff88", bg: "bg-[#00ff88]/15 text-[#00ff88] border-[#00ff88]/30" };
    case "PARTIAL": return { label: "PARCIAL", color: "#ffcc00", bg: "bg-[#ffcc00]/15 text-[#ffcc00] border-[#ffcc00]/30" };
    case "FALLBACK": return { label: "FALLBACK", color: "#ff3366", bg: "bg-[#ff3366]/15 text-[#ff3366] border-[#ff3366]/30" };
    default: return { label: "FALLBACK", color: "#ff3366", bg: "bg-[#ff3366]/15 text-[#ff3366] border-[#ff3366]/30" };
  }
}

function reliabilityConfig(reliability: string | null): { label: string; color: string } {
  switch (reliability) {
    case "HIGH": return { label: "ALTA", color: "#00ff88" };
    case "MEDIUM": return { label: "MEDIA", color: "#ffcc00" };
    case "LOW": return { label: "BAJA", color: "#ff8800" };
    case "INSUFFICIENT": return { label: "INSUFICIENTE", color: "#ff3366" };
    case "MANUAL": return { label: "MANUAL", color: "#00aaff" };
    default: return { label: "INSUFICIENTE", color: "#ff3366" };
  }
}

interface DataAvail {
  technical?: boolean;
  volume?: boolean;
  patterns?: boolean;
  sentiment?: boolean;
  news?: boolean;
  macro?: boolean;
  historical?: boolean;
  aiModel?: boolean;
}

function parseDataAvailability(json: string | null): DataAvail {
  if (!json) return {};
  try { return JSON.parse(json); } catch { return {}; }
}

function DataAvailabilityBadges({ dataAvail }: { dataAvail: DataAvail }) {
  const items: { key: string; label: string; available: boolean }[] = [
    { key: "technical", label: "Técnicos", available: !!dataAvail.technical },
    { key: "volume", label: "Volumen", available: !!dataAvail.volume },
    { key: "patterns", label: "Patrones", available: !!dataAvail.patterns },
    { key: "sentiment", label: "Sentimiento", available: !!dataAvail.sentiment },
    { key: "news", label: "Noticias", available: !!dataAvail.news },
    { key: "macro", label: "Macro", available: !!dataAvail.macro },
  ];

  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item) => (
        <span
          key={item.key}
          className={`text-[9px] px-1.5 py-0.5 rounded border ${
            item.available
              ? "bg-[#00ff88]/10 text-[#00ff88] border-[#00ff88]/20"
              : "bg-[#ff3366]/10 text-[#ff3366]/60 border-[#ff3366]/20 line-through"
          }`}
        >
          {item.available ? "✔" : "✘"} {item.label}
        </span>
      ))}
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function TradingDashboard() {
  const [activeTab, setActiveTab] = useState("dashboard");

  // Data state
  const [stats, setStats] = useState<Stats | null>(null);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [insights, setInsights] = useState<BacktestingInsights | null>(null);
  const [loading, setLoading] = useState<Record<string, boolean>>({});

  // Filter state
  const [filterDirection, setFilterDirection] = useState("ALL");
  const [filterAsset, setFilterAsset] = useState("ALL");
  const [filterTimeframe, setFilterTimeframe] = useState("ALL");
  const [filterStatus, setFilterStatus] = useState("ALL");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  // Generate form state
  const [genAsset, setGenAsset] = useState("EUR/USD");
  const [genTimeframe, setGenTimeframe] = useState("M5");
  const [genDirection, setGenDirection] = useState("HIGHER");
  const [genConfidence, setGenConfidence] = useState(70);
  const [genEntryPrice, setGenEntryPrice] = useState("1.08500");
  const [genAiReason, setGenAiReason] = useState("");

  // Manual form state
  const [manualMode, setManualMode] = useState(false);

  // ─── Fetch functions ─────────────────────────────────────────────────────

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/signals/stats");
      if (res.ok) setStats(await res.json());
    } catch (err) {
      console.error("Error fetching stats:", err);
    }
  }, []);

  const fetchSignals = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      params.set("page", page.toString());
      params.set("limit", "15");
      if (filterDirection !== "ALL") params.set("direction", filterDirection);
      if (filterAsset !== "ALL") params.set("asset", filterAsset);
      if (filterTimeframe !== "ALL") params.set("timeframe", filterTimeframe);
      if (filterStatus !== "ALL") params.set("status", filterStatus);
      const res = await fetch(`/api/signals?${params}`);
      if (res.ok) {
        const data = await res.json();
        setSignals(data.signals);
        setTotalPages(data.pagination.totalPages);
      }
    } catch (err) {
      console.error("Error fetching signals:", err);
    }
  }, [page, filterDirection, filterAsset, filterTimeframe, filterStatus]);

  const fetchAlerts = useCallback(async () => {
    try {
      const res = await fetch("/api/signals/alerts");
      if (res.ok) setAlerts(await res.json());
    } catch (err) {
      console.error("Error fetching alerts:", err);
    }
  }, []);

  const fetchInsights = useCallback(async () => {
    setLoading((p) => ({ ...p, backtesting: true }));
    try {
      const res = await fetch("/api/signals/backtesting");
      if (res.ok) setInsights(await res.json());
    } catch (err) {
      console.error("Error fetching insights:", err);
    } finally {
      setLoading((p) => ({ ...p, backtesting: false }));
    }
  }, []);

  // ─── Effects ─────────────────────────────────────────────────────────────

  useEffect(() => {
    fetchStats();
    fetchAlerts();
  }, [fetchStats, fetchAlerts]);

  useEffect(() => {
    fetchSignals();
  }, [fetchSignals]);

  useEffect(() => {
    if (activeTab === "backtesting" && !insights) fetchInsights();
  }, [activeTab, insights, fetchInsights]);

  // Auto-refresh every 10 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      fetchStats();
      fetchAlerts();
      if (activeTab === "historial") fetchSignals();
    }, 10000);
    return () => clearInterval(interval);
  }, [fetchStats, fetchAlerts, fetchSignals, activeTab]);

  // ─── Handlers ────────────────────────────────────────────────────────────

  const handleGenerateAI = async () => {
    setLoading((p) => ({ ...p, generate: true }));
    try {
      const res = await fetch("/api/signals/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asset: genAsset, timeframe: genTimeframe }),
      });
      if (res.ok) {
        const data = await res.json();
        setGenAiReason(data.signal?.aiReason || "Señal generada");
        fetchStats();
        fetchSignals();
        fetchAlerts();
      }
    } catch (err) {
      console.error("Error generating signal:", err);
    } finally {
      setLoading((p) => ({ ...p, generate: false }));
    }
  };

  const handleCreateManual = async () => {
    setLoading((p) => ({ ...p, manual: true }));
    try {
      const body = {
        asset: genAsset,
        timeframe: genTimeframe,
        direction: genDirection,
        entryPrice: parseFloat(genEntryPrice),
        entryTime: new Date().toISOString(),
        expirationMinutes: EXP_MAP[genTimeframe] || 5,
        confidence: genConfidence,
        aiReason: genAiReason || "Señal manual",
      };
      const res = await fetch("/api/signals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        fetchStats();
        fetchSignals();
        fetchAlerts();
        setGenAiReason("");
      }
    } catch (err) {
      console.error("Error creating manual signal:", err);
    } finally {
      setLoading((p) => ({ ...p, manual: false }));
    }
  };

  const handleDismissAlert = async (id: string) => {
    try {
      await fetch("/api/signals/alerts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      fetchAlerts();
    } catch (err) {
      console.error("Error dismissing alert:", err);
    }
  };

  const handleCancelSignal = async (id: string) => {
    try {
      await fetch(`/api/signals/${id}`, { method: "DELETE" });
      fetchSignals();
      fetchStats();
    } catch (err) {
      console.error("Error cancelling signal:", err);
    }
  };

  const handleCheckPending = async () => {
    try {
      await fetch("/api/signals/check-pending", { method: "POST" });
      fetchStats();
      fetchSignals();
      fetchAlerts();
    } catch (err) {
      console.error("Error checking pending:", err);
    }
  };

  // ─── Chart Data ──────────────────────────────────────────────────────────

  const assetChartData = stats
    ? Object.entries(stats.winRateByAsset).map(([asset, data]) => ({
        name: asset,
        winRate: Math.round(data.rate),
        total: data.total,
      }))
    : [];

  const timeframeChartData = stats
    ? Object.entries(stats.winRateByTimeframe).map(([tf, data]) => ({
        name: tf,
        winRate: Math.round(data.rate),
        total: data.total,
      }))
    : [];

  const directionChartData = stats
    ? Object.entries(stats.winRateByDirection).map(([dir, data]) => ({
        name: dir,
        winRate: Math.round(data.rate),
        total: data.total,
      }))
    : [];

  const weeklyData = stats?.weeklyPerformance.slice(-8) || [];

  const resultPieData = stats
    ? [
        { name: "WIN", value: stats.winCount, color: NEON_GREEN },
        { name: "LOSS", value: stats.lossCount, color: NEON_RED },
        { name: "DRAW", value: stats.drawCount, color: NEON_YELLOW },
        { name: "NO_OPERAR", value: stats.noOperarCount, color: NEON_BLUE },
      ].filter((d) => d.value > 0)
    : [];

  const confidenceChartData = insights?.confidenceAnalysis.filter((c) => c.total > 0) || [];

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#0a0e17] text-white">
      {/* Header */}
      <header className="border-b border-white/10 bg-[#0d1220]/90 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#00ff88] to-[#00aaff] flex items-center justify-center">
              <Activity className="size-5 text-[#0a0e17]" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">SignalTrader Pro</h1>
              <p className="text-xs text-white/40">Trading Signals Dashboard</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCheckPending}
              className="text-white/60 hover:text-white hover:bg-white/10"
            >
              <RefreshCw className="size-4 mr-1" />
              Check
            </Button>
            {alerts.length > 0 && (
              <Badge className="bg-[#ff3366]/20 text-[#ff3366] border border-[#ff3366]/40 animate-pulse">
                <Bell className="size-3 mr-1" />
                {alerts.length}
              </Badge>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 py-4">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="bg-[#111827] border border-white/10 w-full justify-start overflow-x-auto">
            <TabsTrigger value="dashboard" className="data-[state=active]:bg-[#00ff88]/15 data-[state=active]:text-[#00ff88]">
              <BarChart3 className="size-4 mr-1" />
              Dashboard
            </TabsTrigger>
            <TabsTrigger value="historial" className="data-[state=active]:bg-[#00ff88]/15 data-[state=active]:text-[#00ff88]">
              <Clock className="size-4 mr-1" />
              Historial
            </TabsTrigger>
            <TabsTrigger value="generar" className="data-[state=active]:bg-[#00ff88]/15 data-[state=active]:text-[#00ff88]">
              <Zap className="size-4 mr-1" />
              Generar
            </TabsTrigger>
            <TabsTrigger value="backtesting" className="data-[state=active]:bg-[#00ff88]/15 data-[state=active]:text-[#00ff88]">
              <Brain className="size-4 mr-1" />
              Backtesting
            </TabsTrigger>
            <TabsTrigger value="alertas" className="data-[state=active]:bg-[#00ff88]/15 data-[state=active]:text-[#00ff88]">
              <Bell className="size-4 mr-1" />
              Alertas
            </TabsTrigger>
          </TabsList>

          {/* ─── DASHBOARD TAB ──────────────────────────────────────────────── */}
          <TabsContent value="dashboard">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-4 mt-4"
            >
              {/* Stats Cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
                <StatCard
                  title="Total Señales"
                  value={stats?.totalSignals || 0}
                  icon={<Activity className="size-5" />}
                  color="#00aaff"
                />
                <StatCard
                  title="Win Rate"
                  value={`${stats?.winRate.toFixed(1) || 0}%`}
                  icon={<Target className="size-5" />}
                  color={stats && stats.winRate >= 60 ? "#00ff88" : "#ff3366"}
                />
                <StatCard
                  title="Profit Factor"
                  value={stats?.profitFactor === -1 ? "∞" : (stats?.profitFactor || 0).toString()}
                  icon={<TrendingUp className="size-5" />}
                  color={stats && stats.profitFactor >= 1.5 ? "#00ff88" : "#ffcc00"}
                />
                <StatCard
                  title="WIN"
                  value={stats?.winCount || 0}
                  icon={<CheckCircle className="size-5" />}
                  color="#00ff88"
                />
                <StatCard
                  title="LOSS"
                  value={stats?.lossCount || 0}
                  icon={<XCircle className="size-5" />}
                  color="#ff3366"
                />
                <StatCard
                  title="Pendientes"
                  value={stats?.pendingCount || 0}
                  icon={<Clock className="size-5" />}
                  color="#ffcc00"
                />
              </div>

              {/* Consecutive Stats */}
              {stats && (stats.currentConsecutiveWins > 0 || stats.currentConsecutiveLosses > 0) && (
                <div className="flex gap-3">
                  {stats.currentConsecutiveWins > 0 && (
                    <Badge className="bg-[#00ff88]/15 text-[#00ff88] border border-[#00ff88]/30 py-1 px-3">
                      <TrendingUp className="size-3 mr-1" />
                      {stats.currentConsecutiveWins} victorias consecutivas
                    </Badge>
                  )}
                  {stats.currentConsecutiveLosses > 0 && (
                    <Badge className="bg-[#ff3366]/15 text-[#ff3366] border border-[#ff3366]/30 py-1 px-3">
                      <TrendingDown className="size-3 mr-1" />
                      {stats.currentConsecutiveLosses} pérdidas consecutivas
                    </Badge>
                  )}
                </div>
              )}

              {/* Charts Row */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Weekly Performance */}
                <Card className="bg-[#111827] border-white/10">
                  <CardHeader>
                    <CardTitle className="text-white text-sm">Rendimiento Semanal</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {weeklyData.length > 0 ? (
                      <ResponsiveContainer width="100%" height={220}>
                        <BarChart data={weeklyData}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                          <XAxis dataKey="week" tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 10 }} />
                          <YAxis tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 10 }} />
                          <RechartsTooltip
                            contentStyle={{ background: "#1a1f2e", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "8px" }}
                            labelStyle={{ color: "#fff" }}
                          />
                          <Bar dataKey="wins" fill={NEON_GREEN} radius={[4, 4, 0, 0]} />
                          <Bar dataKey="losses" fill={NEON_RED} radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="h-[220px] flex items-center justify-center text-white/30 text-sm">
                        Sin datos suficientes
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Result Distribution */}
                <Card className="bg-[#111827] border-white/10">
                  <CardHeader>
                    <CardTitle className="text-white text-sm">Distribución de Resultados</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {resultPieData.length > 0 ? (
                      <ResponsiveContainer width="100%" height={220}>
                        <PieChart>
                          <Pie
                            data={resultPieData}
                            cx="50%"
                            cy="50%"
                            innerRadius={55}
                            outerRadius={85}
                            paddingAngle={3}
                            dataKey="value"
                          >
                            {resultPieData.map((entry, index) => (
                              <Cell key={`cell-${index}`} fill={entry.color} />
                            ))}
                          </Pie>
                          <Legend
                            formatter={(value: string) => <span style={{ color: "rgba(255,255,255,0.7)", fontSize: 12 }}>{value}</span>}
                          />
                          <RechartsTooltip
                            contentStyle={{ background: "#1a1f2e", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "8px" }}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="h-[220px] flex items-center justify-center text-white/30 text-sm">
                        Sin datos suficientes
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>

              {/* Second Charts Row */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Win Rate by Asset */}
                <Card className="bg-[#111827] border-white/10">
                  <CardHeader>
                    <CardTitle className="text-white text-sm">Win Rate por Activo</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {assetChartData.length > 0 ? (
                      <ResponsiveContainer width="100%" height={220}>
                        <BarChart data={assetChartData}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                          <XAxis dataKey="name" tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 10 }} />
                          <YAxis tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 10 }} domain={[0, 100]} />
                          <RechartsTooltip
                            contentStyle={{ background: "#1a1f2e", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "8px" }}
                            labelStyle={{ color: "#fff" }}
                          />
                          <Bar dataKey="winRate" radius={[4, 4, 0, 0]}>
                            {assetChartData.map((entry, index) => (
                              <Cell
                                key={`cell-${index}`}
                                fill={entry.winRate >= 60 ? NEON_GREEN : entry.winRate >= 50 ? NEON_YELLOW : NEON_RED}
                              />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="h-[220px] flex items-center justify-center text-white/30 text-sm">
                        Sin datos suficientes
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Win Rate by Timeframe */}
                <Card className="bg-[#111827] border-white/10">
                  <CardHeader>
                    <CardTitle className="text-white text-sm">Win Rate por Temporalidad</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {timeframeChartData.length > 0 ? (
                      <ResponsiveContainer width="100%" height={220}>
                        <BarChart data={timeframeChartData}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                          <XAxis dataKey="name" tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 10 }} />
                          <YAxis tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 10 }} domain={[0, 100]} />
                          <RechartsTooltip
                            contentStyle={{ background: "#1a1f2e", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "8px" }}
                            labelStyle={{ color: "#fff" }}
                          />
                          <Bar dataKey="winRate" radius={[4, 4, 0, 0]}>
                            {timeframeChartData.map((entry, index) => (
                              <Cell
                                key={`cell-${index}`}
                                fill={entry.winRate >= 60 ? NEON_GREEN : entry.winRate >= 50 ? NEON_YELLOW : NEON_RED}
                              />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="h-[220px] flex items-center justify-center text-white/30 text-sm">
                        Sin datos suficientes
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>

              {/* Active Alerts Panel */}
              {alerts.length > 0 && (
                <Card className="bg-[#111827] border-white/10">
                  <CardHeader>
                    <CardTitle className="text-white text-sm flex items-center gap-2">
                      <AlertTriangle className="size-4 text-[#ffcc00]" />
                      Alertas Activas ({alerts.length})
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      {alerts.map((alert) => (
                        <div
                          key={alert.id}
                          className={`flex items-center justify-between p-3 rounded-lg border ${severityColor(alert.severity)}`}
                        >
                          <div className="flex items-center gap-2">
                            {alert.severity === "critical" ? (
                              <XCircle className="size-4" />
                            ) : (
                              <AlertTriangle className="size-4" />
                            )}
                            <span className="text-sm">{alert.message}</span>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDismissAlert(alert.id)}
                            className="text-white/50 hover:text-white hover:bg-white/10 h-7"
                          >
                            Descartar
                          </Button>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </motion.div>
          </TabsContent>

          {/* ─── HISTORIAL TAB ──────────────────────────────────────────────── */}
          <TabsContent value="historial">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-4 mt-4"
            >
              {/* Filters */}
              <Card className="bg-[#111827] border-white/10">
                <CardContent className="pt-4 pb-4">
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                    <Select value={filterStatus} onValueChange={(v) => { setFilterStatus(v); setPage(1); }}>
                      <SelectTrigger className="bg-[#0a0e17] border-white/10 text-white text-xs">
                        <SelectValue placeholder="Estado" />
                      </SelectTrigger>
                      <SelectContent className="bg-[#111827] border-white/10">
                        <SelectItem value="ALL">Todos</SelectItem>
                        <SelectItem value="PENDING">Pendiente</SelectItem>
                        <SelectItem value="CLOSED">Cerrada</SelectItem>
                        <SelectItem value="CANCELLED">Cancelada</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select value={filterDirection} onValueChange={(v) => { setFilterDirection(v); setPage(1); }}>
                      <SelectTrigger className="bg-[#0a0e17] border-white/10 text-white text-xs">
                        <SelectValue placeholder="Dirección" />
                      </SelectTrigger>
                      <SelectContent className="bg-[#111827] border-white/10">
                        <SelectItem value="ALL">Todas</SelectItem>
                        <SelectItem value="HIGHER">HIGHER</SelectItem>
                        <SelectItem value="LOWER">LOWER</SelectItem>
                        <SelectItem value="NO_OPERAR">NO_OPERAR</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select value={filterAsset} onValueChange={(v) => { setFilterAsset(v); setPage(1); }}>
                      <SelectTrigger className="bg-[#0a0e17] border-white/10 text-white text-xs">
                        <SelectValue placeholder="Activo" />
                      </SelectTrigger>
                      <SelectContent className="bg-[#111827] border-white/10">
                        <SelectItem value="ALL">Todos</SelectItem>
                        {ASSETS.map((a) => (
                          <SelectItem key={a} value={a}>{a}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={filterTimeframe} onValueChange={(v) => { setFilterTimeframe(v); setPage(1); }}>
                      <SelectTrigger className="bg-[#0a0e17] border-white/10 text-white text-xs">
                        <SelectValue placeholder="Temporalidad" />
                      </SelectTrigger>
                      <SelectContent className="bg-[#111827] border-white/10">
                        <SelectItem value="ALL">Todas</SelectItem>
                        {TIMEFRAMES.map((t) => (
                          <SelectItem key={t} value={t}>{t}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="outline"
                      onClick={() => { setFilterStatus("ALL"); setFilterDirection("ALL"); setFilterAsset("ALL"); setFilterTimeframe("ALL"); setPage(1); }}
                      className="bg-[#0a0e17] border-white/10 text-white/70 hover:text-white hover:bg-white/10 text-xs"
                    >
                      Limpiar
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* Table */}
              <Card className="bg-[#111827] border-white/10">
                <CardContent className="p-0">
                  <ScrollArea className="w-full">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-white/10 hover:bg-transparent">
                          <TableHead className="text-white/50 text-xs">Hora</TableHead>
                          <TableHead className="text-white/50 text-xs">Activo</TableHead>
                          <TableHead className="text-white/50 text-xs">TF</TableHead>
                          <TableHead className="text-white/50 text-xs">Dir.</TableHead>
                          <TableHead className="text-white/50 text-xs">Entrada</TableHead>
                          <TableHead className="text-white/50 text-xs">Salida</TableHead>
                          <TableHead className="text-white/50 text-xs">Conf.</TableHead>
                          <TableHead className="text-white/50 text-xs">Resultado</TableHead>
                          <TableHead className="text-white/50 text-xs">Modo</TableHead>
                          <TableHead className="text-white/50 text-xs">Confiab.</TableHead>
                          <TableHead className="text-white/50 text-xs">Dif.</TableHead>
                          <TableHead className="text-white/50 text-xs">Razón IA</TableHead>
                          <TableHead className="text-white/50 text-xs">Acción</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        <AnimatePresence>
                          {signals.length === 0 ? (
                            <TableRow>
                              <TableCell colSpan={13} className="text-center text-white/30 py-8">
                                No hay señales registradas
                              </TableCell>
                            </TableRow>
                          ) : (
                            signals.map((signal) => (
                              <TableRow key={signal.id} className="border-white/5 hover:bg-white/5">
                                <TableCell className="text-white/70 text-xs whitespace-nowrap">
                                  {formatTime(signal.entryTime)}
                                </TableCell>
                                <TableCell className="text-white text-xs font-medium">
                                  {signal.asset}
                                </TableCell>
                                <TableCell className="text-white/70 text-xs">
                                  {signal.timeframe}
                                </TableCell>
                                <TableCell>
                                  <div className="flex items-center gap-1">
                                    {directionIcon(signal.direction)}
                                    <span className={`text-xs ${signal.direction === "HIGHER" ? "text-[#00ff88]" : signal.direction === "LOWER" ? "text-[#ff3366]" : "text-[#00aaff]"}`}>
                                      {signal.direction}
                                    </span>
                                  </div>
                                </TableCell>
                                <TableCell className="text-white/70 text-xs font-mono">
                                  {formatPrice(signal.entryPrice, signal.asset)}
                                </TableCell>
                                <TableCell className="text-white/70 text-xs font-mono">
                                  {signal.exitPrice ? formatPrice(signal.exitPrice, signal.asset) : "—"}
                                </TableCell>
                                <TableCell>
                                  <div className="flex items-center gap-1">
                                    <Progress
                                      value={signal.confidence}
                                      className="h-1.5 w-12 bg-white/10"
                                      style={{ "--progress-color": signal.confidence >= 70 ? NEON_GREEN : signal.confidence >= 55 ? NEON_YELLOW : NEON_RED } as React.CSSProperties}
                                    />
                                    <span className="text-xs text-white/60">{signal.confidence}%</span>
                                  </div>
                                </TableCell>
                                <TableCell>
                                  {signal.status === "PENDING" ? (
                                    <Badge className={`text-[10px] ${statusBg(signal.status)}`}>
                                      PENDIENTE
                                    </Badge>
                                  ) : signal.result ? (
                                    <Badge className={`text-[10px] ${resultBg(signal.result)}`}>
                                      {signal.result}
                                    </Badge>
                                  ) : (
                                    <Badge className={`text-[10px] ${statusBg(signal.status)}`}>
                                      {signal.status}
                                    </Badge>
                                  )}
                                </TableCell>
                                <TableCell>
                                  <Badge className={`text-[9px] ${analysisModeConfig(signal.analysisMode).bg}`}>
                                    {analysisModeConfig(signal.analysisMode).label}
                                  </Badge>
                                </TableCell>
                                <TableCell>
                                  <span className="text-[10px] font-medium" style={{ color: reliabilityConfig(signal.statisticalReliability).color }}>
                                    {reliabilityConfig(signal.statisticalReliability).label}
                                    {signal.historicalSampleSize !== null && signal.historicalSampleSize > 0 && (
                                      <span className="text-white/30 ml-0.5">({signal.historicalSampleSize})</span>
                                    )}
                                  </span>
                                </TableCell>
                                <TableCell className={`text-xs font-mono ${resultColor(signal.result)}`}>
                                  {signal.priceDifference !== null ? (signal.priceDifference > 0 ? "+" : "") + signal.priceDifference.toFixed(5) : "—"}
                                </TableCell>
                                <TableCell className="text-white/40 text-xs max-w-[150px] truncate">
                                  {signal.aiReason || "—"}
                                </TableCell>
                                <TableCell>
                                  {signal.status === "PENDING" && (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => handleCancelSignal(signal.id)}
                                      className="text-[#ff3366]/70 hover:text-[#ff3366] hover:bg-[#ff3366]/10 h-6 text-[10px]"
                                    >
                                      Cancelar
                                    </Button>
                                  )}
                                </TableCell>
                              </TableRow>
                            ))
                          )}
                        </AnimatePresence>
                      </TableBody>
                    </Table>
                  </ScrollArea>
                </CardContent>
              </Card>

              {/* Pagination */}
              <div className="flex items-center justify-between">
                <span className="text-white/40 text-xs">
                  Página {page} de {totalPages}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="bg-[#111827] border-white/10 text-white/60 hover:text-white hover:bg-white/10"
                  >
                    <ChevronLeft className="size-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => p + 1)}
                    className="bg-[#111827] border-white/10 text-white/60 hover:text-white hover:bg-white/10"
                  >
                    <ChevronRight className="size-4" />
                  </Button>
                </div>
              </div>
            </motion.div>
          </TabsContent>

          {/* ─── GENERAR TAB ────────────────────────────────────────────────── */}
          <TabsContent value="generar">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-4 mt-4"
            >
              {/* Mode Toggle */}
              <div className="flex gap-2">
                <Button
                  variant={!manualMode ? "default" : "outline"}
                  onClick={() => setManualMode(false)}
                  className={!manualMode ? "bg-[#00ff88]/20 text-[#00ff88] border border-[#00ff88]/30 hover:bg-[#00ff88]/30" : "bg-[#111827] border-white/10 text-white/60 hover:text-white hover:bg-white/10"}
                >
                  <Bot className="size-4 mr-2" />
                  Generar con IA
                </Button>
                <Button
                  variant={manualMode ? "default" : "outline"}
                  onClick={() => setManualMode(true)}
                  className={manualMode ? "bg-[#00aaff]/20 text-[#00aaff] border border-[#00aaff]/30 hover:bg-[#00aaff]/30" : "bg-[#111827] border-white/10 text-white/60 hover:text-white hover:bg-white/10"}
                >
                  <Eye className="size-4 mr-2" />
                  Manual
                </Button>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Form */}
                <Card className="bg-[#111827] border-white/10">
                  <CardHeader>
                    <CardTitle className="text-white text-sm">
                      {manualMode ? "Crear Señal Manual" : "Configurar Señal IA"}
                    </CardTitle>
                    <CardDescription className="text-white/40">
                      {manualMode
                        ? "Complete los campos para crear una señal manualmente"
                        : "Seleccione el activo y temporalidad, la IA generará el análisis"}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-2">
                        <Label className="text-white/60 text-xs">Activo</Label>
                        <Select value={genAsset} onValueChange={setGenAsset}>
                          <SelectTrigger className="bg-[#0a0e17] border-white/10 text-white">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="bg-[#111827] border-white/10">
                            {ASSETS.map((a) => (
                              <SelectItem key={a} value={a}>{a}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label className="text-white/60 text-xs">Temporalidad</Label>
                        <Select value={genTimeframe} onValueChange={(v) => { setGenTimeframe(v); if (!manualMode) setGenEntryPrice(""); }}>
                          <SelectTrigger className="bg-[#0a0e17] border-white/10 text-white">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="bg-[#111827] border-white/10">
                            {TIMEFRAMES.map((t) => (
                              <SelectItem key={t} value={t}>{t}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    {manualMode && (
                      <>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-2">
                            <Label className="text-white/60 text-xs">Dirección</Label>
                            <Select value={genDirection} onValueChange={setGenDirection}>
                              <SelectTrigger className="bg-[#0a0e17] border-white/10 text-white">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent className="bg-[#111827] border-white/10">
                                {DIRECTIONS.map((d) => (
                                  <SelectItem key={d} value={d}>{d}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-2">
                            <Label className="text-white/60 text-xs">Precio Entrada</Label>
                            <Input
                              value={genEntryPrice}
                              onChange={(e) => setGenEntryPrice(e.target.value)}
                              className="bg-[#0a0e17] border-white/10 text-white font-mono"
                              placeholder="1.08500"
                            />
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-white/60 text-xs">Confianza: {genConfidence}%</Label>
                          <input
                            type="range"
                            min={0}
                            max={100}
                            value={genConfidence}
                            onChange={(e) => setGenConfidence(parseInt(e.target.value))}
                            className="w-full accent-[#00ff88]"
                          />
                          <div className="flex justify-between text-[10px] text-white/30">
                            <span>0%</span>
                            <span>50%</span>
                            <span>100%</span>
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-white/60 text-xs">Razón / Notas</Label>
                          <Textarea
                            value={genAiReason}
                            onChange={(e) => setGenAiReason(e.target.value)}
                            className="bg-[#0a0e17] border-white/10 text-white min-h-[80px]"
                            placeholder="Razón de la señal..."
                          />
                        </div>
                      </>
                    )}

                    <Separator className="bg-white/10" />

                    <Button
                      className="w-full"
                      onClick={manualMode ? handleCreateManual : handleGenerateAI}
                      disabled={loading.generate || loading.manual}
                      style={{
                        background: manualMode
                          ? "linear-gradient(135deg, #00aaff, #0066cc)"
                          : "linear-gradient(135deg, #00ff88, #00cc66)",
                        color: "#0a0e17",
                      }}
                    >
                      {loading.generate || loading.manual ? (
                        <Loader2 className="size-4 mr-2 animate-spin" />
                      ) : manualMode ? (
                        <Eye className="size-4 mr-2" />
                      ) : (
                        <Bot className="size-4 mr-2" />
                      )}
                      {manualMode ? "Crear Señal Manual" : "Generar con IA"}
                    </Button>
                  </CardContent>
                </Card>

                {/* AI Analysis Preview */}
                <Card className="bg-[#111827] border-white/10">
                  <CardHeader>
                    <CardTitle className="text-white text-sm flex items-center gap-2">
                      <Brain className="size-4 text-[#aa66ff]" />
                      Vista Previa del Análisis
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {/* Analysis Mode Warning Banner */}
                    {!manualMode && stats && stats.totalSignals < 30 && (
                      <div className="bg-[#ff3366]/10 border border-[#ff3366]/30 rounded-lg p-3">
                        <div className="flex items-start gap-2">
                          <AlertTriangle className="size-4 text-[#ff3366] mt-0.5 shrink-0" />
                          <div>
                            <p className="text-[#ff3366] text-xs font-medium">DATOS INSUFICIENTES PARA ANÁLISIS COMPLETO</p>
                            <p className="text-white/50 text-[10px] mt-1">
                              Se requieren mínimo 30 señales cerradas para análisis confiable.
                              Actualmente: {stats.totalSignals} señales.
                              La IA generará NO_OPERAR hasta tener suficiente historial.
                            </p>
                          </div>
                        </div>
                      </div>
                    )}

                    {genAiReason ? (
                      <div className="bg-[#0a0e17] rounded-lg p-4 border border-white/5">
                        <p className="text-white/80 text-sm whitespace-pre-wrap">{genAiReason}</p>
                      </div>
                    ) : (
                      <div className="bg-[#0a0e17] rounded-lg p-4 border border-white/5 text-center">
                        <Bot className="size-8 text-white/20 mx-auto mb-2" />
                        <p className="text-white/30 text-sm">
                          {manualMode
                            ? "Escriba una razón para la señal"
                            : "Haga clic en 'Generar con IA' para obtener un análisis"}
                        </p>
                      </div>
                    )}

                    {/* Quick Stats Context */}
                    {stats && (
                      <div className="grid grid-cols-2 gap-2">
                        <div className="bg-[#0a0e17] rounded-lg p-3 border border-white/5">
                          <p className="text-white/40 text-[10px] uppercase">Win Rate General</p>
                          <p className={`text-lg font-bold ${stats.winRate >= 60 ? "text-[#00ff88]" : stats.winRate >= 50 ? "text-[#ffcc00]" : "text-[#ff3366]"}`}>
                            {stats.winRate.toFixed(1)}%
                          </p>
                        </div>
                        <div className="bg-[#0a0e17] rounded-lg p-3 border border-white/5">
                          <p className="text-white/40 text-[10px] uppercase">Confianza Recomendada</p>
                          <p className="text-lg font-bold text-[#00aaff]">
                            {stats.recommendedConfidenceThreshold}%
                          </p>
                        </div>
                        <div className="bg-[#0a0e17] rounded-lg p-3 border border-white/5">
                          <p className="text-white/40 text-[10px] uppercase">Señales Cerradas</p>
                          <p className={`text-lg font-bold ${stats.totalSignals >= 30 ? "text-[#00ff88]" : stats.totalSignals >= 10 ? "text-[#ffcc00]" : "text-[#ff3366]"}`}>
                            {stats.totalSignals}
                          </p>
                          <p className="text-white/30 text-[9px]">mín. 30 para ALTA</p>
                        </div>
                        <div className="bg-[#0a0e17] rounded-lg p-3 border border-white/5">
                          <p className="text-white/40 text-[10px] uppercase">Confiabilidad Estadística</p>
                          <p className={`text-lg font-bold ${stats.totalSignals >= 500 ? "text-[#00ff88]" : stats.totalSignals >= 100 ? "text-[#ffcc00]" : "text-[#ff3366]"}`}>
                            {stats.totalSignals >= 500 ? "ALTA" : stats.totalSignals >= 100 ? "MEDIA" : stats.totalSignals >= 30 ? "BAJA" : "INSUFICIENTE"}
                          </p>
                        </div>
                      </div>
                    )}

                    {/* Data Sources Available Indicator */}
                    <div className="bg-[#0a0e17] rounded-lg p-3 border border-white/5">
                      <p className="text-white/40 text-[10px] uppercase mb-2">Fuentes de Datos Disponibles</p>
                      <DataAvailabilityBadges dataAvail={{
                        technical: false,
                        volume: false,
                        patterns: false,
                        sentiment: false,
                        news: false,
                        macro: false,
                      }} />
                      <p className="text-white/30 text-[9px] mt-2">
                        Las fuentes se activarán según disponibilidad del análisis IA
                      </p>
                    </div>

                    {/* Asset-specific context */}
                    {stats && genAsset && stats.winRateByAsset[genAsset] && (
                      <div className="bg-[#0a0e17] rounded-lg p-3 border border-white/5">
                        <p className="text-white/40 text-[10px] uppercase mb-1">Rendimiento {genAsset}</p>
                        <div className="flex items-center justify-between">
                          <span className={`text-sm font-bold ${stats.winRateByAsset[genAsset].rate >= 60 ? "text-[#00ff88]" : "text-[#ff3366]"}`}>
                            {stats.winRateByAsset[genAsset].rate.toFixed(1)}%
                          </span>
                          <span className="text-white/30 text-xs">
                            {stats.winRateByAsset[genAsset].wins}W / {stats.winRateByAsset[genAsset].total - stats.winRateByAsset[genAsset].wins}L
                          </span>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            </motion.div>
          </TabsContent>

          {/* ─── BACKTESTING TAB ────────────────────────────────────────────── */}
          <TabsContent value="backtesting">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-4 mt-4"
            >
              {loading.backtesting && (
                <div className="flex items-center justify-center py-20">
                  <Loader2 className="size-8 text-[#00ff88] animate-spin mr-3" />
                  <span className="text-white/50">Analizando datos históricos...</span>
                </div>
              )}

              {!loading.backtesting && insights && (
                <>
                  {/* Summary */}
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                    <StatCard
                      title="Total Analizadas"
                      value={insights.summary.totalSignals}
                      icon={<Activity className="size-5" />}
                      color="#00aaff"
                    />
                    <StatCard
                      title="Win Rate Global"
                      value={`${insights.summary.overallWinRate.toFixed(1)}%`}
                      icon={<Target className="size-5" />}
                      color={insights.summary.overallWinRate >= 60 ? "#00ff88" : "#ff3366"}
                    />
                    <StatCard
                      title="Profit Factor"
                      value={insights.summary.profitFactor.toString()}
                      icon={<TrendingUp className="size-5" />}
                      color={insights.summary.profitFactor >= 1.5 ? "#00ff88" : "#ffcc00"}
                    />
                    <StatCard
                      title="Confianza Min. Rec."
                      value={`${insights.summary.recommendedConfidenceThreshold}%`}
                      icon={<Shield className="size-5" />}
                      color="#aa66ff"
                    />
                    <StatCard
                      title="WR con Filtro"
                      value={`${insights.summary.bestThresholdWinRate}%`}
                      icon={<CheckCircle className="size-5" />}
                      color="#00ffcc"
                    />
                  </div>

                  {/* Warnings */}
                  {insights.warnings.length > 0 && (
                    <Card className="bg-[#111827] border-[#ff3366]/30">
                      <CardHeader>
                        <CardTitle className="text-[#ff3366] text-sm flex items-center gap-2">
                          <AlertTriangle className="size-4" />
                          Advertencias del Backtesting
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <ul className="space-y-1">
                          {insights.warnings.map((w, i) => (
                            <li key={i} className="text-white/70 text-sm flex items-start gap-2">
                              <span className="text-[#ff3366] mt-1">•</span>
                              {w}
                            </li>
                          ))}
                        </ul>
                      </CardContent>
                    </Card>
                  )}

                  {/* Asset & Timeframe Performance */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <Card className="bg-[#111827] border-white/10">
                      <CardHeader>
                        <CardTitle className="text-white text-sm">Rendimiento por Activo</CardTitle>
                      </CardHeader>
                      <CardContent>
                        {insights.assetPerformance.length > 0 ? (
                          <ResponsiveContainer width="100%" height={250}>
                            <BarChart data={insights.assetPerformance}>
                              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                              <XAxis dataKey="asset" tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 10 }} />
                              <YAxis tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 10 }} domain={[0, 100]} />
                              <RechartsTooltip
                                contentStyle={{ background: "#1a1f2e", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "8px" }}
                                labelStyle={{ color: "#fff" }}
                              />
                              <Bar dataKey="winRate" radius={[4, 4, 0, 0]}>
                                {insights.assetPerformance.map((entry, index) => (
                                  <Cell
                                    key={`cell-${index}`}
                                    fill={entry.recommendation === "OPERAR" ? NEON_GREEN : entry.recommendation === "EVITAR" ? NEON_RED : NEON_YELLOW}
                                  />
                                ))}
                              </Bar>
                            </BarChart>
                          </ResponsiveContainer>
                        ) : (
                          <div className="h-[250px] flex items-center justify-center text-white/30 text-sm">
                            Sin datos suficientes
                          </div>
                        )}
                      </CardContent>
                    </Card>

                    <Card className="bg-[#111827] border-white/10">
                      <CardHeader>
                        <CardTitle className="text-white text-sm">Rendimiento por Temporalidad</CardTitle>
                      </CardHeader>
                      <CardContent>
                        {insights.timeframePerformance.length > 0 ? (
                          <ResponsiveContainer width="100%" height={250}>
                            <BarChart data={insights.timeframePerformance}>
                              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                              <XAxis dataKey="timeframe" tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 10 }} />
                              <YAxis tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 10 }} domain={[0, 100]} />
                              <RechartsTooltip
                                contentStyle={{ background: "#1a1f2e", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "8px" }}
                                labelStyle={{ color: "#fff" }}
                              />
                              <Bar dataKey="winRate" radius={[4, 4, 0, 0]}>
                                {insights.timeframePerformance.map((entry, index) => (
                                  <Cell
                                    key={`cell-${index}`}
                                    fill={entry.recommendation === "OPERAR" ? NEON_GREEN : entry.recommendation === "EVITAR" ? NEON_RED : NEON_YELLOW}
                                  />
                                ))}
                              </Bar>
                            </BarChart>
                          </ResponsiveContainer>
                        ) : (
                          <div className="h-[250px] flex items-center justify-center text-white/30 text-sm">
                            Sin datos suficientes
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </div>

                  {/* Confidence Analysis */}
                  <Card className="bg-[#111827] border-white/10">
                    <CardHeader>
                      <CardTitle className="text-white text-sm">Análisis por Nivel de Confianza</CardTitle>
                    </CardHeader>
                    <CardContent>
                      {confidenceChartData.length > 0 ? (
                        <ResponsiveContainer width="100%" height={250}>
                          <BarChart data={confidenceChartData}>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                            <XAxis dataKey="range" tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 10 }} />
                            <YAxis tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 10 }} domain={[0, 100]} />
                            <RechartsTooltip
                              contentStyle={{ background: "#1a1f2e", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "8px" }}
                              labelStyle={{ color: "#fff" }}
                            />
                            <Bar dataKey="winRate" radius={[4, 4, 0, 0]}>
                              {confidenceChartData.map((entry, index) => (
                                <Cell
                                  key={`cell-${index}`}
                                  fill={entry.winRate >= 60 ? NEON_GREEN : entry.winRate >= 50 ? NEON_YELLOW : NEON_RED}
                                />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      ) : (
                        <div className="h-[250px] flex items-center justify-center text-white/30 text-sm">
                          Sin datos suficientes
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  {/* Recommended Filters */}
                  <Card className="bg-[#111827] border-white/10">
                    <CardHeader>
                      <CardTitle className="text-white text-sm flex items-center gap-2">
                        <Shield className="size-4 text-[#aa66ff]" />
                        Filtros Recomendados
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        <FilterItem
                          title="Activos Recomendados"
                          items={insights.recommendedFilters.goodAssets}
                          color="#00ff88"
                          emptyText="Sin datos suficientes"
                        />
                        <FilterItem
                          title="Activos a Evitar"
                          items={insights.recommendedFilters.badAssets}
                          color="#ff3366"
                          emptyText="Ninguno identificado"
                        />
                        <FilterItem
                          title="Temporalidades Recomendadas"
                          items={insights.recommendedFilters.goodTimeframes}
                          color="#00ff88"
                          emptyText="Sin datos suficientes"
                        />
                        <FilterItem
                          title="Horas Buenas"
                          items={insights.recommendedFilters.goodHours}
                          color="#00ff88"
                          emptyText="Sin datos suficientes"
                        />
                        <FilterItem
                          title="Horas a Evitar"
                          items={insights.recommendedFilters.badHours}
                          color="#ff3366"
                          emptyText="Ninguna identificada"
                        />
                        <div className="bg-[#0a0e17] rounded-lg p-4 border border-white/5">
                          <p className="text-white/40 text-[10px] uppercase mb-2">Confianza Mínima</p>
                          <p className="text-2xl font-bold text-[#aa66ff]">
                            {insights.recommendedFilters.minimumConfidence}%
                          </p>
                          {insights.recommendedFilters.avoidConsecutiveLosses && (
                            <Badge className="mt-2 bg-[#ff3366]/15 text-[#ff3366] border border-[#ff3366]/30 text-[10px]">
                              Evitar operar por pérdidas consecutivas
                            </Badge>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </>
              )}

              {!loading.backtesting && !insights && (
                <div className="text-center py-20">
                  <Brain className="size-12 text-white/20 mx-auto mb-4" />
                  <p className="text-white/40 text-sm mb-4">No hay datos de backtesting disponibles</p>
                  <Button
                    onClick={fetchInsights}
                    className="bg-[#00ff88]/20 text-[#00ff88] border border-[#00ff88]/30 hover:bg-[#00ff88]/30"
                  >
                    Analizar Datos
                  </Button>
                </div>
              )}
            </motion.div>
          </TabsContent>

          {/* ─── ALERTAS TAB ────────────────────────────────────────────────── */}
          <TabsContent value="alertas">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-4 mt-4"
            >
              {alerts.length === 0 ? (
                <Card className="bg-[#111827] border-white/10">
                  <CardContent className="py-16 text-center">
                    <CheckCircle className="size-12 text-[#00ff88]/30 mx-auto mb-4" />
                    <p className="text-white/50 text-sm">No hay alertas activas</p>
                    <p className="text-white/30 text-xs mt-1">
                      El sistema monitorea automáticamente pérdida consecutiva, win rate bajo, y rendimiento por activo
                    </p>
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-3">
                  {alerts.map((alert) => (
                    <Card key={alert.id} className="bg-[#111827] border-white/10">
                      <CardContent className="py-4">
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex items-start gap-3">
                            <div className={`mt-0.5 p-2 rounded-lg ${severityColor(alert.severity)}`}>
                              {alert.severity === "critical" ? (
                                <XCircle className="size-5" />
                              ) : alert.severity === "warning" ? (
                                <AlertTriangle className="size-5" />
                              ) : (
                                <Activity className="size-5" />
                              )}
                            </div>
                            <div>
                              <div className="flex items-center gap-2 mb-1">
                                <Badge className={`text-[10px] ${severityColor(alert.severity)}`}>
                                  {alert.type.replace(/_/g, " ")}
                                </Badge>
                                <Badge className={`text-[10px] ${severityColor(alert.severity)}`}>
                                  {alert.severity}
                                </Badge>
                              </div>
                              <p className="text-white/80 text-sm">{alert.message}</p>
                              <p className="text-white/30 text-xs mt-1">
                                {new Date(alert.createdAt).toLocaleString("es-ES")}
                              </p>
                            </div>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleDismissAlert(alert.id)}
                            className="border-white/10 text-white/50 hover:text-white hover:bg-white/10 shrink-0"
                          >
                            Descartar
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}

              {/* Alert Configuration Info */}
              <Card className="bg-[#111827] border-white/10">
                <CardHeader>
                  <CardTitle className="text-white text-sm flex items-center gap-2">
                    <Shield className="size-4 text-[#00aaff]" />
                    Monitoreo Automático
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <AlertConfig
                      title="Pérdidas Consecutivas"
                      description="Alerta cuando hay 3+ pérdidas consecutivas"
                      icon={<TrendingDown className="size-4 text-[#ff3366]" />}
                      active
                    />
                    <AlertConfig
                      title="Win Rate Bajo"
                      description="Alerta cuando el win rate baja del 55%"
                      icon={<Target className="size-4 text-[#ffcc00]" />}
                      active
                    />
                    <AlertConfig
                      title="Activo con Mal Rendimiento"
                      description="Alerta cuando un activo tiene <40% win rate en 5+ señales"
                      icon={<BarChart3 className="size-4 text-[#ff3366]" />}
                      active
                    />
                    <AlertConfig
                      title="Señales Contradictorias"
                      description="Alerta cuando hay HIGHER y LOWER en el mismo activo recientemente"
                      icon={<AlertTriangle className="size-4 text-[#ffcc00]" />}
                      active
                    />
                    <AlertConfig
                      title="Alta Volatilidad"
                      description="Alerta cuando el movimiento promedio excede 2%"
                      icon={<Zap className="size-4 text-[#ff3366]" />}
                      active
                    />
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          </TabsContent>
        </Tabs>
      </main>

      {/* Footer */}
      <footer className="border-t border-white/10 mt-8">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between text-white/30 text-xs">
          <span>SignalTrader Pro v1.0</span>
          <span>Auto-refresh: 10s</span>
        </div>
      </footer>
    </div>
  );
}

// ─── Sub-Components ──────────────────────────────────────────────────────────

function StatCard({
  title,
  value,
  icon,
  color,
}: {
  title: string;
  value: string | number;
  icon: React.ReactNode;
  color: string;
}) {
  return (
    <Card className="bg-[#111827] border-white/10">
      <CardContent className="pt-4 pb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-white/40 text-[10px] uppercase tracking-wider">{title}</span>
          <div style={{ color }}>{icon}</div>
        </div>
        <p className="text-xl font-bold" style={{ color }}>
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

function FilterItem({
  title,
  items,
  color,
  emptyText,
}: {
  title: string;
  items: string[];
  color: string;
  emptyText: string;
}) {
  return (
    <div className="bg-[#0a0e17] rounded-lg p-4 border border-white/5">
      <p className="text-white/40 text-[10px] uppercase mb-2">{title}</p>
      {items.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {items.map((item) => (
            <Badge
              key={item}
              className="text-[10px]"
              style={{ backgroundColor: `${color}20`, color, borderColor: `${color}40` }}
            >
              {item}
            </Badge>
          ))}
        </div>
      ) : (
        <p className="text-white/30 text-xs">{emptyText}</p>
      )}
    </div>
  );
}

function AlertConfig({
  title,
  description,
  icon,
  active,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  active: boolean;
}) {
  return (
    <div className="bg-[#0a0e17] rounded-lg p-3 border border-white/5 flex items-start gap-3">
      <div className="mt-0.5">{icon}</div>
      <div className="flex-1">
        <div className="flex items-center justify-between">
          <p className="text-white/80 text-xs font-medium">{title}</p>
          {active && (
            <Badge className="bg-[#00ff88]/15 text-[#00ff88] border border-[#00ff88]/30 text-[9px]">
              ACTIVO
            </Badge>
          )}
        </div>
        <p className="text-white/40 text-[10px] mt-0.5">{description}</p>
      </div>
    </div>
  );
}
