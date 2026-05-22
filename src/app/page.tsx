"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
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
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Checkbox } from "@/components/ui/checkbox";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  ResponsiveContainer, LineChart, Line, PieChart, Pie, Cell, Legend,
} from "recharts";
import {
  TrendingUp, TrendingDown, Activity, BarChart3, Bell, Bot,
  RefreshCw, CheckCircle, XCircle, MinusCircle, AlertTriangle,
  Clock, Zap, Target, Shield, Brain, Eye, Loader2, Play, Square,
  Sun, Moon, Globe, Flame, Crosshair, ChevronLeft, ChevronRight,
  Database, Sparkles, Wifi, WifiOff, Gauge, Timer, AlertOctagon,
  ArrowUpRight, ArrowDownRight, CircleDot, Layers, Key, Server,
  Signal,
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
  patternType: string | null;
  sessionType: string | null;
  setupScore: number | null;
  source: string;
  noOperarReason: string | null;
  createdAt: string;
  updatedAt: string;
  // Phase 4 fields
  marketRegime: string | null;
  featuresJson: string | null;
  expectancy: number | null;
  riskReward: number | null;
  adjustedWinRate: number | null;
  confidenceInterval: string | null;
  pValue: number | null;
  sampleVariance: number | null;
  qualityScore: number | null;
  qualityFlags: string | null;
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
  winRateByPattern: Record<string, { wins: number; total: number; rate: number }>;
  winRateBySession: Record<string, { wins: number; total: number; rate: number }>;
  winRateBySource: Record<string, { wins: number; total: number; rate: number }>;
  bestAsset: string | null;
  worstAsset: string | null;
  bestTimeframe: string | null;
  worstTimeframe: string | null;
  bestHour: string | null;
  worstHour: string | null;
  bestPattern: string | null;
  worstPattern: string | null;
  bestSession: string | null;
  worstSession: string | null;
  currentConsecutiveWins: number;
  currentConsecutiveLosses: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  weeklyPerformance: Array<{ week: string; wins: number; losses: number; draws: number; total: number; winRate: number }>;
  monthlyPerformance: Array<{ month: string; wins: number; losses: number; draws: number; total: number; winRate: number }>;
  recommendedConfidenceThreshold: number;
  statisticalReliability: string;
  sampleSize: number;
  sampleAdequacy: string;
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

interface AutoTraderState {
  isRunning: boolean;
  lastCheck: string | null;
  totalGenerated: number;
  totalVerified: number;
  currentPending: number;
  cyclesCompleted: number;
  errors: string[];
  recentSignals: Array<{
    id: string;
    asset: string;
    direction: string;
    pattern: string | null;
    confidence: number;
    setupScore: number | null;
    status: string;
  }>;
}

interface AutoTraderConfig {
  enabled: boolean;
  assets: string[];
  timeframe: string;
  intervalMinutes: number;
  minSetupScore: number;
  maxConcurrentSignals: number;
  confidenceBoost: number;
  noOperarThreshold: number;
}

interface SetupScoreEntry {
  patternType: string;
  asset: string | null;
  session: string | null;
  totalSignals: number;
  wins: number;
  losses: number;
  winRate: number;
  avgSetupScore: number;
  avgConfidence: number;
  edge: "POSITIVE" | "NEGATIVE" | "NEUTRAL" | "UNKNOWN";
  sampleAdequacy: "INSUFFICIENT" | "LOW" | "MEDIUM" | "HIGH";
  // Phase 4 fields
  bayesianWinRate: number;
  confidenceIntervalLower: number;
  confidenceIntervalUpper: number;
  pValue: number;
  avgExpectancy: number;
  avgRiskReward: number;
  avgQualityScore: number;
}

interface SetupScoresResponse {
  scores: SetupScoreEntry[];
  summary: {
    byPattern: Record<string, { totalSignals: number; wins: number; losses: number; winRate: number; edge: string }>;
    bySession: Record<string, { totalSignals: number; wins: number; losses: number; winRate: number; edge: string }>;
    totalPatterns: number;
    totalSessions: number;
    totalDataPoints: number;
  };
}

// ─── Market Engine Types ────────────────────────────────────────────────────

interface MarketEngineStatusPanel {
  connected: boolean;
  sources: Record<string, string>;
  lastPrice: Record<string, number>;
  lastUpdate: Record<string, string>;
  latency: Record<string, number>;
  dataQuality: string;
  errors: string[];
  binanceAvailable: boolean;
  twelveDataAvailable: boolean;
  twelveDataApiKeySet?: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ASSETS = ["EUR/USD", "GBP/USD", "USD/JPY", "BTC/USD", "ETH/USD"];
const TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1"];
const PATTERN_TYPES = ["breakout", "liquidity_sweep", "engulfing", "fakeout", "reversal", "trend_continuation"];
const SESSION_TYPES = ["Asia", "London", "NewYork", "Overlap", "OffHours"];

const NEON_GREEN = "#00ff88";
const NEON_RED = "#ff3366";
const NEON_YELLOW = "#ffaa00";
const NEON_BLUE = "#00aaff";
const NEON_PURPLE = "#aa66ff";
const NEON_CYAN = "#00ffcc";
const CHART_COLORS = [NEON_GREEN, NEON_RED, NEON_YELLOW, NEON_BLUE, NEON_PURPLE, NEON_CYAN];

const PATTERN_NAMES: Record<string, string> = {
  breakout: "Ruptura",
  liquidity_sweep: "Barrido Liquidez",
  engulfing: "Envolvente",
  fakeout: "Falsa Ruptura",
  reversal: "Reversión",
  trend_continuation: "Continuación",
};

const PATTERN_ICONS: Record<string, React.ReactNode> = {
  breakout: <Flame className="size-4" />,
  liquidity_sweep: <Crosshair className="size-4" />,
  engulfing: <Layers className="size-4" />,
  fakeout: <AlertOctagon className="size-4" />,
  reversal: <RefreshCw className="size-4" />,
  trend_continuation: <TrendingUp className="size-4" />,
};

const SESSION_NAMES: Record<string, string> = {
  Asia: "Asia",
  London: "Londres",
  NewYork: "Nueva York",
  Overlap: "Solape",
  OffHours: "Fuera de sesión",
};

const SESSION_COLORS: Record<string, string> = {
  Asia: "#ff8800",
  London: "#00aaff",
  NewYork: "#00ff88",
  Overlap: "#ffaa00",
  OffHours: "#666666",
};

const REGIME_NAMES: Record<string, string> = {
  TRENDING: 'Tendencia',
  RANGING: 'Rango',
  VOLATILE: 'Volátil',
  LOW_VOL: 'Baja Vol.',
  NEWS: 'Noticias',
  LIQUIDITY_TRAP: 'Trampa Liquidez',
};

const REGIME_COLORS: Record<string, string> = {
  TRENDING: '#00ff88',
  RANGING: '#ffaa00',
  VOLATILE: '#ff3366',
  LOW_VOL: '#666666',
  NEWS: '#aa66ff',
  LIQUIDITY_TRAP: '#ff8800',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resultColor(result: string | null): string {
  switch (result) {
    case "WIN": return "text-[#00ff88]";
    case "LOSS": return "text-[#ff3366]";
    case "DRAW": return "text-[#ffaa00]";
    case "NO_OPERAR": return "text-[#00aaff]";
    default: return "text-[#ffaa00]";
  }
}

function resultBg(result: string | null): string {
  switch (result) {
    case "WIN": return "bg-[#00ff88]/15 text-[#00ff88] border-[#00ff88]/30";
    case "LOSS": return "bg-[#ff3366]/15 text-[#ff3366] border-[#ff3366]/30";
    case "DRAW": return "bg-[#ffaa00]/15 text-[#ffaa00] border-[#ffaa00]/30";
    case "NO_OPERAR": return "bg-[#00aaff]/15 text-[#00aaff] border-[#00aaff]/30";
    default: return "bg-[#ffaa00]/15 text-[#ffaa00] border-[#ffaa00]/30";
  }
}

function statusBg(status: string): string {
  switch (status) {
    case "PENDING": return "bg-[#ffaa00]/15 text-[#ffaa00] border-[#ffaa00]/30";
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
    case "warning": return "bg-[#ffaa00]/20 text-[#ffaa00] border-[#ffaa00]/40";
    default: return "bg-[#00aaff]/20 text-[#00aaff] border-[#00aaff]/40";
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const hour = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day}/${month} ${hour}:${min}`;
}

function formatPrice(price: number, asset: string): string {
  if (asset.includes("JPY")) return price.toFixed(3);
  if (asset.includes("BTC")) return price.toFixed(1);
  if (asset.includes("ETH")) return price.toFixed(2);
  return price.toFixed(5);
}

function analysisModeConfig(mode: string | null): { label: string; color: string; bg: string } {
  switch (mode) {
    case "FULL": return { label: "FULL", color: "#00ff88", bg: "bg-[#00ff88]/15 text-[#00ff88] border-[#00ff88]/30" };
    case "PARTIAL": return { label: "PARCIAL", color: "#ffaa00", bg: "bg-[#ffaa00]/15 text-[#ffaa00] border-[#ffaa00]/30" };
    case "FALLBACK": return { label: "FALLBACK", color: "#ff3366", bg: "bg-[#ff3366]/15 text-[#ff3366] border-[#ff3366]/30" };
    case "DEMO": return { label: "DEMO", color: "#666666", bg: "bg-white/10 text-white/50 border-white/20" };
    default: return { label: "FALLBACK", color: "#ff3366", bg: "bg-[#ff3366]/15 text-[#ff3366] border-[#ff3366]/30" };
  }
}

function reliabilityConfig(reliability: string | null): { label: string; color: string } {
  switch (reliability) {
    case "HIGH": return { label: "ALTA", color: "#00ff88" };
    case "MEDIUM": return { label: "MEDIA", color: "#ffaa00" };
    case "LOW": return { label: "BAJA", color: "#ff8800" };
    case "INSUFFICIENT": return { label: "INSUFICIENTE", color: "#ff3366" };
    case "MANUAL": return { label: "MANUAL", color: "#00aaff" };
    default: return { label: "INSUFICIENTE", color: "#ff3366" };
  }
}

function setupScoreColor(score: number | null): string {
  if (score === null) return "#666";
  if (score > 60) return "#00ff88";
  if (score >= 30) return "#ffaa00";
  return "#ff3366";
}

function edgeColor(edge: string): string {
  switch (edge) {
    case "POSITIVE": return "#00ff88";
    case "NEGATIVE": return "#ff3366";
    case "NEUTRAL": return "#ffaa00";
    default: return "#666";
  }
}

function edgeLabel(edge: string): string {
  switch (edge) {
    case "POSITIVE": return "POSITIVO";
    case "NEGATIVE": return "NEGATIVO";
    case "NEUTRAL": return "NEUTRAL";
    default: return "DESCONOCIDO";
  }
}

function sampleLabel(adequacy: string): string {
  switch (adequacy) {
    case "INSUFFICIENT": return "INSUFICIENTE";
    case "LOW": return "BAJA";
    case "MEDIUM": return "MEDIA";
    case "HIGH": return "ALTA";
    default: return adequacy;
  }
}

function detectCurrentSession(): { session: string; sessionEs: string; icon: React.ReactNode; nextSession: string; nextStart: string } {
  const now = new Date();
  const hourUtc = now.getUTCHours();
  const minuteUtc = now.getUTCMinutes();
  const timeInMinutes = hourUtc * 60 + minuteUtc;

  if (timeInMinutes >= 12 * 60 && timeInMinutes < 16 * 60) {
    return { session: "Overlap", sessionEs: "Solape Londres-NY", icon: <Flame className="size-5" />, nextSession: "Nueva York", nextStart: "16:00 UTC" };
  }
  if (timeInMinutes >= 7 * 60 && timeInMinutes < 12 * 60) {
    return { session: "London", sessionEs: "Sesión de Londres", icon: <Sun className="size-5" />, nextSession: "Solape", nextStart: "12:00 UTC" };
  }
  if (timeInMinutes >= 16 * 60 && timeInMinutes < 21 * 60) {
    return { session: "NewYork", sessionEs: "Sesión de Nueva York", icon: <Moon className="size-5" />, nextSession: "Asia", nextStart: "00:00 UTC" };
  }
  if (timeInMinutes < 7 * 60 || (timeInMinutes >= 8 * 60 && timeInMinutes < 9 * 60)) {
    return { session: "Asia", sessionEs: "Sesión Asiática", icon: <Globe className="size-5" />, nextSession: "Londres", nextStart: "07:00 UTC" };
  }
  return { session: "OffHours", sessionEs: "Fuera de sesión", icon: <WifiOff className="size-5" />, nextSession: "Asia", nextStart: "00:00 UTC" };
}

function getNextSessionCountdown(): string {
  const now = new Date();
  const hourUtc = now.getUTCHours();
  const minuteUtc = now.getUTCMinutes();
  const timeInMinutes = hourUtc * 60 + minuteUtc;

  const sessionStarts = [
    { name: "Asia", start: 0 },
    { name: "Londres", start: 7 * 60 },
    { name: "Solape", start: 12 * 60 },
    { name: "Nueva York", start: 16 * 60 },
  ];

  let nextStart = 0;
  for (const s of sessionStarts) {
    if (s.start > timeInMinutes) {
      nextStart = s.start;
      break;
    }
    nextStart = 24 * 60; // next day Asia
  }

  const diff = nextStart - timeInMinutes;
  const hours = Math.floor(diff / 60);
  const mins = diff % 60;
  return `${hours}h ${mins}m`;
}

// ─── Sub-Components ──────────────────────────────────────────────────────────

function StatCard({ title, value, icon, color, subtitle }: {
  title: string; value: string | number; icon: React.ReactNode; color: string; subtitle?: string;
}) {
  return (
    <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.3 }}>
      <Card className="bg-[#111827] border-white/10 hover:border-white/20 transition-colors">
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-white/50 text-xs font-medium uppercase tracking-wide">{title}</span>
            <div style={{ color }}>{icon}</div>
          </div>
          <div className="text-2xl font-bold" style={{ color }}>{value}</div>
          {subtitle && <div className="text-xs text-white/30 mt-1">{subtitle}</div>}
        </CardContent>
      </Card>
    </motion.div>
  );
}

function PatternBadge({ pattern }: { pattern: string | null }) {
  if (!pattern) return <span className="text-white/30 text-xs">—</span>;
  const name = PATTERN_NAMES[pattern] || pattern;
  const icon = PATTERN_ICONS[pattern] || <CircleDot className="size-3" />;
  return (
    <Badge className="bg-[#aa66ff]/15 text-[#aa66ff] border-[#aa66ff]/30 text-[10px] px-1.5 py-0">
      <span className="mr-1">{icon}</span>
      {name}
    </Badge>
  );
}

function SessionBadge({ session }: { session: string | null }) {
  if (!session) return <span className="text-white/30 text-xs">—</span>;
  const name = SESSION_NAMES[session] || session;
  const color = SESSION_COLORS[session] || "#666";
  return (
    <Badge className="text-[10px] px-1.5 py-0" style={{ backgroundColor: `${color}20`, color, borderColor: `${color}40` }}>
      {name}
    </Badge>
  );
}

function SourceBadge({ source }: { source: string }) {
  const config: Record<string, { bg: string; icon: React.ReactNode }> = {
    AUTO: { bg: "bg-[#00ff88]/15 text-[#00ff88] border-[#00ff88]/30", icon: <Bot className="size-3" /> },
    AI: { bg: "bg-[#aa66ff]/15 text-[#aa66ff] border-[#aa66ff]/30", icon: <Sparkles className="size-3" /> },
    MANUAL: { bg: "bg-[#00aaff]/15 text-[#00aaff] border-[#00aaff]/30", icon: <Eye className="size-3" /> },
  };
  const c = config[source] || config.MANUAL;
  return (
    <Badge className={`${c.bg} text-[10px] px-1.5 py-0`}>
      {c.icon}
      <span className="ml-1">{source}</span>
    </Badge>
  );
}

function SetupScoreBar({ score }: { score: number | null }) {
  if (score === null) return <span className="text-white/30 text-xs">—</span>;
  const color = setupScoreColor(score);
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-12 h-1.5 bg-white/10 rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${score}%`, backgroundColor: color }} />
      </div>
      <span className="text-[10px] font-mono" style={{ color }}>{score.toFixed(0)}</span>
    </div>
  );
}

function AnalysisModeBadge({ mode }: { mode: string | null }) {
  const c = analysisModeConfig(mode);
  return (
    <Badge className={`${c.bg} text-[10px] px-1.5 py-0 border`}>
      {c.label}
    </Badge>
  );
}

function RegimeBadge({ regime }: { regime: string | null }) {
  if (!regime) return <span className="text-white/30 text-xs">—</span>;
  const name = REGIME_NAMES[regime] || regime;
  const color = REGIME_COLORS[regime] || "#666";
  return (
    <Badge className="text-[10px] px-1.5 py-0" style={{ backgroundColor: `${color}20`, color, borderColor: `${color}40` }}>
      {name}
    </Badge>
  );
}

function DataSourceIndicators({ dataAvailability }: { dataAvailability: string | null }) {
  if (!dataAvailability) return <span className="text-white/30 text-[9px]">—</span>;
  let parsed: Record<string, boolean> = {};
  try {
    parsed = JSON.parse(dataAvailability);
  } catch {
    return <span className="text-white/30 text-[9px]">—</span>;
  }
  const sources = [
    { key: "market", label: "Market" },
    { key: "volume", label: "Volume" },
    { key: "technical", label: "Technical" },
    { key: "patterns", label: "Patterns" },
    { key: "regime", label: "Regime" },
    { key: "quality", label: "Quality" },
  ];
  return (
    <div className="flex items-center gap-1">
      {sources.map((s) => {
        const available = parsed[s.key] === true;
        return (
          <span key={s.key} className="flex items-center" title={`${s.label}: ${available ? "Disponible" : "No disponible"}`}>
            {available ? (
              <CheckCircle className="size-2.5 text-[#00ff88]" />
            ) : (
              <XCircle className="size-2.5 text-white/20" />
            )}
          </span>
        );
      })}
    </div>
  );
}

function QualityMiniBar({ score }: { score: number | null }) {
  if (score === null) return <span className="text-white/30 text-[10px]">—</span>;
  const color = score > 70 ? "#00ff88" : score >= 40 ? "#ffaa00" : "#ff3366";
  return (
    <div className="flex items-center gap-1">
      <div className="w-8 h-1.5 bg-white/10 rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, score)}%`, backgroundColor: color }} />
      </div>
      <span className="text-[9px] font-mono" style={{ color }}>{score.toFixed(0)}</span>
    </div>
  );
}

function ChartTooltip() {
  return {
    contentStyle: { background: "#1a1f2e", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "8px", fontSize: "12px" },
    labelStyle: { color: "#fff" },
  };
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function TradingDashboard() {
  const [activeTab, setActiveTab] = useState("motor");

  // Data state
  const [stats, setStats] = useState<Stats | null>(null);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [insights, setInsights] = useState<BacktestingInsights | null>(null);
  const [setupScores, setSetupScores] = useState<SetupScoresResponse | null>(null);
  const [autoTraderState, setAutoTraderState] = useState<AutoTraderState | null>(null);
  const [autoTraderConfig, setAutoTraderConfig] = useState<AutoTraderConfig>({
    enabled: false, assets: ["EUR/USD", "GBP/USD", "BTC/USD"], timeframe: "M5",
    intervalMinutes: 5, minSetupScore: 30, maxConcurrentSignals: 10, confidenceBoost: 0, noOperarThreshold: 40,
  });
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [liveFeed, setLiveFeed] = useState<Array<{ time: string; message: string; type: "success" | "skip" | "error" }>>([]);

  // Filter state
  const [filterDirection, setFilterDirection] = useState("ALL");
  const [filterAsset, setFilterAsset] = useState("ALL");
  const [filterTimeframe, setFilterTimeframe] = useState("ALL");
  const [filterStatus, setFilterStatus] = useState("ALL");
  const [filterPattern, setFilterPattern] = useState("ALL");
  const [filterSource, setFilterSource] = useState("ALL");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  // Auto-trader config form
  const [selectedAssets, setSelectedAssets] = useState<string[]>(["EUR/USD", "GBP/USD", "BTC/USD"]);

  // Client-only state to avoid hydration mismatch
  const [currentSession, setCurrentSession] = useState<{ session: string; sessionEs: string; icon: React.ReactNode; nextSession: string; nextStart: string } | null>(null);
  const [nextCountdown, setNextCountdown] = useState("");
  const [mounted, setMounted] = useState(false);

  // Market engine state
  const [marketEngineStatus, setMarketEngineStatus] = useState<MarketEngineStatusPanel | null>(null);
  const [twelveDataApiKey, setTwelveDataApiKey] = useState("");
  const [apiKeyLoading, setApiKeyLoading] = useState(false);

  // Learning engine state
  const [learningReport, setLearningReport] = useState<any>(null);

  // ─── Fetch functions ─────────────────────────────────────────────────────

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/signals/stats");
      if (res.ok) setStats(await res.json());
    } catch (err) { console.error("Error fetching stats:", err); }
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
        setSignals(data.signals || []);
        setTotalPages(data.pagination?.totalPages || 1);
      }
    } catch (err) { console.error("Error fetching signals:", err); }
  }, [page, filterDirection, filterAsset, filterTimeframe, filterStatus]);

  const fetchAlerts = useCallback(async () => {
    try {
      const res = await fetch("/api/signals/alerts");
      if (res.ok) setAlerts(await res.json());
    } catch (err) { console.error("Error fetching alerts:", err); }
  }, []);

  const fetchInsights = useCallback(async () => {
    setLoading((p) => ({ ...p, backtesting: true }));
    try {
      const res = await fetch("/api/signals/backtesting");
      if (res.ok) setInsights(await res.json());
    } catch (err) { console.error("Error fetching insights:", err); }
    finally { setLoading((p) => ({ ...p, backtesting: false })); }
  }, []);

  const fetchSetupScores = useCallback(async () => {
    try {
      const res = await fetch("/api/setup-scores");
      if (res.ok) setSetupScores(await res.json());
    } catch (err) { console.error("Error fetching setup scores:", err); }
  }, []);

  const fetchAutoTrader = useCallback(async () => {
    try {
      const res = await fetch("/api/auto-trader");
      if (res.ok) {
        const data = await res.json();
        setAutoTraderState(data.state);
        if (data.config) {
          setAutoTraderConfig(data.config);
          if (data.config.assets) setSelectedAssets(data.config.assets);
        }
        // Also get market engine status from auto-trader response
        if (data.marketStatus) {
          setMarketEngineStatus({ ...data.marketStatus, twelveDataApiKeySet: data.marketStatus.twelveDataApiKeySet });
        }
      }
    } catch (err) { console.error("Error fetching auto-trader:", err); }
  }, []);

  const fetchMarketEngineStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/market-data?mode=status");
      if (res.ok) setMarketEngineStatus(await res.json());
    } catch (err) { console.error("Error fetching market engine status:", err); }
  }, []);

  const fetchLearningReport = useCallback(async () => {
    try {
      const res = await fetch("/api/learning");
      if (res.ok) setLearningReport(await res.json());
    } catch (err) { console.error("Error fetching learning report:", err); }
  }, []);

  // ─── Effects ─────────────────────────────────────────────────────────────

  useEffect(() => {
    fetchStats();
    fetchAlerts();
    fetchAutoTrader();
    fetchSetupScores();
    fetchMarketEngineStatus();
  }, [fetchStats, fetchAlerts, fetchAutoTrader, fetchSetupScores, fetchMarketEngineStatus]);

  useEffect(() => { fetchSignals(); }, [fetchSignals]);

  useEffect(() => {
    if (activeTab === "backtesting" && !insights) fetchInsights();
    if (activeTab === "setup-scores") fetchSetupScores();
    if (activeTab === "auto-trader") fetchAutoTrader();
    if (activeTab === "learning" && !learningReport) fetchLearningReport();
  }, [activeTab, insights, fetchInsights, fetchSetupScores, fetchAutoTrader, fetchLearningReport, learningReport]);

  // Auto-refresh every 10 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      fetchStats();
      fetchAlerts();
      if (activeTab === "historial") fetchSignals();
      if (activeTab === "auto-trader" || activeTab === "motor") fetchAutoTrader();
      if (activeTab === "setup-scores") fetchSetupScores();
      if (activeTab === "motor") fetchMarketEngineStatus();
    }, 10000);
    return () => clearInterval(interval);
  }, [fetchStats, fetchAlerts, fetchSignals, fetchAutoTrader, fetchSetupScores, fetchMarketEngineStatus, activeTab]);

  // ─── Handlers ────────────────────────────────────────────────────────────

  const handleToggleAutoTrader = async (start: boolean) => {
    setLoading((p) => ({ ...p, autoTrader: true }));
    try {
      const res = await fetch("/api/auto-trader", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: start ? "start" : "stop",
          config: { ...autoTraderConfig, assets: selectedAssets, enabled: start },
        }),
      });
      if (res.ok) {
        await fetchAutoTrader();
        addLiveFeed(start ? "Auto-Trader INICIADO" : "Auto-Trader DETENIDO", start ? "success" : "skip");
      }
    } catch (err) { console.error("Error toggling auto-trader:", err); }
    finally { setLoading((p) => ({ ...p, autoTrader: false })); }
  };

  const handleRunCycle = async () => {
    setLoading((p) => ({ ...p, runCycle: true }));
    try {
      const res = await fetch("/api/auto-trader", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run-cycle" }),
      });
      if (res.ok) {
        const data = await res.json();
        addLiveFeed(`Ciclo ejecutado: ${data.signalsGenerated} generadas, ${data.signalsSkipped} omitidas`, "success");
        fetchAutoTrader();
        fetchStats();
        fetchSignals();
        fetchSetupScores();
      }
    } catch (err) { console.error("Error running cycle:", err); addLiveFeed("Error ejecutando ciclo", "error"); }
    finally { setLoading((p) => ({ ...p, runCycle: false })); }
  };

  const handleUpdateConfig = async () => {
    try {
      await fetch("/api/auto-trader", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update-config",
          config: { ...autoTraderConfig, assets: selectedAssets },
        }),
      });
      fetchAutoTrader();
      addLiveFeed("Configuración actualizada", "success");
    } catch (err) { console.error("Error updating config:", err); }
  };

  const handleCheckPending = async () => {
    try {
      await fetch("/api/signals/check-pending", { method: "POST" });
      fetchStats(); fetchSignals(); fetchAlerts(); fetchSetupScores();
    } catch (err) { console.error("Error checking pending:", err); }
  };

  const handleDismissAlert = async (id: string) => {
    try {
      await fetch("/api/signals/alerts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      fetchAlerts();
    } catch (err) { console.error("Error dismissing alert:", err); }
  };

  const handleCancelSignal = async (id: string) => {
    try {
      await fetch(`/api/signals/${id}`, { method: "DELETE" });
      fetchSignals(); fetchStats();
    } catch (err) { console.error("Error cancelling signal:", err); }
  };

  const handleSeedData = async () => {
    setLoading((p) => ({ ...p, seed: true }));
    try {
      await fetch("/api/market-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "seed" }),
      });
      addLiveFeed("Datos de mercado generados", "success");
    } catch (err) { console.error("Error seeding data:", err); }
    finally { setLoading((p) => ({ ...p, seed: false })); }
  };

  const addLiveFeed = useCallback((message: string, type: "success" | "skip" | "error") => {
    setLiveFeed((prev) => [
      { time: new Date().toLocaleTimeString("es-ES"), message, type },
      ...prev.slice(0, 49),
    ]);
  }, []);

  const handleSetApiKey = async () => {
    if (!twelveDataApiKey.trim()) return;
    setApiKeyLoading(true);
    try {
      const res = await fetch("/api/market-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set-api-key", apiKey: twelveDataApiKey.trim() }),
      });
      if (res.ok) {
        const data = await res.json();
        addLiveFeed(data.message, data.health?.twelveData ? "success" : "skip");
        fetchMarketEngineStatus();
      }
    } catch (err) { console.error("Error setting API key:", err); addLiveFeed("Error configurando API key", "error"); }
    finally { setApiKeyLoading(false); }
  };

  const handleCheckHealth = async () => {
    setApiKeyLoading(true);
    try {
      const res = await fetch("/api/market-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "check-health" }),
      });
      if (res.ok) {
        const data = await res.json();
        const h = data.health;
        addLiveFeed(
          `Binance: ${h?.binance ? "OK" : "OFF"} (${h?.latency?.binance ?? -1}ms) | TwelveData: ${h?.twelveData ? "OK" : "OFF"} (${h?.latency?.twelveData ?? -1}ms)`,
          h?.binance || h?.twelveData ? "success" : "error"
        );
        fetchMarketEngineStatus();
      }
    } catch (err) { console.error("Error checking health:", err); addLiveFeed("Error verificando APIs", "error"); }
    finally { setApiKeyLoading(false); }
  };

  // ─── Chart Data ──────────────────────────────────────────────────────────

  const assetChartData = stats
    ? Object.entries(stats.winRateByAsset).map(([asset, data]) => ({
        name: asset, winRate: Math.round(data.rate), total: data.total,
      }))
    : [];

  const timeframeChartData = stats
    ? Object.entries(stats.winRateByTimeframe).map(([tf, data]) => ({
        name: tf, winRate: Math.round(data.rate), total: data.total,
      }))
    : [];

  const patternChartData = stats
    ? Object.entries(stats.winRateByPattern).map(([p, data]) => ({
        name: PATTERN_NAMES[p] || p, winRate: Math.round(data.rate), total: data.total,
      }))
    : [];

  const sessionChartData = stats
    ? Object.entries(stats.winRateBySession).map(([s, data]) => ({
        name: SESSION_NAMES[s] || s, winRate: Math.round(data.rate), total: data.total,
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

  // Update session info on client only (avoids hydration mismatch)
  useEffect(() => {
    setMounted(true);
    const updateSession = () => {
      setCurrentSession(detectCurrentSession());
      setNextCountdown(getNextSessionCountdown());
    };
    updateSession();
    const interval = setInterval(updateSession, 60000); // update every minute
    return () => clearInterval(interval);
  }, []);

  const totalDecisive = stats ? stats.winCount + stats.lossCount : 0;
  const datasetGoal = 1000;
  const datasetProgress = Math.min(100, ((totalDecisive || 0) / datasetGoal) * 100);
  const reliabilityLevel = stats?.statisticalReliability || "INSUFFICIENT";
  const reliabilityConfig_ = reliabilityConfig(reliabilityLevel);

  // ─── Hydration Guard ─────────────────────────────────────────────────────

  if (!mounted) {
    return (
      <div className="min-h-screen bg-[#0a0e17] flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="size-8 text-[#00ff88] animate-spin mx-auto mb-3" />
          <p className="text-white/40 text-sm">Cargando SignalTrader Pro...</p>
        </div>
      </div>
    );
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#0a0e17] text-white">
      {/* Header */}
      <header className="border-b border-white/10 bg-[#0d1220]/90 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-[#00ff88] to-[#00aaff] flex items-center justify-center">
              <Activity className="size-5 text-[#0a0e17]" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">SignalTrader Pro</h1>
              <p className="text-[10px] text-white/40">Motor Estadístico de Trading</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {autoTraderState?.isRunning && (
              <motion.div animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 2, repeat: Infinity }}>
                <Badge className="bg-[#00ff88]/20 text-[#00ff88] border border-[#00ff88]/40">
                  <Bot className="size-3 mr-1" /> AUTO ON
                </Badge>
              </motion.div>
            )}
            <Button variant="ghost" size="sm" onClick={handleCheckPending} className="text-white/60 hover:text-white hover:bg-white/10">
              <RefreshCw className="size-4 mr-1" /> Verificar
            </Button>
            {alerts.length > 0 && (
              <Badge className="bg-[#ff3366]/20 text-[#ff3366] border border-[#ff3366]/40 animate-pulse">
                <Bell className="size-3 mr-1" /> {alerts.length}
              </Badge>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 py-4">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <ScrollArea className="w-full">
            <TabsList className="bg-[#111827] border border-white/10 w-max min-w-full justify-start">
              <TabsTrigger value="motor" className="data-[state=active]:bg-[#00ff88]/15 data-[state=active]:text-[#00ff88] text-xs">
                <Gauge className="size-3.5 mr-1" /> Motor Estadístico
              </TabsTrigger>
              <TabsTrigger value="historial" className="data-[state=active]:bg-[#00ff88]/15 data-[state=active]:text-[#00ff88] text-xs">
                <Clock className="size-3.5 mr-1" /> Historial
              </TabsTrigger>
              <TabsTrigger value="setup-scores" className="data-[state=active]:bg-[#00ff88]/15 data-[state=active]:text-[#00ff88] text-xs">
                <Target className="size-3.5 mr-1" /> Setup Scores
              </TabsTrigger>
              <TabsTrigger value="patrones" className="data-[state=active]:bg-[#00ff88]/15 data-[state=active]:text-[#00ff88] text-xs">
                <Layers className="size-3.5 mr-1" /> Patrones
              </TabsTrigger>
              <TabsTrigger value="auto-trader" className="data-[state=active]:bg-[#00ff88]/15 data-[state=active]:text-[#00ff88] text-xs">
                <Bot className="size-3.5 mr-1" /> Auto-Trader
              </TabsTrigger>
              <TabsTrigger value="backtesting" className="data-[state=active]:bg-[#00ff88]/15 data-[state=active]:text-[#00ff88] text-xs">
                <Brain className="size-3.5 mr-1" /> Backtesting
              </TabsTrigger>
              <TabsTrigger value="alertas" className="data-[state=active]:bg-[#00ff88]/15 data-[state=active]:text-[#00ff88] text-xs">
                <Bell className="size-3.5 mr-1" /> Alertas
              </TabsTrigger>
              <TabsTrigger value="learning" className="data-[state=active]:bg-[#00ff88]/15 data-[state=active]:text-[#00ff88] text-xs">
                <Brain className="size-3.5 mr-1" /> Learning
              </TabsTrigger>
            </TabsList>
          </ScrollArea>

          {/* ─── TAB 1: MOTOR ESTADÍSTICO ──────────────────────────────────── */}
          <TabsContent value="motor">
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-4 mt-4">

              {/* Session Banner */}
              <Card className="bg-gradient-to-r from-[#111827] to-[#0d1220] border-white/10">
                <CardContent className="p-4">
                  {!currentSession ? (
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full flex items-center justify-center bg-white/5">
                        <Clock className="size-5 text-white/30" />
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-white/30">Cargando sesión...</div>
                        <div className="text-xs text-white/20">Sesión actual</div>
                      </div>
                    </div>
                  ) : (
                  <div className="flex items-center justify-between flex-wrap gap-3">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ backgroundColor: `${SESSION_COLORS[currentSession.session]}20`, color: SESSION_COLORS[currentSession.session] }}>
                        {currentSession.icon}
                      </div>
                      <div>
                        <div className="text-sm font-semibold" style={{ color: SESSION_COLORS[currentSession.session] }}>
                          {currentSession.sessionEs}
                        </div>
                        <div className="text-xs text-white/40">Sesión actual</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <div className="text-xs text-white/40">Próxima sesión</div>
                        <div className="text-sm font-medium text-white/70">{currentSession.nextSession} — {currentSession.nextStart}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-xs text-white/40">Cuenta atrás</div>
                        <div className="text-sm font-mono" style={{ color: NEON_CYAN }}>{nextCountdown}</div>
                      </div>
                    </div>
                  </div>
                  )}
                </CardContent>
              </Card>

              {/* Market Status Panel */}
              <Card className="bg-gradient-to-r from-[#111827] to-[#0d1220] border-white/10">
                <CardHeader className="pb-2">
                  <CardTitle className="text-white text-sm flex items-center gap-2">
                    <Server className="size-4 text-[#00ffcc]" /> Estado del Motor de Datos
                    {marketEngineStatus?.connected ? (
                      <Badge className="bg-[#00ff88]/20 text-[#00ff88] border-[#00ff88]/40 text-[10px]">
                        <Wifi className="size-3 mr-1" /> CONECTADO
                      </Badge>
                    ) : (
                      <Badge className="bg-[#ff3366]/20 text-[#ff3366] border-[#ff3366]/40 text-[10px]">
                        <WifiOff className="size-3 mr-1" /> DESCONECTADO
                      </Badge>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {/* Data Quality & Source Summary */}
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] text-white/40 uppercase">Calidad:</span>
                          <Badge className={`text-[10px] px-1.5 py-0 border ${
                            marketEngineStatus?.dataQuality === "HIGH" ? "bg-[#00ff88]/15 text-[#00ff88] border-[#00ff88]/30" :
                            marketEngineStatus?.dataQuality === "MEDIUM" ? "bg-[#ffaa00]/15 text-[#ffaa00] border-[#ffaa00]/30" :
                            marketEngineStatus?.dataQuality === "LOW" ? "bg-[#ff8800]/15 text-[#ff8800] border-[#ff8800]/30" :
                            "bg-[#ff3366]/15 text-[#ff3366] border-[#ff3366]/30"
                          }`}>
                            {marketEngineStatus?.dataQuality || "OFFLINE"}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] text-white/40">Binance:</span>
                          <span className={`text-[10px] font-medium ${marketEngineStatus?.binanceAvailable ? "text-[#00ff88]" : "text-[#ff3366]"}`}>
                            {marketEngineStatus?.binanceAvailable ? "● ACTIVO" : "○ OFF"}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] text-white/40">TwelveData:</span>
                          <span className={`text-[10px] font-medium ${marketEngineStatus?.twelveDataAvailable ? "text-[#00ff88]" : "text-[#ff3366]"}`}>
                            {marketEngineStatus?.twelveDataAvailable ? "● ACTIVO" : "○ OFF"}
                          </span>
                        </div>
                      </div>
                      <Button variant="ghost" size="sm" onClick={handleCheckHealth} disabled={apiKeyLoading} className="text-white/50 hover:text-white hover:bg-white/10 text-[10px] h-6">
                        <Signal className="size-3 mr-1" /> Check APIs
                      </Button>
                    </div>

                    {/* Per-Asset Source Table */}
                    <div className="grid grid-cols-1 sm:grid-cols-5 gap-1.5">
                      {ASSETS.map((asset) => {
                        const src = marketEngineStatus?.sources?.[asset] || "OFFLINE";
                        const price = marketEngineStatus?.lastPrice?.[asset];
                        const lat = marketEngineStatus?.latency?.[asset];
                        const srcColor = src === "BINANCE" ? "#00ff88" : src === "TWELVEDATA" ? "#00aaff" : src === "FALLBACK" ? "#ff8800" : "#ff3366";
                        const srcLabel = src === "BINANCE" ? "BIN" : src === "TWELVEDATA" ? "12D" : src === "FALLBACK" ? "SIM" : "OFF";
                        return (
                          <div key={asset} className="p-2 rounded-lg bg-white/5 flex flex-col gap-0.5">
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] text-white/70 font-medium">{asset}</span>
                              <Badge className="text-[8px] px-1 py-0 border" style={{ backgroundColor: `${srcColor}15`, color: srcColor, borderColor: `${srcColor}30` }}>
                                {srcLabel}
                              </Badge>
                            </div>
                            <div className="text-[11px] font-mono text-white">
                              {price ? formatPrice(price, asset) : "—"}
                            </div>
                            {lat !== undefined && lat >= 0 && (
                              <div className="text-[8px] text-white/30">{lat}ms</div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {/* API Key Input */}
                    <div className="flex items-center gap-2 pt-1 border-t border-white/5">
                      <Key className="size-3 text-white/30" />
                      <span className="text-[10px] text-white/40 whitespace-nowrap">TwelveData API Key:</span>
                      <Input
                        type="password"
                        value={twelveDataApiKey}
                        onChange={(e) => setTwelveDataApiKey(e.target.value)}
                        placeholder={marketEngineStatus?.twelveDataApiKeySet ? "●●●● (configurada)" : "Introduce tu API key..."}
                        className="bg-[#0a0e17] border-white/10 text-white text-[10px] h-6 flex-1"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleSetApiKey}
                        disabled={apiKeyLoading || !twelveDataApiKey.trim()}
                        className="border-white/20 text-white/70 hover:text-white hover:bg-white/10 text-[10px] h-6 px-2"
                      >
                        {apiKeyLoading ? <Loader2 className="size-3 animate-spin" /> : "Guardar"}
                      </Button>
                    </div>

                    {/* Errors */}
                    {marketEngineStatus?.errors && marketEngineStatus.errors.length > 0 && (
                      <div className="space-y-1">
                        {marketEngineStatus.errors.slice(0, 3).map((err, i) => (
                          <div key={i} className="text-[9px] text-[#ff8800]/70 bg-[#ff8800]/5 px-2 py-1 rounded">
                            {err}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              {/* Auto-Trader Control Panel */}
              <Card className="bg-[#111827] border-white/10">
                <CardHeader className="pb-2">
                  <CardTitle className="text-white text-sm flex items-center gap-2">
                    <Bot className="size-4 text-[#00ff88]" /> Auto-Trader
                    {autoTraderState?.isRunning ? (
                      <Badge className="bg-[#00ff88]/20 text-[#00ff88] border-[#00ff88]/40 text-[10px]">EN EJECUCIÓN</Badge>
                    ) : (
                      <Badge className="bg-[#ff3366]/20 text-[#ff3366] border-[#ff3366]/40 text-[10px]">DETENIDO</Badge>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-4 flex-wrap">
                    <motion.div whileTap={{ scale: 0.95 }}>
                      <Button
                        onClick={() => handleToggleAutoTrader(!autoTraderState?.isRunning)}
                        disabled={loading.autoTrader}
                        className={autoTraderState?.isRunning
                          ? "bg-[#ff3366] hover:bg-[#ff3366]/80 text-white font-bold px-6"
                          : "bg-[#00ff88] hover:bg-[#00ff88]/80 text-[#0a0e17] font-bold px-6"}
                      >
                        {loading.autoTrader ? <Loader2 className="size-4 mr-2 animate-spin" /> :
                          autoTraderState?.isRunning ? <><Square className="size-4 mr-2" /> DETENER</> : <><Play className="size-4 mr-2" /> INICIAR</>
                        }
                      </Button>
                    </motion.div>
                    <Button variant="outline" size="sm" onClick={handleRunCycle} disabled={loading.runCycle} className="border-white/20 text-white/70 hover:text-white hover:bg-white/10">
                      {loading.runCycle ? <Loader2 className="size-3 mr-1 animate-spin" /> : <Zap className="size-3 mr-1" />} Ejecutar Ciclo
                    </Button>
                    <div className="flex gap-4 text-xs text-white/50">
                      <span>Generadas: <b className="text-white">{autoTraderState?.totalGenerated || 0}</b></span>
                      <span>Verificadas: <b className="text-white">{autoTraderState?.totalVerified || 0}</b></span>
                      <span>Pendientes: <b className="text-[#ffaa00]">{autoTraderState?.currentPending || 0}</b></span>
                      <span>Último check: <b className="text-white">{autoTraderState?.lastCheck ? formatTime(autoTraderState.lastCheck) : "—"}</b></span>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* KPI Cards */}
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-3">
                <StatCard title="Total Señales" value={stats?.totalSignals || 0} icon={<Activity className="size-5" />} color={NEON_BLUE} />
                <StatCard title="Win Rate" value={`${stats?.winRate.toFixed(1) || 0}%`} icon={<Target className="size-5" />} color={stats && stats.winRate >= 60 ? NEON_GREEN : NEON_RED} />
                <StatCard title="WR Bayesiana" value={`${setupScores?.scores.length ? (setupScores.scores.reduce((a, s) => a + (s.bayesianWinRate ?? 0), 0) / setupScores.scores.length).toFixed(1) : "0"}%`} icon={<Brain className="size-5" />} color={NEON_PURPLE} subtitle="Promedio ajustado" />
                <StatCard title="Profit Factor" value={stats?.profitFactor === -1 ? "∞" : (stats?.profitFactor || 0).toFixed(2)} icon={<TrendingUp className="size-5" />} color={stats && stats.profitFactor >= 1.5 ? NEON_GREEN : NEON_YELLOW} />
                <StatCard title="Pendientes" value={stats?.pendingCount || 0} icon={<Clock className="size-5" />} color={NEON_YELLOW} />
                <StatCard title="NO OPERAR" value={stats?.noOperarCount || 0} icon={<Shield className="size-5" />} color={NEON_BLUE} />
                <StatCard title="Muestra" value={totalDecisive} icon={<Database className="size-5" />} color={totalDecisive >= 100 ? NEON_GREEN : totalDecisive >= 30 ? NEON_YELLOW : NEON_RED} />
              </div>

              {/* Regime Detection */}
              <Card className="bg-gradient-to-r from-[#111827] to-[#0d1220] border-white/10">
                <CardHeader className="pb-2">
                  <CardTitle className="text-white text-sm flex items-center gap-2">
                    <Gauge className="size-4 text-[#00ffcc]" /> Detección de Régimen de Mercado
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {signals.length > 0 ? (() => {
                    const latestSignal = signals.find(s => s.marketRegime);
                    const regime = latestSignal?.marketRegime || null;
                    const regimeColor = regime ? (REGIME_COLORS[regime] || "#666") : "#666";
                    return (
                      <div className="flex items-center justify-between flex-wrap gap-3">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ backgroundColor: `${regimeColor}20`, color: regimeColor }}>
                            {regime === "TRENDING" ? <TrendingUp className="size-5" /> :
                             regime === "RANGING" ? <MinusCircle className="size-5" /> :
                             regime === "VOLATILE" ? <AlertTriangle className="size-5" /> :
                             regime === "LOW_VOL" ? <WifiOff className="size-5" /> :
                             regime === "NEWS" ? <Bell className="size-5" /> :
                             regime === "LIQUIDITY_TRAP" ? <Crosshair className="size-5" /> :
                             <Gauge className="size-5" />}
                          </div>
                          <div>
                            <div className="text-sm font-semibold" style={{ color: regimeColor }}>
                              {regime ? (REGIME_NAMES[regime] || regime) : "Sin datos"}
                            </div>
                            <div className="text-xs text-white/40">Régimen detectado más reciente</div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <RegimeBadge regime={regime} />
                          {latestSignal && (
                            <span className="text-[9px] text-white/30">
                              Basado en señal del {formatTime(latestSignal.entryTime)}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })() : (
                    <div className="text-xs text-white/30 text-center py-2">Sin datos de régimen. Genera señales para detectar el régimen de mercado.</div>
                  )}
                </CardContent>
              </Card>

              {/* Statistical Reliability Banner */}
              <Card className={`border ${reliabilityLevel === "HIGH" ? "bg-[#00ff88]/5 border-[#00ff88]/20" : reliabilityLevel === "MEDIUM" ? "bg-[#ffaa00]/5 border-[#ffaa00]/20" : reliabilityLevel === "LOW" ? "bg-[#ff8800]/5 border-[#ff8800]/20" : "bg-[#ff3366]/5 border-[#ff3366]/20"}`}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between flex-wrap gap-3">
                    <div className="flex items-center gap-3">
                      <AlertTriangle className="size-5" style={{ color: reliabilityConfig_.color }} />
                      <div>
                        <div className="text-sm font-semibold" style={{ color: reliabilityConfig_.color }}>
                          Confiabilidad Estadística: {reliabilityConfig_.label}
                        </div>
                        <div className="text-xs text-white/40">{totalDecisive} señales decisivas de {datasetGoal} necesarias</div>
                      </div>
                    </div>
                    <div className="w-48">
                      <Progress value={datasetProgress} className="h-2" />
                      <div className="text-[10px] text-white/30 mt-1 text-right">{datasetProgress.toFixed(0)}%</div>
                    </div>
                  </div>
                  <p className="text-xs text-white/50 mt-2 italic">
                    Sigue recolectando datos. El dataset es tu activo más valioso.
                  </p>
                </CardContent>
              </Card>

              {/* Dataset Progress Bar */}
              <Card className="bg-[#111827] border-white/10">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-white/50">Progreso del Dataset hacia {datasetGoal} señales</span>
                    <span className="text-xs font-mono" style={{ color: reliabilityConfig_.color }}>{totalDecisive}/{datasetGoal}</span>
                  </div>
                  <div className="w-full h-3 bg-white/5 rounded-full overflow-hidden">
                    <motion.div
                      className="h-full rounded-full"
                      initial={{ width: 0 }}
                      animate={{ width: `${datasetProgress}%` }}
                      transition={{ duration: 1, ease: "easeOut" }}
                      style={{
                        background: `linear-gradient(90deg, ${totalDecisive >= 500 ? NEON_GREEN : totalDecisive >= 100 ? NEON_YELLOW : totalDecisive >= 30 ? "#ff8800" : NEON_RED}, ${totalDecisive >= 500 ? "#00ffcc" : totalDecisive >= 100 ? "#ffcc00" : "#ff4488"})`,
                      }}
                    />
                  </div>
                  <div className="flex justify-between mt-1">
                    <span className="text-[9px] text-[#ff3366]/60">30 = LOW</span>
                    <span className="text-[9px] text-[#ff8800]/60">100 = MEDIUM</span>
                    <span className="text-[9px] text-[#ffaa00]/60">500 = HIGH</span>
                    <span className="text-[9px] text-[#00ff88]/60">1000+ = VERY HIGH</span>
                  </div>
                </CardContent>
              </Card>

              {/* Recent Auto Signals */}
              <Card className="bg-[#111827] border-white/10">
                <CardHeader className="pb-2">
                  <CardTitle className="text-white text-sm flex items-center gap-2">
                    <Bot className="size-4 text-[#aa66ff]" /> Últimas Señales Auto
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {autoTraderState?.recentSignals && autoTraderState.recentSignals.length > 0 ? (
                    <div className="space-y-2">
                      {autoTraderState.recentSignals.slice(0, 5).map((s) => (
                        <div key={s.id} className="flex items-center justify-between p-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors">
                          <div className="flex items-center gap-2">
                            {directionIcon(s.direction)}
                            <span className="text-xs font-medium text-white">{s.asset}</span>
                            <PatternBadge pattern={s.pattern} />
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="text-[10px] text-white/40">Conf: {s.confidence.toFixed(0)}%</span>
                            <SetupScoreBar score={s.setupScore} />
                            <Badge className={`${s.status === "PENDING" ? "bg-[#ffaa00]/15 text-[#ffaa00] border-[#ffaa00]/30" : "bg-[#00aaff]/15 text-[#00aaff] border-[#00aaff]/30"} text-[10px]`}>
                              {s.status}
                            </Badge>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-white/30 text-xs text-center py-4">No hay señales auto generadas aún. Inicia el Auto-Trader.</p>
                  )}
                </CardContent>
              </Card>

              {/* Charts Row */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <Card className="bg-[#111827] border-white/10">
                  <CardHeader><CardTitle className="text-white text-sm">Rendimiento Semanal</CardTitle></CardHeader>
                  <CardContent>
                    {weeklyData.length > 0 ? (
                      <ResponsiveContainer width="100%" height={200}>
                        <BarChart data={weeklyData}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                          <XAxis dataKey="week" tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 9 }} />
                          <YAxis tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 9 }} />
                          <RechartsTooltip {...ChartTooltip()} />
                          <Bar dataKey="wins" fill={NEON_GREEN} radius={[4, 4, 0, 0]} />
                          <Bar dataKey="losses" fill={NEON_RED} radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    ) : <div className="h-[200px] flex items-center justify-center text-white/30 text-sm">Sin datos suficientes</div>}
                  </CardContent>
                </Card>

                <Card className="bg-[#111827] border-white/10">
                  <CardHeader><CardTitle className="text-white text-sm">Distribución de Resultados</CardTitle></CardHeader>
                  <CardContent>
                    {resultPieData.length > 0 ? (
                      <ResponsiveContainer width="100%" height={200}>
                        <PieChart>
                          <Pie data={resultPieData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={3} dataKey="value">
                            {resultPieData.map((entry, index) => (<Cell key={`cell-${index}`} fill={entry.color} />))}
                          </Pie>
                          <Legend formatter={(value: string) => <span style={{ color: "rgba(255,255,255,0.7)", fontSize: 11 }}>{value}</span>} />
                          <RechartsTooltip {...ChartTooltip()} />
                        </PieChart>
                      </ResponsiveContainer>
                    ) : <div className="h-[200px] flex items-center justify-center text-white/30 text-sm">Sin datos suficientes</div>}
                  </CardContent>
                </Card>
              </div>
            </motion.div>
          </TabsContent>

          {/* ─── TAB 2: HISTORIAL ──────────────────────────────────────────── */}
          <TabsContent value="historial">
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-4 mt-4">
              {/* Filters */}
              <Card className="bg-[#111827] border-white/10">
                <CardContent className="pt-4 pb-4">
                  <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
                    <Select value={filterStatus} onValueChange={(v) => { setFilterStatus(v); setPage(1); }}>
                      <SelectTrigger className="bg-[#0a0e17] border-white/10 text-white text-xs"><SelectValue placeholder="Estado" /></SelectTrigger>
                      <SelectContent className="bg-[#111827] border-white/10">
                        <SelectItem value="ALL">Todos</SelectItem>
                        <SelectItem value="PENDING">Pendiente</SelectItem>
                        <SelectItem value="CLOSED">Cerrada</SelectItem>
                        <SelectItem value="CANCELLED">Cancelada</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select value={filterDirection} onValueChange={(v) => { setFilterDirection(v); setPage(1); }}>
                      <SelectTrigger className="bg-[#0a0e17] border-white/10 text-white text-xs"><SelectValue placeholder="Dirección" /></SelectTrigger>
                      <SelectContent className="bg-[#111827] border-white/10">
                        <SelectItem value="ALL">Todas</SelectItem>
                        <SelectItem value="HIGHER">HIGHER</SelectItem>
                        <SelectItem value="LOWER">LOWER</SelectItem>
                        <SelectItem value="NO_OPERAR">NO_OPERAR</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select value={filterAsset} onValueChange={(v) => { setFilterAsset(v); setPage(1); }}>
                      <SelectTrigger className="bg-[#0a0e17] border-white/10 text-white text-xs"><SelectValue placeholder="Activo" /></SelectTrigger>
                      <SelectContent className="bg-[#111827] border-white/10">
                        <SelectItem value="ALL">Todos</SelectItem>
                        {ASSETS.map((a) => (<SelectItem key={a} value={a}>{a}</SelectItem>))}
                      </SelectContent>
                    </Select>
                    <Select value={filterTimeframe} onValueChange={(v) => { setFilterTimeframe(v); setPage(1); }}>
                      <SelectTrigger className="bg-[#0a0e17] border-white/10 text-white text-xs"><SelectValue placeholder="Temporalidad" /></SelectTrigger>
                      <SelectContent className="bg-[#111827] border-white/10">
                        <SelectItem value="ALL">Todas</SelectItem>
                        {TIMEFRAMES.map((t) => (<SelectItem key={t} value={t}>{t}</SelectItem>))}
                      </SelectContent>
                    </Select>
                    <Select value={filterPattern} onValueChange={(v) => { setFilterPattern(v); setPage(1); }}>
                      <SelectTrigger className="bg-[#0a0e17] border-white/10 text-white text-xs"><SelectValue placeholder="Patrón" /></SelectTrigger>
                      <SelectContent className="bg-[#111827] border-white/10">
                        <SelectItem value="ALL">Todos</SelectItem>
                        {PATTERN_TYPES.map((p) => (<SelectItem key={p} value={p}>{PATTERN_NAMES[p]}</SelectItem>))}
                      </SelectContent>
                    </Select>
                    <Select value={filterSource} onValueChange={(v) => { setFilterSource(v); setPage(1); }}>
                      <SelectTrigger className="bg-[#0a0e17] border-white/10 text-white text-xs"><SelectValue placeholder="Fuente" /></SelectTrigger>
                      <SelectContent className="bg-[#111827] border-white/10">
                        <SelectItem value="ALL">Todas</SelectItem>
                        <SelectItem value="AUTO">AUTO</SelectItem>
                        <SelectItem value="AI">AI</SelectItem>
                        <SelectItem value="MANUAL">MANUAL</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button variant="outline" onClick={() => { setFilterStatus("ALL"); setFilterDirection("ALL"); setFilterAsset("ALL"); setFilterTimeframe("ALL"); setFilterPattern("ALL"); setFilterSource("ALL"); setPage(1); }} className="bg-[#0a0e17] border-white/10 text-white/70 hover:text-white hover:bg-white/10 text-xs">
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
                          <TableHead className="text-white/50 text-[10px]">Hora</TableHead>
                          <TableHead className="text-white/50 text-[10px]">Activo</TableHead>
                          <TableHead className="text-white/50 text-[10px]">TF</TableHead>
                          <TableHead className="text-white/50 text-[10px]">Dir.</TableHead>
                          <TableHead className="text-white/50 text-[10px]">Entrada</TableHead>
                          <TableHead className="text-white/50 text-[10px]">Resultado</TableHead>
                          <TableHead className="text-white/50 text-[10px]">Patrón</TableHead>
                          <TableHead className="text-white/50 text-[10px]">Sesión</TableHead>
                          <TableHead className="text-white/50 text-[10px]">Régimen</TableHead>
                          <TableHead className="text-white/50 text-[10px]">Setup</TableHead>
                          <TableHead className="text-white/50 text-[10px]">EV</TableHead>
                          <TableHead className="text-white/50 text-[10px]">Calidad</TableHead>
                          <TableHead className="text-white/50 text-[10px]">Datos</TableHead>
                          <TableHead className="text-white/50 text-[10px]">Fuente</TableHead>
                          <TableHead className="text-white/50 text-[10px]">Modo</TableHead>
                          <TableHead className="text-white/50 text-[10px]">Acción</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {signals.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={16} className="text-center text-white/30 py-8 text-sm">No hay señales registradas</TableCell>
                          </TableRow>
                        ) : (
                          signals
                            .filter(s => filterPattern === "ALL" || s.patternType === filterPattern)
                            .filter(s => filterSource === "ALL" || s.source === filterSource)
                            .map((signal) => (
                            <TableRow key={signal.id} className="border-white/5 hover:bg-white/5">
                              <TableCell className="text-white/70 text-[10px] whitespace-nowrap">{formatTime(signal.entryTime)}</TableCell>
                              <TableCell className="text-white text-[10px] font-medium">{signal.asset}</TableCell>
                              <TableCell className="text-white/70 text-[10px]">{signal.timeframe}</TableCell>
                              <TableCell>
                                <div className="flex items-center gap-1">
                                  {directionIcon(signal.direction)}
                                  <span className={`text-[10px] ${signal.direction === "HIGHER" ? "text-[#00ff88]" : signal.direction === "LOWER" ? "text-[#ff3366]" : "text-[#00aaff]"}`}>
                                    {signal.direction}
                                  </span>
                                </div>
                              </TableCell>
                              <TableCell className="text-white/70 text-[10px] font-mono">{formatPrice(signal.entryPrice, signal.asset)}</TableCell>
                              <TableCell>
                                <Badge className={`${resultBg(signal.result)} text-[10px] px-1.5 py-0 border`}>
                                  {signal.result || signal.status}
                                </Badge>
                              </TableCell>
                              <TableCell><PatternBadge pattern={signal.patternType} /></TableCell>
                              <TableCell><SessionBadge session={signal.sessionType} /></TableCell>
                              <TableCell><RegimeBadge regime={signal.marketRegime} /></TableCell>
                              <TableCell><SetupScoreBar score={signal.setupScore} /></TableCell>
                              <TableCell className="text-[10px] font-mono" style={{ color: (signal.expectancy ?? 0) > 0 ? NEON_GREEN : (signal.expectancy ?? 0) < 0 ? NEON_RED : "#666" }}>
                                {signal.expectancy !== null ? signal.expectancy.toFixed(2) : "—"}
                              </TableCell>
                              <TableCell><QualityMiniBar score={signal.qualityScore} /></TableCell>
                              <TableCell><DataSourceIndicators dataAvailability={signal.dataAvailability} /></TableCell>
                              <TableCell><SourceBadge source={signal.source} /></TableCell>
                              <TableCell><AnalysisModeBadge mode={signal.analysisMode} /></TableCell>
                              <TableCell>
                                {signal.status === "PENDING" && (
                                  <Button variant="ghost" size="sm" onClick={() => handleCancelSignal(signal.id)} className="text-[#ff3366]/70 hover:text-[#ff3366] hover:bg-[#ff3366]/10 h-6 text-[10px]">
                                    Cancelar
                                  </Button>
                                )}
                              </TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </ScrollArea>
                </CardContent>
              </Card>

              {/* Pagination */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-white/30">Página {page} de {totalPages}</span>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)} className="border-white/10 text-white/50 hover:text-white">
                    <ChevronLeft className="size-3" />
                  </Button>
                  <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)} className="border-white/10 text-white/50 hover:text-white">
                    <ChevronRight className="size-3" />
                  </Button>
                </div>
              </div>
            </motion.div>
          </TabsContent>

          {/* ─── TAB 3: SETUP SCORES ───────────────────────────────────────── */}
          <TabsContent value="setup-scores">
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-4 mt-4">

              {/* No Edge Warning */}
              {setupScores && Object.values(setupScores.summary.byPattern).every(p => p.edge !== "POSITIVE") && (
                <Card className="bg-[#ff3366]/5 border-[#ff3366]/30">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <AlertOctagon className="size-6 text-[#ff3366]" />
                      <div>
                        <div className="text-sm font-bold text-[#ff3366]">NO HAY EDGE DETECTADO</div>
                        <div className="text-xs text-white/50">Ningún patrón muestra un edge positivo estadísticamente significativo. Sigue recolectando datos antes de operar con confianza.</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Pattern Performance Table */}
              <Card className="bg-[#111827] border-white/10">
                <CardHeader><CardTitle className="text-white text-sm flex items-center gap-2"><Flame className="size-4 text-[#aa66ff]" /> Rendimiento por Patrón</CardTitle></CardHeader>
                <CardContent>
                  <ScrollArea className="w-full">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-white/10 hover:bg-transparent">
                          <TableHead className="text-white/50 text-[10px]">Patrón</TableHead>
                          <TableHead className="text-white/50 text-[10px]">Total</TableHead>
                          <TableHead className="text-white/50 text-[10px]">Wins</TableHead>
                          <TableHead className="text-white/50 text-[10px]">Losses</TableHead>
                          <TableHead className="text-white/50 text-[10px]">Win Rate</TableHead>
                          <TableHead className="text-white/50 text-[10px]">Edge</TableHead>
                          <TableHead className="text-white/50 text-[10px]">Muestra</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {setupScores ? Object.entries(setupScores.summary.byPattern).map(([pattern, data]) => (
                          <TableRow key={pattern} className="border-white/5 hover:bg-white/5">
                            <TableCell><PatternBadge pattern={pattern} /></TableCell>
                            <TableCell className="text-white text-[10px]">{data.totalSignals}</TableCell>
                            <TableCell className="text-[#00ff88] text-[10px]">{data.wins}</TableCell>
                            <TableCell className="text-[#ff3366] text-[10px]">{data.losses}</TableCell>
                            <TableCell className="text-[10px] font-mono" style={{ color: data.winRate >= 60 ? NEON_GREEN : data.winRate >= 50 ? NEON_YELLOW : NEON_RED }}>
                              {data.winRate.toFixed(1)}%
                            </TableCell>
                            <TableCell>
                              <Badge className="text-[10px] px-1.5 py-0 border" style={{ backgroundColor: `${edgeColor(data.edge)}15`, color: edgeColor(data.edge), borderColor: `${edgeColor(data.edge)}30` }}>
                                {edgeLabel(data.edge)}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-white/40 text-[10px]">{data.totalSignals < 30 ? "INSUFICIENTE" : data.totalSignals < 100 ? "BAJA" : data.totalSignals < 500 ? "MEDIA" : "ALTA"}</TableCell>
                          </TableRow>
                        )) : (
                          <TableRow><TableCell colSpan={7} className="text-center text-white/30 py-8 text-xs">Cargando datos...</TableCell></TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </ScrollArea>
                </CardContent>
              </Card>

              {/* Session Performance Table */}
              <Card className="bg-[#111827] border-white/10">
                <CardHeader><CardTitle className="text-white text-sm flex items-center gap-2"><Globe className="size-4 text-[#00aaff]" /> Rendimiento por Sesión</CardTitle></CardHeader>
                <CardContent>
                  <ScrollArea className="w-full">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-white/10 hover:bg-transparent">
                          <TableHead className="text-white/50 text-[10px]">Sesión</TableHead>
                          <TableHead className="text-white/50 text-[10px]">Total</TableHead>
                          <TableHead className="text-white/50 text-[10px]">Wins</TableHead>
                          <TableHead className="text-white/50 text-[10px]">Losses</TableHead>
                          <TableHead className="text-white/50 text-[10px]">Win Rate</TableHead>
                          <TableHead className="text-white/50 text-[10px]">Edge</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {setupScores ? Object.entries(setupScores.summary.bySession).map(([session, data]) => (
                          <TableRow key={session} className="border-white/5 hover:bg-white/5">
                            <TableCell><SessionBadge session={session} /></TableCell>
                            <TableCell className="text-white text-[10px]">{data.totalSignals}</TableCell>
                            <TableCell className="text-[#00ff88] text-[10px]">{data.wins}</TableCell>
                            <TableCell className="text-[#ff3366] text-[10px]">{data.losses}</TableCell>
                            <TableCell className="text-[10px] font-mono" style={{ color: data.winRate >= 60 ? NEON_GREEN : data.winRate >= 50 ? NEON_YELLOW : NEON_RED }}>
                              {data.winRate.toFixed(1)}%
                            </TableCell>
                            <TableCell>
                              <Badge className="text-[10px] px-1.5 py-0 border" style={{ backgroundColor: `${edgeColor(data.edge)}15`, color: edgeColor(data.edge), borderColor: `${edgeColor(data.edge)}30` }}>
                                {edgeLabel(data.edge)}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        )) : (
                          <TableRow><TableCell colSpan={6} className="text-center text-white/30 py-8 text-xs">Cargando datos...</TableCell></TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </ScrollArea>
                </CardContent>
              </Card>

              {/* Pattern × Session Matrix */}
              <Card className="bg-[#111827] border-white/10">
                <CardHeader><CardTitle className="text-white text-sm flex items-center gap-2"><Layers className="size-4 text-[#ffaa00]" /> Matriz Patrón × Sesión</CardTitle></CardHeader>
                <CardContent>
                  {setupScores && setupScores.scores.length > 0 ? (
                    <ScrollArea className="w-full">
                      <div className="min-w-[500px]">
                        <div className="grid grid-cols-6 gap-1 mb-1">
                          <div className="text-[9px] text-white/30 p-1">Patrón \ Sesión</div>
                          {SESSION_TYPES.filter(s => s !== "OffHours").map(s => (
                            <div key={s} className="text-[9px] text-white/40 p-1 text-center" style={{ color: SESSION_COLORS[s] }}>{SESSION_NAMES[s]}</div>
                          ))}
                        </div>
                        {PATTERN_TYPES.map(pattern => {
                          const row = SESSION_TYPES.filter(s => s !== "OffHours").map(session => {
                            const match = setupScores.scores.find(sc => sc.patternType === pattern && sc.session === session);
                            return match ? { winRate: match.winRate, total: match.totalSignals, edge: match.edge } : null;
                          });
                          return (
                            <div key={pattern} className="grid grid-cols-6 gap-1 mb-1">
                              <div className="text-[10px] text-white/60 p-1 flex items-center gap-1">
                                {PATTERN_ICONS[pattern]}
                                <span>{PATTERN_NAMES[pattern]}</span>
                              </div>
                              {row.map((cell, i) => (
                                <div key={i} className={`p-1.5 rounded text-center text-[10px] font-mono ${
                                  cell ? (cell.total < 5 ? "bg-white/5" : cell.winRate >= 60 ? "bg-[#00ff88]/15 text-[#00ff88]" : cell.winRate >= 50 ? "bg-[#ffaa00]/15 text-[#ffaa00]" : "bg-[#ff3366]/15 text-[#ff3366]")
                                  : "bg-white/5 text-white/20"
                                }`}>
                                  {cell ? (cell.total < 5 ? `${cell.total}` : `${cell.winRate.toFixed(0)}%`) : "—"}
                                </div>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    </ScrollArea>
                  ) : (
                    <p className="text-white/30 text-xs text-center py-8">Sin datos de setup scores. Ejecuta el Auto-Trader para generar datos.</p>
                  )}
                </CardContent>
              </Card>

              {/* Detailed Scores */}
              <Card className="bg-[#111827] border-white/10">
                <CardHeader><CardTitle className="text-white text-sm flex items-center gap-2"><Database className="size-4 text-[#00ffcc]" /> Detalle de Setup Scores</CardTitle></CardHeader>
                <CardContent>
                  <ScrollArea className="h-96">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-white/10 hover:bg-transparent">
                          <TableHead className="text-white/50 text-[10px]">Patrón</TableHead>
                          <TableHead className="text-white/50 text-[10px]">Activo</TableHead>
                          <TableHead className="text-white/50 text-[10px]">Sesión</TableHead>
                          <TableHead className="text-white/50 text-[10px]">Total</TableHead>
                          <TableHead className="text-white/50 text-[10px]">Win Rate</TableHead>
                          <TableHead className="text-white/50 text-[10px]">WR Bayesiana</TableHead>
                          <TableHead className="text-white/50 text-[10px]">IC 95%</TableHead>
                          <TableHead className="text-white/50 text-[10px]">p-value</TableHead>
                          <TableHead className="text-white/50 text-[10px]">EV</TableHead>
                          <TableHead className="text-white/50 text-[10px]">R:R</TableHead>
                          <TableHead className="text-white/50 text-[10px]">Edge</TableHead>
                          <TableHead className="text-white/50 text-[10px]">Muestra</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {setupScores ? setupScores.scores.map((s, i) => (
                          <TableRow key={i} className="border-white/5 hover:bg-white/5">
                            <TableCell><PatternBadge pattern={s.patternType} /></TableCell>
                            <TableCell className="text-white/70 text-[10px]">{s.asset || "Todos"}</TableCell>
                            <TableCell><SessionBadge session={s.session} /></TableCell>
                            <TableCell className="text-white text-[10px]">{s.totalSignals}</TableCell>
                            <TableCell className="text-[10px] font-mono" style={{ color: s.winRate >= 60 ? NEON_GREEN : s.winRate >= 50 ? NEON_YELLOW : NEON_RED }}>
                              {s.winRate.toFixed(1)}%
                            </TableCell>
                            <TableCell className="text-[10px] font-mono" style={{ color: (s.bayesianWinRate ?? 0) >= 60 ? NEON_GREEN : (s.bayesianWinRate ?? 0) >= 50 ? NEON_YELLOW : NEON_RED }}>
                              {(s.bayesianWinRate ?? 0).toFixed(1)}%
                            </TableCell>
                            <TableCell className="text-[10px] font-mono text-white/50">
                              {(s.confidenceIntervalLower ?? 0).toFixed(1)}%–{(s.confidenceIntervalUpper ?? 0).toFixed(1)}%
                            </TableCell>
                            <TableCell className="text-[10px] font-mono" style={{ color: (s.pValue ?? 1) < 0.05 ? NEON_GREEN : (s.pValue ?? 1) < 0.1 ? NEON_YELLOW : NEON_RED }}>
                              {(s.pValue ?? 1).toFixed(3)}
                            </TableCell>
                            <TableCell className="text-[10px] font-mono" style={{ color: (s.avgExpectancy ?? 0) > 0 ? NEON_GREEN : (s.avgExpectancy ?? 0) < 0 ? NEON_RED : "#666" }}>
                              {(s.avgExpectancy ?? 0).toFixed(2)}
                            </TableCell>
                            <TableCell className="text-[10px] font-mono text-white/60">
                              {(s.avgRiskReward ?? 0).toFixed(2)}
                            </TableCell>
                            <TableCell>
                              <Badge className="text-[10px] px-1.5 py-0 border" style={{ backgroundColor: `${edgeColor(s.edge)}15`, color: edgeColor(s.edge), borderColor: `${edgeColor(s.edge)}30` }}>
                                {edgeLabel(s.edge)}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-white/40 text-[10px]">{sampleLabel(s.sampleAdequacy)}</TableCell>
                          </TableRow>
                        )) : (
                          <TableRow><TableCell colSpan={12} className="text-center text-white/30 py-8 text-xs">Cargando...</TableCell></TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </ScrollArea>
                </CardContent>
              </Card>
            </motion.div>
          </TabsContent>

          {/* ─── TAB 4: PATRONES Y SESIONES ─────────────────────────────────── */}
          <TabsContent value="patrones">
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-4 mt-4">

              {/* Current Session Panel */}
              <Card className="bg-gradient-to-r from-[#111827] to-[#0d1220] border-white/10">
                <CardContent className="p-5">
                  {!currentSession ? (
                    <div className="flex items-center gap-4">
                      <div className="w-14 h-14 rounded-xl flex items-center justify-center bg-white/5">
                        <Clock className="size-6 text-white/30" />
                      </div>
                      <div>
                        <div className="text-lg font-bold text-white/30">Cargando...</div>
                        <div className="text-xs text-white/20">Detectando sesión actual</div>
                      </div>
                    </div>
                  ) : (
                  <div className="flex items-center gap-4 flex-wrap">
                    <div className="w-14 h-14 rounded-xl flex items-center justify-center" style={{ backgroundColor: `${SESSION_COLORS[currentSession.session]}20`, color: SESSION_COLORS[currentSession.session] }}>
                      {currentSession.icon}
                    </div>
                    <div className="flex-1 min-w-[200px]">
                      <div className="text-lg font-bold" style={{ color: SESSION_COLORS[currentSession.session] }}>
                        {currentSession.sessionEs}
                      </div>
                      <div className="text-xs text-white/40 mt-1">Sesión activa ahora</div>
                      <div className="flex gap-3 mt-2">
                        <Badge className="text-[10px]" style={{ backgroundColor: `${SESSION_COLORS[currentSession.session]}20`, color: SESSION_COLORS[currentSession.session], borderColor: `${SESSION_COLORS[currentSession.session]}40` }}>
                          <Flame className="size-3 mr-1" /> Volatilidad: {currentSession.session === "Overlap" ? "1.5x" : currentSession.session === "London" ? "1.2x" : currentSession.session === "NewYork" ? "1.0x" : currentSession.session === "Asia" ? "0.5x" : "0.3x"}
                        </Badge>
                        <Badge className="text-[10px]" style={{ backgroundColor: `${SESSION_COLORS[currentSession.session]}20`, color: SESSION_COLORS[currentSession.session], borderColor: `${SESSION_COLORS[currentSession.session]}40` }}>
                          Liquidez: {currentSession.session === "Overlap" || currentSession.session === "London" || currentSession.session === "NewYork" ? "ALTA" : "BAJA"}
                        </Badge>
                      </div>
                    </div>
                  </div>
                  )}
                </CardContent>
              </Card>

              {/* Session Timeline */}
              <Card className="bg-[#111827] border-white/10">
                <CardHeader><CardTitle className="text-white text-sm">Línea Temporal de Sesiones (24h UTC)</CardTitle></CardHeader>
                <CardContent>
                  <div className="relative">
                    <div className="flex h-8 rounded-lg overflow-hidden">
                      {[
                        { name: "Asia", start: 0, end: 7, color: SESSION_COLORS.Asia },
                        { name: "Londres", start: 7, end: 12, color: SESSION_COLORS.London },
                        { name: "Solape", start: 12, end: 16, color: SESSION_COLORS.Overlap },
                        { name: "NY", start: 16, end: 21, color: SESSION_COLORS.NewYork },
                        { name: "Off", start: 21, end: 24, color: SESSION_COLORS.OffHours },
                      ].map(s => (
                        <div key={s.name} className="flex items-center justify-center text-[9px] font-medium" style={{ width: `${((s.end - s.start) / 24) * 100}%`, backgroundColor: `${s.color}30`, color: s.color, borderRight: "1px solid rgba(255,255,255,0.1)" }}>
                          {s.name}
                        </div>
                      ))}
                    </div>
                    {/* Current time indicator */}
                    {mounted && (
                    <div className="absolute top-0 h-full flex items-end" style={{ left: `${((new Date().getUTCHours() * 60 + new Date().getUTCMinutes()) / 1440) * 100}%` }}>
                      <div className="w-0.5 h-8 bg-white/80 -translate-x-1/2" />
                      <div className="absolute -top-5 left-1/2 -translate-x-1/2 text-[8px] text-white/70 bg-white/10 px-1 rounded">
                        {new Date().getUTCHours().toString().padStart(2, "0")}:{new Date().getUTCMinutes().toString().padStart(2, "0")} UTC
                      </div>
                    </div>
                    )}
                    <div className="flex justify-between mt-1">
                      <span className="text-[8px] text-white/20">00:00</span>
                      <span className="text-[8px] text-white/20">06:00</span>
                      <span className="text-[8px] text-white/20">12:00</span>
                      <span className="text-[8px] text-white/20">18:00</span>
                      <span className="text-[8px] text-white/20">24:00</span>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Pattern Cards */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {PATTERN_TYPES.map((pattern) => {
                  const patternStats = stats?.winRateByPattern?.[pattern];
                  const setupData = setupScores?.summary.byPattern?.[pattern];
                  return (
                    <motion.div key={pattern} whileHover={{ scale: 1.02 }} transition={{ duration: 0.2 }}>
                      <Card className="bg-[#111827] border-white/10 hover:border-white/20 transition-colors">
                        <CardContent className="p-4">
                          <div className="flex items-center gap-2 mb-3">
                            <div className="w-8 h-8 rounded-lg bg-[#aa66ff]/15 flex items-center justify-center text-[#aa66ff]">
                              {PATTERN_ICONS[pattern]}
                            </div>
                            <div>
                              <div className="text-sm font-semibold text-white">{PATTERN_NAMES[pattern]}</div>
                              <div className="text-[9px] text-white/30">{pattern}</div>
                            </div>
                          </div>
                          <div className="space-y-2">
                            <div className="flex justify-between text-[10px]">
                              <span className="text-white/40">Win Rate</span>
                              <span className="font-mono" style={{ color: patternStats ? (patternStats.rate >= 60 ? NEON_GREEN : patternStats.rate >= 50 ? NEON_YELLOW : NEON_RED) : "#666" }}>
                                {patternStats ? `${patternStats.rate.toFixed(1)}%` : "Sin datos"}
                              </span>
                            </div>
                            <div className="flex justify-between text-[10px]">
                              <span className="text-white/40">Total Señales</span>
                              <span className="text-white font-mono">{patternStats?.total || 0}</span>
                            </div>
                            <div className="flex justify-between text-[10px]">
                              <span className="text-white/40">Edge</span>
                              <span style={{ color: edgeColor(setupData?.edge || "UNKNOWN") }}>
                                {edgeLabel(setupData?.edge || "UNKNOWN")}
                              </span>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    </motion.div>
                  );
                })}
              </div>

              {/* Session Win Rate Chart */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <Card className="bg-[#111827] border-white/10">
                  <CardHeader><CardTitle className="text-white text-sm">Win Rate por Patrón</CardTitle></CardHeader>
                  <CardContent>
                    {patternChartData.length > 0 ? (
                      <ResponsiveContainer width="100%" height={220}>
                        <BarChart data={patternChartData}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                          <XAxis dataKey="name" tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 9 }} />
                          <YAxis tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 9 }} domain={[0, 100]} />
                          <RechartsTooltip {...ChartTooltip()} />
                          <Bar dataKey="winRate" radius={[4, 4, 0, 0]}>
                            {patternChartData.map((entry, index) => (
                              <Cell key={`cell-${index}`} fill={entry.winRate >= 60 ? NEON_GREEN : entry.winRate >= 50 ? NEON_YELLOW : NEON_RED} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    ) : <div className="h-[220px] flex items-center justify-center text-white/30 text-sm">Sin datos suficientes</div>}
                  </CardContent>
                </Card>

                <Card className="bg-[#111827] border-white/10">
                  <CardHeader><CardTitle className="text-white text-sm">Win Rate por Sesión</CardTitle></CardHeader>
                  <CardContent>
                    {sessionChartData.length > 0 ? (
                      <ResponsiveContainer width="100%" height={220}>
                        <BarChart data={sessionChartData}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                          <XAxis dataKey="name" tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 9 }} />
                          <YAxis tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 9 }} domain={[0, 100]} />
                          <RechartsTooltip {...ChartTooltip()} />
                          <Bar dataKey="winRate" radius={[4, 4, 0, 0]}>
                            {sessionChartData.map((entry, index) => (
                              <Cell key={`cell-${index}`} fill={entry.winRate >= 60 ? NEON_GREEN : entry.winRate >= 50 ? NEON_YELLOW : NEON_RED} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    ) : <div className="h-[220px] flex items-center justify-center text-white/30 text-sm">Sin datos suficientes</div>}
                  </CardContent>
                </Card>
              </div>
            </motion.div>
          </TabsContent>

          {/* ─── TAB 5: AUTO-TRADER ────────────────────────────────────────── */}
          <TabsContent value="auto-trader">
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-4 mt-4">

              {/* EL DATASET ES EL ACTIVO banner */}
              <Card className="bg-gradient-to-r from-[#111827] to-[#0d1220] border-[#00ff88]/20">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between flex-wrap gap-3">
                    <div className="flex items-center gap-3">
                      <Database className="size-8 text-[#00ff88]" />
                      <div>
                        <div className="text-sm font-bold text-[#00ff88]">EL DATASET ES EL ACTIVO MÁS VALIOSO</div>
                        <div className="text-xs text-white/40">{totalDecisive} señales decisivas recolectadas de {datasetGoal} objetivo</div>
                      </div>
                    </div>
                    <div className="w-32">
                      <Progress value={datasetProgress} className="h-2" />
                      <div className="text-[10px] text-[#00ff88] mt-1 text-right font-mono">{datasetProgress.toFixed(0)}%</div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Big ON/OFF Switch */}
              <Card className="bg-[#111827] border-white/10">
                <CardContent className="p-6">
                  <div className="flex items-center justify-center gap-6 flex-wrap">
                    <div className="text-center">
                      <motion.div whileTap={{ scale: 0.9 }}>
                        <Button
                          onClick={() => handleToggleAutoTrader(!autoTraderState?.isRunning)}
                          disabled={loading.autoTrader}
                          className={`w-32 h-32 rounded-full text-lg font-bold border-4 transition-all ${
                            autoTraderState?.isRunning
                              ? "bg-[#00ff88]/10 border-[#00ff88] text-[#00ff88] hover:bg-[#00ff88]/20"
                              : "bg-[#ff3366]/5 border-[#ff3366]/40 text-[#ff3366] hover:bg-[#ff3366]/10"
                          }`}
                        >
                          {loading.autoTrader ? <Loader2 className="size-8 animate-spin" /> :
                            autoTraderState?.isRunning ? <><Square className="size-8 mb-1" /><span className="block text-xs">STOP</span></> : <><Play className="size-8 mb-1" /><span className="block text-xs">START</span></>
                          }
                        </Button>
                      </motion.div>
                      <div className="mt-2 text-xs text-white/40">
                        {autoTraderState?.isRunning ? "Auto-Trader Activo" : "Auto-Trader Inactivo"}
                      </div>
                    </div>
                    <div className="flex flex-col gap-2 text-sm">
                      <div className="flex items-center gap-2">
                        {autoTraderState?.isRunning ? <Wifi className="size-4 text-[#00ff88]" /> : <WifiOff className="size-4 text-white/30" />}
                        <span className={autoTraderState?.isRunning ? "text-[#00ff88]" : "text-white/30"}>
                          {autoTraderState?.isRunning ? "Conectado y ejecutando" : "Desconectado"}
                        </span>
                      </div>
                      <div className="text-xs text-white/40">
                        Último check: {autoTraderState?.lastCheck ? formatTime(autoTraderState.lastCheck) : "Nunca"}
                      </div>
                      <div className="text-xs text-white/40">
                        Ciclos completados: {autoTraderState?.cyclesCompleted || 0}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Configuration Form */}
              <Card className="bg-[#111827] border-white/10">
                <CardHeader><CardTitle className="text-white text-sm flex items-center gap-2"><Settings className="size-4" /> Configuración</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                  {/* Assets */}
                  <div>
                    <Label className="text-white/60 text-xs mb-2 block">Activos</Label>
                    <div className="flex flex-wrap gap-2">
                      {ASSETS.map(asset => (
                        <label key={asset} className="flex items-center gap-1.5 text-xs cursor-pointer">
                          <Checkbox
                            checked={selectedAssets.includes(asset)}
                            onCheckedChange={(checked) => {
                              setSelectedAssets(prev =>
                                checked ? [...prev, asset] : prev.filter(a => a !== asset)
                              );
                            }}
                          />
                          <span className="text-white/70">{asset}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                    {/* Timeframe */}
                    <div>
                      <Label className="text-white/60 text-xs mb-1 block">Temporalidad</Label>
                      <Select value={autoTraderConfig.timeframe} onValueChange={(v) => setAutoTraderConfig(p => ({ ...p, timeframe: v }))}>
                        <SelectTrigger className="bg-[#0a0e17] border-white/10 text-white text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-[#111827] border-white/10">
                          {TIMEFRAMES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Interval */}
                    <div>
                      <Label className="text-white/60 text-xs mb-1 block">Intervalo (min)</Label>
                      <Select value={autoTraderConfig.intervalMinutes.toString()} onValueChange={(v) => setAutoTraderConfig(p => ({ ...p, intervalMinutes: parseInt(v) }))}>
                        <SelectTrigger className="bg-[#0a0e17] border-white/10 text-white text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-[#111827] border-white/10">
                          <SelectItem value="1">1 min</SelectItem>
                          <SelectItem value="5">5 min</SelectItem>
                          <SelectItem value="15">15 min</SelectItem>
                          <SelectItem value="30">30 min</SelectItem>
                          <SelectItem value="60">1 hora</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Max Concurrent */}
                    <div>
                      <Label className="text-white/60 text-xs mb-1 block">Máx. Señales Concurrentes</Label>
                      <Input
                        type="number"
                        value={autoTraderConfig.maxConcurrentSignals}
                        onChange={(e) => setAutoTraderConfig(p => ({ ...p, maxConcurrentSignals: parseInt(e.target.value) || 5 }))}
                        className="bg-[#0a0e17] border-white/10 text-white text-xs"
                      />
                    </div>

                    {/* Min Setup Score */}
                    <div>
                      <Label className="text-white/60 text-xs mb-1 block">Setup Score Mínimo: {autoTraderConfig.minSetupScore}</Label>
                      <Slider
                        value={[autoTraderConfig.minSetupScore]}
                        onValueChange={([v]) => setAutoTraderConfig(p => ({ ...p, minSetupScore: v }))}
                        min={0} max={100} step={5}
                        className="mt-2"
                      />
                    </div>
                  </div>

                  <Button onClick={handleUpdateConfig} variant="outline" className="border-white/20 text-white/70 hover:text-white hover:bg-white/10 text-xs">
                    Guardar Configuración
                  </Button>
                </CardContent>
              </Card>

              {/* Run History / Live Feed */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Live Feed */}
                <Card className="bg-[#111827] border-white/10">
                  <CardHeader><CardTitle className="text-white text-sm flex items-center gap-2"><Activity className="size-4 text-[#00ff88]" /> Feed en Vivo</CardTitle></CardHeader>
                  <CardContent>
                    <ScrollArea className="h-64">
                      {liveFeed.length > 0 ? (
                        <div className="space-y-1">
                          {liveFeed.map((entry, i) => (
                            <div key={i} className="flex items-start gap-2 p-1.5 rounded bg-white/5">
                              <span className="text-[9px] text-white/30 font-mono whitespace-nowrap">{entry.time}</span>
                              <span className={`text-[10px] ${entry.type === "success" ? "text-[#00ff88]" : entry.type === "error" ? "text-[#ff3366]" : "text-[#ffaa00]"}`}>
                                {entry.message}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-white/30 text-xs text-center py-8">Sin actividad. Inicia el Auto-Trader o ejecuta un ciclo.</p>
                      )}
                    </ScrollArea>
                  </CardContent>
                </Card>

                {/* Recent Auto Signals */}
                <Card className="bg-[#111827] border-white/10">
                  <CardHeader><CardTitle className="text-white text-sm flex items-center gap-2"><Bot className="size-4 text-[#aa66ff]" /> Señales Recientes Auto</CardTitle></CardHeader>
                  <CardContent>
                    <ScrollArea className="h-64">
                      {autoTraderState?.recentSignals && autoTraderState.recentSignals.length > 0 ? (
                        <div className="space-y-1.5">
                          {autoTraderState.recentSignals.slice(0, 10).map((s) => (
                            <div key={s.id} className="flex items-center justify-between p-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors">
                              <div className="flex items-center gap-2">
                                {directionIcon(s.direction)}
                                <span className="text-[10px] font-medium text-white">{s.asset}</span>
                                <PatternBadge pattern={s.pattern} />
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-[9px] text-white/40">Conf: {s.confidence.toFixed(0)}%</span>
                                <SetupScoreBar score={s.setupScore} />
                                <Badge className={`${s.direction === "NO_OPERAR" ? "bg-[#00aaff]/15 text-[#00aaff] border-[#00aaff]/30" : s.status === "PENDING" ? "bg-[#ffaa00]/15 text-[#ffaa00] border-[#ffaa00]/30" : "bg-[#00aaff]/15 text-[#00aaff] border-[#00aaff]/30"} text-[9px] px-1 py-0`}>
                                  {s.direction === "NO_OPERAR" ? "SKIP" : s.status}
                                </Badge>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-white/30 text-xs text-center py-8">No hay señales auto generadas aún.</p>
                      )}
                    </ScrollArea>
                  </CardContent>
                </Card>
              </div>
            </motion.div>
          </TabsContent>

          {/* ─── TAB 6: BACKTESTING ────────────────────────────────────────── */}
          <TabsContent value="backtesting">
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-4 mt-4">

              {!insights && !loading.backtesting && (
                <Card className="bg-[#111827] border-white/10">
                  <CardContent className="p-6 text-center">
                    <Brain className="size-12 text-white/20 mx-auto mb-3" />
                    <p className="text-white/40 text-sm mb-3">Carga los datos de backtesting para ver insights</p>
                    <Button onClick={fetchInsights} variant="outline" className="border-white/20 text-white/70 hover:text-white hover:bg-white/10">
                      <Brain className="size-4 mr-2" /> Cargar Backtesting
                    </Button>
                  </CardContent>
                </Card>
              )}

              {loading.backtesting && (
                <Card className="bg-[#111827] border-white/10">
                  <CardContent className="p-6 text-center">
                    <Loader2 className="size-8 text-[#00aaff] mx-auto animate-spin" />
                    <p className="text-white/40 text-sm mt-3">Analizando señales...</p>
                  </CardContent>
                </Card>
              )}

              {insights && (
                <>
                  {/* Summary */}
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                    <StatCard title="Total Analizadas" value={insights.summary.totalSignals} icon={<Activity className="size-4" />} color={NEON_BLUE} />
                    <StatCard title="Win Rate Global" value={`${insights.summary.overallWinRate.toFixed(1)}%`} icon={<Target className="size-4" />} color={insights.summary.overallWinRate >= 60 ? NEON_GREEN : NEON_RED} />
                    <StatCard title="Profit Factor" value={insights.summary.profitFactor === -1 ? "∞" : insights.summary.profitFactor.toFixed(2)} icon={<TrendingUp className="size-4" />} color={insights.summary.profitFactor >= 1.5 ? NEON_GREEN : NEON_YELLOW} />
                    <StatCard title="Conf. Recomendada" value={`≥${insights.summary.recommendedConfidenceThreshold}%`} icon={<Gauge className="size-4" />} color={NEON_CYAN} />
                    <StatCard title="Mejor WR Filtrado" value={`${insights.summary.bestThresholdWinRate.toFixed(1)}%`} icon={<CheckCircle className="size-4" />} color={NEON_GREEN} />
                  </div>

                  {/* Statistical significance warning */}
                  {totalDecisive < 100 && (
                    <Card className="bg-[#ffaa00]/5 border-[#ffaa00]/20">
                      <CardContent className="p-3">
                        <div className="flex items-center gap-2">
                          <AlertTriangle className="size-4 text-[#ffaa00]" />
                          <span className="text-xs text-[#ffaa00]">Significancia estadística baja ({totalDecisive} señales). Necesitas mínimo 100 para conclusiones confiables. Los resultados pueden ser ruido.</span>
                        </div>
                      </CardContent>
                    </Card>
                  )}

                  {/* Confidence Analysis */}
                  <Card className="bg-[#111827] border-white/10">
                    <CardHeader><CardTitle className="text-white text-sm">Análisis por Nivel de Confianza</CardTitle></CardHeader>
                    <CardContent>
                      {confidenceChartData.length > 0 ? (
                        <ResponsiveContainer width="100%" height={220}>
                          <BarChart data={confidenceChartData}>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                            <XAxis dataKey="range" tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 10 }} />
                            <YAxis tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 10 }} domain={[0, 100]} />
                            <RechartsTooltip {...ChartTooltip()} />
                            <Bar dataKey="winRate" radius={[4, 4, 0, 0]}>
                              {confidenceChartData.map((entry, index) => (
                                <Cell key={`cell-${index}`} fill={entry.winRate >= 60 ? NEON_GREEN : entry.winRate >= 50 ? NEON_YELLOW : NEON_RED} />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      ) : <div className="h-[220px] flex items-center justify-center text-white/30 text-sm">Sin datos</div>}
                    </CardContent>
                  </Card>

                  {/* Asset & Timeframe Performance */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <Card className="bg-[#111827] border-white/10">
                      <CardHeader><CardTitle className="text-white text-sm">Rendimiento por Activo</CardTitle></CardHeader>
                      <CardContent>
                        <ScrollArea className="h-48">
                          <Table>
                            <TableHeader>
                              <TableRow className="border-white/10 hover:bg-transparent">
                                <TableHead className="text-white/50 text-[10px]">Activo</TableHead>
                                <TableHead className="text-white/50 text-[10px]">WR</TableHead>
                                <TableHead className="text-white/50 text-[10px]">Total</TableHead>
                                <TableHead className="text-white/50 text-[10px]">Recom.</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {insights.assetPerformance.map((a) => (
                                <TableRow key={a.asset} className="border-white/5 hover:bg-white/5">
                                  <TableCell className="text-white text-[10px] font-medium">{a.asset}</TableCell>
                                  <TableCell className="text-[10px] font-mono" style={{ color: a.winRate >= 60 ? NEON_GREEN : a.winRate >= 50 ? NEON_YELLOW : NEON_RED }}>{a.winRate.toFixed(1)}%</TableCell>
                                  <TableCell className="text-white/50 text-[10px]">{a.total}</TableCell>
                                  <TableCell>
                                    <Badge className={`${a.recommendation === "OPERAR" ? "bg-[#00ff88]/15 text-[#00ff88] border-[#00ff88]/30" : a.recommendation === "EVITAR" ? "bg-[#ff3366]/15 text-[#ff3366] border-[#ff3366]/30" : "bg-[#ffaa00]/15 text-[#ffaa00] border-[#ffaa00]/30"} text-[9px] px-1.5 py-0 border`}>
                                      {a.recommendation}
                                    </Badge>
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </ScrollArea>
                      </CardContent>
                    </Card>

                    <Card className="bg-[#111827] border-white/10">
                      <CardHeader><CardTitle className="text-white text-sm">Rendimiento por Temporalidad</CardTitle></CardHeader>
                      <CardContent>
                        <ScrollArea className="h-48">
                          <Table>
                            <TableHeader>
                              <TableRow className="border-white/10 hover:bg-transparent">
                                <TableHead className="text-white/50 text-[10px]">TF</TableHead>
                                <TableHead className="text-white/50 text-[10px]">WR</TableHead>
                                <TableHead className="text-white/50 text-[10px]">Total</TableHead>
                                <TableHead className="text-white/50 text-[10px]">Recom.</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {insights.timeframePerformance.map((t) => (
                                <TableRow key={t.timeframe} className="border-white/5 hover:bg-white/5">
                                  <TableCell className="text-white text-[10px] font-medium">{t.timeframe}</TableCell>
                                  <TableCell className="text-[10px] font-mono" style={{ color: t.winRate >= 60 ? NEON_GREEN : t.winRate >= 50 ? NEON_YELLOW : NEON_RED }}>{t.winRate.toFixed(1)}%</TableCell>
                                  <TableCell className="text-white/50 text-[10px]">{t.total}</TableCell>
                                  <TableCell>
                                    <Badge className={`${t.recommendation === "OPERAR" ? "bg-[#00ff88]/15 text-[#00ff88] border-[#00ff88]/30" : t.recommendation === "EVITAR" ? "bg-[#ff3366]/15 text-[#ff3366] border-[#ff3366]/30" : "bg-[#ffaa00]/15 text-[#ffaa00] border-[#ffaa00]/30"} text-[9px] px-1.5 py-0 border`}>
                                      {t.recommendation}
                                    </Badge>
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </ScrollArea>
                      </CardContent>
                    </Card>
                  </div>

                  {/* Warnings */}
                  {insights.warnings.length > 0 && (
                    <Card className="bg-[#111827] border-white/10">
                      <CardHeader><CardTitle className="text-white text-sm flex items-center gap-2"><AlertTriangle className="size-4 text-[#ffaa00]" /> Advertencias</CardTitle></CardHeader>
                      <CardContent>
                        <div className="space-y-2">
                          {insights.warnings.map((w, i) => (
                            <div key={i} className="flex items-start gap-2 p-2 rounded-lg bg-[#ffaa00]/5">
                              <AlertTriangle className="size-3 text-[#ffaa00] mt-0.5 shrink-0" />
                              <span className="text-xs text-white/60">{w}</span>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  )}

                  {/* Recommended Filters */}
                  <Card className="bg-[#111827] border-white/10">
                    <CardHeader><CardTitle className="text-white text-sm flex items-center gap-2"><Shield className="size-4 text-[#00aaff]" /> Filtros Recomendados</CardTitle></CardHeader>
                    <CardContent>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                        {insights.recommendedFilters.goodAssets.length > 0 && (
                          <div className="p-3 rounded-lg bg-[#00ff88]/5 border border-[#00ff88]/10">
                            <div className="text-[10px] text-[#00ff88] font-semibold mb-1">BUENOS ACTIVOS</div>
                            <div className="text-xs text-white/60">{insights.recommendedFilters.goodAssets.join(", ")}</div>
                          </div>
                        )}
                        {insights.recommendedFilters.badAssets.length > 0 && (
                          <div className="p-3 rounded-lg bg-[#ff3366]/5 border border-[#ff3366]/10">
                            <div className="text-[10px] text-[#ff3366] font-semibold mb-1">EVITAR ACTIVOS</div>
                            <div className="text-xs text-white/60">{insights.recommendedFilters.badAssets.join(", ")}</div>
                          </div>
                        )}
                        <div className="p-3 rounded-lg bg-[#00aaff]/5 border border-[#00aaff]/10">
                          <div className="text-[10px] text-[#00aaff] font-semibold mb-1">CONFIANZA MÍNIMA</div>
                          <div className="text-xs text-white/60">≥ {insights.recommendedFilters.minimumConfidence}%</div>
                        </div>
                        {insights.recommendedFilters.goodHours.length > 0 && (
                          <div className="p-3 rounded-lg bg-[#00ff88]/5 border border-[#00ff88]/10">
                            <div className="text-[10px] text-[#00ff88] font-semibold mb-1">BUENAS HORAS</div>
                            <div className="text-xs text-white/60">{insights.recommendedFilters.goodHours.join(", ")}</div>
                          </div>
                        )}
                        {insights.recommendedFilters.badHours.length > 0 && (
                          <div className="p-3 rounded-lg bg-[#ff3366]/5 border border-[#ff3366]/10">
                            <div className="text-[10px] text-[#ff3366] font-semibold mb-1">MALAS HORAS</div>
                            <div className="text-xs text-white/60">{insights.recommendedFilters.badHours.join(", ")}</div>
                          </div>
                        )}
                        {insights.recommendedFilters.avoidConsecutiveLosses && (
                          <div className="p-3 rounded-lg bg-[#ffaa00]/5 border border-[#ffaa00]/10">
                            <div className="text-[10px] text-[#ffaa00] font-semibold mb-1">PRECAUCIÓN</div>
                            <div className="text-xs text-white/60">Racha de pérdidas activa. Considera pausar.</div>
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </>
              )}
            </motion.div>
          </TabsContent>

          {/* ─── TAB 7: ALERTAS ────────────────────────────────────────────── */}
          <TabsContent value="alertas">
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-4 mt-4">
              {alerts.length > 0 ? (
                <Card className="bg-[#111827] border-white/10">
                  <CardHeader>
                    <CardTitle className="text-white text-sm flex items-center gap-2">
                      <AlertTriangle className="size-4 text-[#ffaa00]" /> Alertas Activas ({alerts.length})
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      {alerts.map((alert) => (
                        <div key={alert.id} className={`flex items-center justify-between p-3 rounded-lg border ${severityColor(alert.severity)}`}>
                          <div className="flex items-center gap-2">
                            {alert.severity === "critical" ? <XCircle className="size-4" /> : <AlertTriangle className="size-4" />}
                            <div>
                              <span className="text-sm">{alert.message}</span>
                              <div className="text-[9px] opacity-60 mt-0.5">{formatTime(alert.createdAt)}</div>
                            </div>
                          </div>
                          <Button variant="ghost" size="sm" onClick={() => handleDismissAlert(alert.id)} className="text-white/50 hover:text-white hover:bg-white/10 h-7 text-xs">
                            Descartar
                          </Button>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ) : (
                <Card className="bg-[#111827] border-white/10">
                  <CardContent className="p-8 text-center">
                    <CheckCircle className="size-12 text-[#00ff88]/30 mx-auto mb-3" />
                    <p className="text-white/40 text-sm">No hay alertas activas</p>
                    <p className="text-white/20 text-xs mt-1">Las alertas se generan automáticamente cuando se detectan condiciones de riesgo</p>
                  </CardContent>
                </Card>
              )}
            </motion.div>
          </TabsContent>

          {/* ─── TAB 8: LEARNING ENGINE ──────────────────────────────────────── */}
          <TabsContent value="learning">
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-4 mt-4">

              {/* Learning Engine Header */}
              <Card className="bg-gradient-to-r from-[#111827] to-[#0d1220] border-[#aa66ff]/20">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between flex-wrap gap-3">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-[#aa66ff]/15 flex items-center justify-center">
                        <Brain className="size-5 text-[#aa66ff]" />
                      </div>
                      <div>
                        <div className="text-sm font-bold text-[#aa66ff]">MOTOR DE APRENDIZAJE</div>
                        <div className="text-xs text-white/40">Descubre qué setups funcionan y cuándo</div>
                      </div>
                    </div>
                    <Button variant="outline" size="sm" onClick={fetchLearningReport} className="border-[#aa66ff]/30 text-[#aa66ff] hover:text-white hover:bg-[#aa66ff]/10 text-xs">
                      <RefreshCw className="size-3 mr-1" /> Actualizar Análisis
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {!learningReport ? (
                <Card className="bg-[#111827] border-white/10">
                  <CardContent className="p-8 text-center">
                    <Brain className="size-12 text-[#aa66ff]/20 mx-auto mb-3" />
                    <p className="text-white/40 text-sm mb-3">Carga el análisis de aprendizaje para descubrir edges</p>
                    <Button onClick={fetchLearningReport} variant="outline" className="border-[#aa66ff]/30 text-[#aa66ff] hover:text-white hover:bg-[#aa66ff]/10">
                      <Brain className="size-4 mr-2" /> Analizar Dataset
                    </Button>
                  </CardContent>
                </Card>
              ) : (
                <>
                  {/* Dataset Health */}
                  <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
                    <StatCard title="Total Datos" value={learningReport.totalDataPoints || 0} icon={<Database className="size-4" />} color={NEON_BLUE} />
                    <StatCard title="Decisivas" value={learningReport.totalDecisive || 0} icon={<Target className="size-4" />} color={NEON_CYAN} />
                    <StatCard title="Win Rate Global" value={`${learningReport.overallWinRate?.toFixed(1) || 0}%`} icon={<Activity className="size-4" />} color={learningReport.overallWinRate >= 55 ? NEON_GREEN : NEON_RED} />
                    <StatCard title="Calidad Datos" value={learningReport.dataQuality || "INSUFFICIENT"} icon={<Gauge className="size-4" />} color={learningReport.dataQuality === "GOOD" || learningReport.dataQuality === "EXCELLENT" ? NEON_GREEN : learningReport.dataQuality === "ACCEPTABLE" ? NEON_YELLOW : NEON_RED} />
                    <StatCard title="Edge Detectado" value={learningReport.hasAnyEdge ? "SÍ" : "NO"} icon={<Zap className="size-4" />} color={learningReport.hasAnyEdge ? NEON_GREEN : NEON_RED} />
                    <StatCard title="Faltan para 1000" value={learningReport.datasetHealth?.neededForExcellent || 0} icon={<Timer className="size-4" />} color={NEON_YELLOW} />
                  </div>

                  {/* Next Milestone */}
                  <Card className="bg-[#111827] border-white/10">
                    <CardContent className="p-4">
                      <div className="flex items-center gap-3">
                        <Timer className="size-5 text-[#ffaa00]" />
                        <div>
                          <div className="text-xs text-white/40">Próximo hito</div>
                          <div className="text-sm text-white/70">{learningReport.nextMilestone}</div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  {/* Warnings */}
                  {learningReport.warnings && learningReport.warnings.length > 0 && (
                    <Card className="bg-[#ff3366]/5 border-[#ff3366]/20">
                      <CardContent className="p-4 space-y-2">
                        {learningReport.warnings.map((w: string, i: number) => (
                          <div key={i} className="flex items-start gap-2">
                            <AlertTriangle className="size-4 text-[#ff3366] mt-0.5 shrink-0" />
                            <span className="text-xs text-[#ff3366]/80">{w}</span>
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  )}

                  {/* Recommendations */}
                  {learningReport.recommendations && learningReport.recommendations.length > 0 && (
                    <Card className="bg-[#00ff88]/5 border-[#00ff88]/20">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-white text-sm flex items-center gap-2">
                          <CheckCircle className="size-4 text-[#00ff88]" /> Recomendaciones
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        {learningReport.recommendations.map((r: string, i: number) => (
                          <div key={i} className="flex items-start gap-2">
                            <CheckCircle className="size-3 text-[#00ff88] mt-0.5 shrink-0" />
                            <span className="text-xs text-[#00ff88]/80">{r}</span>
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  )}

                  {/* Edge Discoveries Table */}
                  {learningReport.discoveries && learningReport.discoveries.length > 0 && (
                    <Card className="bg-[#111827] border-white/10">
                      <CardHeader>
                        <CardTitle className="text-white text-sm flex items-center gap-2">
                          <Sparkles className="size-4 text-[#aa66ff]" /> Descubrimientos de Edge
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <ScrollArea className="w-full">
                          <Table>
                            <TableHeader>
                              <TableRow className="border-white/10 hover:bg-transparent">
                                <TableHead className="text-white/50 text-[10px]">Patrón</TableHead>
                                <TableHead className="text-white/50 text-[10px]">Sesión</TableHead>
                                <TableHead className="text-white/50 text-[10px]">Activo</TableHead>
                                <TableHead className="text-white/50 text-[10px]">Total</TableHead>
                                <TableHead className="text-white/50 text-[10px]">Win Rate</TableHead>
                                <TableHead className="text-white/50 text-[10px]">Edge</TableHead>
                                <TableHead className="text-white/50 text-[10px]">Magnitud</TableHead>
                                <TableHead className="text-white/50 text-[10px]">p-valor</TableHead>
                                <TableHead className="text-white/50 text-[10px]">Signif.</TableHead>
                                <TableHead className="text-white/50 text-[10px]">Régimen</TableHead>
                                <TableHead className="text-white/50 text-[10px]">Recom.</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {learningReport.discoveries.map((d: any, i: number) => (
                                <TableRow key={i} className="border-white/5 hover:bg-white/5">
                                  <TableCell><PatternBadge pattern={d.patternType} /></TableCell>
                                  <TableCell><SessionBadge session={d.session} /></TableCell>
                                  <TableCell className="text-white/70 text-[10px]">{d.asset || "Todos"}</TableCell>
                                  <TableCell className="text-white text-[10px]">{d.totalSignals}</TableCell>
                                  <TableCell className="text-[10px] font-mono" style={{ color: d.winRate >= 55 ? NEON_GREEN : d.winRate >= 50 ? NEON_YELLOW : NEON_RED }}>
                                    {d.winRate.toFixed(1)}%
                                  </TableCell>
                                  <TableCell>
                                    <Badge className="text-[10px] px-1.5 py-0 border" style={{ backgroundColor: `${edgeColor(d.edge)}15`, color: edgeColor(d.edge), borderColor: `${edgeColor(d.edge)}30` }}>
                                      {edgeLabel(d.edge)}
                                    </Badge>
                                  </TableCell>
                                  <TableCell className="text-[10px] font-mono" style={{ color: d.edgeMagnitude > 10 ? NEON_GREEN : d.edgeMagnitude > 5 ? NEON_YELLOW : "#666" }}>
                                    {d.edgeMagnitude.toFixed(1)}
                                  </TableCell>
                                  <TableCell className="text-[10px] font-mono text-white/50">
                                    {d.pValue.toFixed(3)}
                                  </TableCell>
                                  <TableCell>
                                    {d.isSignificant ? (
                                      <CheckCircle className="size-3 text-[#00ff88]" />
                                    ) : (
                                      <XCircle className="size-3 text-white/20" />
                                    )}
                                  </TableCell>
                                  <TableCell>
                                    <div className="flex items-center gap-1">
                                      <span className={`text-[9px] ${d.regimeDirection === 'IMPROVING' ? 'text-[#00ff88]' : d.regimeDirection === 'DECLINING' ? 'text-[#ff3366]' : 'text-white/30'}`}>
                                        {d.regimeDirection === 'IMPROVING' ? '↑' : d.regimeDirection === 'DECLINING' ? '↓' : '→'}
                                      </span>
                                      {d.regimeChange && <AlertTriangle className="size-3 text-[#ffaa00]" />}
                                    </div>
                                  </TableCell>
                                  <TableCell className="text-[9px] max-w-[120px] truncate" title={d.recommendation}>
                                    <span style={{ color: d.edge === 'POSITIVE' ? NEON_GREEN : d.edge === 'NEGATIVE' ? NEON_RED : '#666' }}>
                                      {d.recommendation.split(':')[0]}
                                    </span>
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </ScrollArea>
                      </CardContent>
                    </Card>
                  )}

                  {/* Best/Worst Setup Highlight */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {learningReport.bestSetup && (
                      <Card className="bg-[#00ff88]/5 border-[#00ff88]/20">
                        <CardHeader className="pb-2">
                          <CardTitle className="text-[#00ff88] text-sm flex items-center gap-2">
                            <TrendingUp className="size-4" /> Mejor Setup
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <PatternBadge pattern={learningReport.bestSetup.patternType} />
                              <SessionBadge session={learningReport.bestSetup.session} />
                            </div>
                            <div className="grid grid-cols-3 gap-2 text-[10px]">
                              <div>
                                <span className="text-white/40">Win Rate</span>
                                <div className="font-mono text-[#00ff88]">{learningReport.bestSetup.winRate.toFixed(1)}%</div>
                              </div>
                              <div>
                                <span className="text-white/40">Muestras</span>
                                <div className="font-mono text-white">{learningReport.bestSetup.totalSignals}</div>
                              </div>
                              <div>
                                <span className="text-white/40">p-valor</span>
                                <div className="font-mono text-white">{learningReport.bestSetup.pValue.toFixed(3)}</div>
                              </div>
                            </div>
                            <p className="text-[10px] text-[#00ff88]/60 italic">{learningReport.bestSetup.recommendation}</p>
                          </div>
                        </CardContent>
                      </Card>
                    )}

                    {learningReport.worstSetup && (
                      <Card className="bg-[#ff3366]/5 border-[#ff3366]/20">
                        <CardHeader className="pb-2">
                          <CardTitle className="text-[#ff3366] text-sm flex items-center gap-2">
                            <TrendingDown className="size-4" /> Peor Setup
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <PatternBadge pattern={learningReport.worstSetup.patternType} />
                              <SessionBadge session={learningReport.worstSetup.session} />
                            </div>
                            <div className="grid grid-cols-3 gap-2 text-[10px]">
                              <div>
                                <span className="text-white/40">Win Rate</span>
                                <div className="font-mono text-[#ff3366]">{learningReport.worstSetup.winRate.toFixed(1)}%</div>
                              </div>
                              <div>
                                <span className="text-white/40">Muestras</span>
                                <div className="font-mono text-white">{learningReport.worstSetup.totalSignals}</div>
                              </div>
                              <div>
                                <span className="text-white/40">p-valor</span>
                                <div className="font-mono text-white">{learningReport.worstSetup.pValue.toFixed(3)}</div>
                              </div>
                            </div>
                            <p className="text-[10px] text-[#ff3366]/60 italic">{learningReport.worstSetup.recommendation}</p>
                          </div>
                        </CardContent>
                      </Card>
                    )}
                  </div>
                </>
              )}
            </motion.div>
          </TabsContent>

        </Tabs>
      </main>

      {/* Footer */}
      <footer className="border-t border-white/5 mt-8">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="text-[10px] text-white/20">SignalTrader Pro v3.0 — Motor Estadístico Real</div>
          <div className="flex items-center gap-3 text-[10px] text-white/20">
            <span>Confiabilidad: <span style={{ color: reliabilityConfig_.color }}>{reliabilityConfig_.label}</span></span>
            <span>Dataset: {totalDecisive}/{datasetGoal}</span>
            {autoTraderState?.isRunning && <span className="text-[#00ff88]">● AUTO ON</span>}
          </div>
        </div>
      </footer>
    </div>
  );
}

// Missing icon fix - Settings is not in our imports, use a substitute
function Settings({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  );
}
