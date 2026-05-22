// Signal evaluation and statistics logic

export interface SignalRecord {
  id: string;
  asset: string;
  timeframe: string;
  direction: string;
  entryPrice: number;
  entryTime: Date;
  expirationMinutes: number;
  expirationTime: Date;
  confidence: number;
  aiReason: string | null;
  exitPrice: number | null;
  result: string | null;
  priceDifference: number | null;
  estimatedProfit: number | null;
  estimatedLoss: number | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface StatsResult {
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

export function evaluateSignal(
  direction: string,
  entryPrice: number,
  exitPrice: number
): string {
  if (direction === "NO_OPERAR") return "NO_OPERAR";
  if (direction === "HIGHER") {
    if (exitPrice > entryPrice) return "WIN";
    if (exitPrice < entryPrice) return "LOSS";
    return "DRAW";
  }
  if (direction === "LOWER") {
    if (exitPrice < entryPrice) return "WIN";
    if (exitPrice > entryPrice) return "LOSS";
    return "DRAW";
  }
  return "DRAW";
}

export function calculateStats(signals: SignalRecord[]): StatsResult {
  const closedSignals = signals.filter(
    (s) => s.status === "CLOSED" && s.result
  );

  const winCount = closedSignals.filter((s) => s.result === "WIN").length;
  const lossCount = closedSignals.filter((s) => s.result === "LOSS").length;
  const drawCount = closedSignals.filter((s) => s.result === "DRAW").length;
  const noOperarCount = closedSignals.filter((s) => s.result === "NO_OPERAR").length;
  const pendingCount = signals.filter((s) => s.status === "PENDING").length;
  const totalClosed = winCount + lossCount + drawCount;
  const winRate = totalClosed > 0 ? (winCount / totalClosed) * 100 : 0;

  const averageConfidence =
    signals.length > 0
      ? signals.reduce((sum, s) => sum + s.confidence, 0) / signals.length
      : 0;

  const totalEstimatedProfit = closedSignals
    .filter((s) => s.estimatedProfit)
    .reduce((sum, s) => sum + (s.estimatedProfit || 0), 0);

  const totalEstimatedLoss = closedSignals
    .filter((s) => s.estimatedLoss)
    .reduce((sum, s) => sum + Math.abs(s.estimatedLoss || 0), 0);

  const profitFactor =
    totalEstimatedLoss > 0 ? totalEstimatedProfit / totalEstimatedLoss : totalEstimatedProfit > 0 ? Infinity : 0;

  const netResult = totalEstimatedProfit - totalEstimatedLoss;

  // Win rate by asset
  const assetGroups: Record<string, { wins: number; total: number }> = {};
  closedSignals.forEach((s) => {
    if (!assetGroups[s.asset]) assetGroups[s.asset] = { wins: 0, total: 0 };
    assetGroups[s.asset].total++;
    if (s.result === "WIN") assetGroups[s.asset].wins++;
  });
  const winRateByAsset: StatsResult["winRateByAsset"] = {};
  Object.entries(assetGroups).forEach(([asset, data]) => {
    winRateByAsset[asset] = { ...data, rate: data.total > 0 ? (data.wins / data.total) * 100 : 0 };
  });

  // Win rate by timeframe
  const tfGroups: Record<string, { wins: number; total: number }> = {};
  closedSignals.forEach((s) => {
    if (!tfGroups[s.timeframe]) tfGroups[s.timeframe] = { wins: 0, total: 0 };
    tfGroups[s.timeframe].total++;
    if (s.result === "WIN") tfGroups[s.timeframe].wins++;
  });
  const winRateByTimeframe: StatsResult["winRateByTimeframe"] = {};
  Object.entries(tfGroups).forEach(([tf, data]) => {
    winRateByTimeframe[tf] = { ...data, rate: data.total > 0 ? (data.wins / data.total) * 100 : 0 };
  });

  // Win rate by direction
  const dirGroups: Record<string, { wins: number; total: number }> = {};
  closedSignals.forEach((s) => {
    if (!dirGroups[s.direction]) dirGroups[s.direction] = { wins: 0, total: 0 };
    dirGroups[s.direction].total++;
    if (s.result === "WIN") dirGroups[s.direction].wins++;
  });
  const winRateByDirection: StatsResult["winRateByDirection"] = {};
  Object.entries(dirGroups).forEach(([dir, data]) => {
    winRateByDirection[dir] = { ...data, rate: data.total > 0 ? (data.wins / data.total) * 100 : 0 };
  });

  // Win rate by hour
  const hourGroups: Record<string, { wins: number; total: number }> = {};
  closedSignals.forEach((s) => {
    const hour = new Date(s.entryTime).getHours().toString().padStart(2, "0") + ":00";
    if (!hourGroups[hour]) hourGroups[hour] = { wins: 0, total: 0 };
    hourGroups[hour].total++;
    if (s.result === "WIN") hourGroups[hour].wins++;
  });
  const winRateByHour: StatsResult["winRateByHour"] = {};
  Object.entries(hourGroups).forEach(([hour, data]) => {
    winRateByHour[hour] = { ...data, rate: data.total > 0 ? (data.wins / data.total) * 100 : 0 };
  });

  // Best/worst asset
  const assetEntries = Object.entries(winRateByAsset).filter(([, d]) => d.total >= 1);
  const bestAsset = assetEntries.length > 0
    ? assetEntries.sort((a, b) => b[1].rate - a[1].rate)[0][0]
    : null;
  const worstAsset = assetEntries.length > 0
    ? assetEntries.sort((a, b) => a[1].rate - b[1].rate)[0][0]
    : null;

  // Best/worst timeframe
  const tfEntries = Object.entries(winRateByTimeframe).filter(([, d]) => d.total >= 1);
  const bestTimeframe = tfEntries.length > 0
    ? tfEntries.sort((a, b) => b[1].rate - a[1].rate)[0][0]
    : null;
  const worstTimeframe = tfEntries.length > 0
    ? tfEntries.sort((a, b) => a[1].rate - b[1].rate)[0][0]
    : null;

  // Best/worst hour
  const hourEntries = Object.entries(winRateByHour).filter(([, d]) => d.total >= 1);
  const bestHour = hourEntries.length > 0
    ? hourEntries.sort((a, b) => b[1].rate - a[1].rate)[0][0]
    : null;
  const worstHour = hourEntries.length > 0
    ? hourEntries.sort((a, b) => a[1].rate - b[1].rate)[0][0]
    : null;

  // Consecutive wins/losses
  const sortedClosed = [...closedSignals].sort(
    (a, b) => new Date(a.entryTime).getTime() - new Date(b.entryTime).getTime()
  );
  let currentConsecutiveWins = 0;
  let currentConsecutiveLosses = 0;
  let maxConsecutiveWins = 0;
  let maxConsecutiveLosses = 0;
  let tempWins = 0;
  let tempLosses = 0;

  for (let i = sortedClosed.length - 1; i >= 0; i--) {
    const r = sortedClosed[i].result;
    if (i === sortedClosed.length - 1) {
      currentConsecutiveWins = r === "WIN" ? 1 : 0;
      currentConsecutiveLosses = r === "LOSS" ? 1 : 0;
    }
    if (r === "WIN") {
      tempWins++;
      tempLosses = 0;
    } else if (r === "LOSS") {
      tempLosses++;
      tempWins = 0;
    } else {
      tempWins = 0;
      tempLosses = 0;
    }
    maxConsecutiveWins = Math.max(maxConsecutiveWins, tempWins);
    maxConsecutiveLosses = Math.max(maxConsecutiveLosses, tempLosses);
  }

  // Weekly performance
  const weekMap: Record<string, { wins: number; losses: number; draws: number; total: number }> = {};
  closedSignals.forEach((s) => {
    const d = new Date(s.entryTime);
    const startOfYear = new Date(d.getFullYear(), 0, 1);
    const weekNum = Math.ceil(((d.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7);
    const weekKey = `${d.getFullYear()}-W${weekNum.toString().padStart(2, "0")}`;
    if (!weekMap[weekKey]) weekMap[weekKey] = { wins: 0, losses: 0, draws: 0, total: 0 };
    weekMap[weekKey].total++;
    if (s.result === "WIN") weekMap[weekKey].wins++;
    else if (s.result === "LOSS") weekMap[weekKey].losses++;
    else if (s.result === "DRAW") weekMap[weekKey].draws++;
  });
  const weeklyPerformance = Object.entries(weekMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, data]) => ({
      week,
      ...data,
      winRate: data.total > 0 ? (data.wins / data.total) * 100 : 0,
    }));

  // Monthly performance
  const monthMap: Record<string, { wins: number; losses: number; draws: number; total: number }> = {};
  closedSignals.forEach((s) => {
    const d = new Date(s.entryTime);
    const monthKey = `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, "0")}`;
    if (!monthMap[monthKey]) monthMap[monthKey] = { wins: 0, losses: 0, draws: 0, total: 0 };
    monthMap[monthKey].total++;
    if (s.result === "WIN") monthMap[monthKey].wins++;
    else if (s.result === "LOSS") monthMap[monthKey].losses++;
    else if (s.result === "DRAW") monthMap[monthKey].draws++;
  });
  const monthlyPerformance = Object.entries(monthMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, data]) => ({
      month,
      ...data,
      winRate: data.total > 0 ? (data.wins / data.total) * 100 : 0,
    }));

  // Recommended confidence threshold
  const highConfWins = closedSignals.filter((s) => s.confidence >= 70 && s.result === "WIN").length;
  const highConfTotal = closedSignals.filter((s) => s.confidence >= 70).length;
  const lowConfWins = closedSignals.filter((s) => s.confidence < 70 && s.result === "WIN").length;
  const lowConfTotal = closedSignals.filter((s) => s.confidence < 70).length;
  const highConfRate = highConfTotal > 0 ? highConfWins / highConfTotal : 0;
  const lowConfRate = lowConfTotal > 0 ? lowConfWins / lowConfTotal : 0;
  const recommendedConfidenceThreshold =
    highConfRate > lowConfRate && highConfTotal >= 3 ? 70 :
    closedSignals.length >= 10 ? Math.round(averageConfidence) : 65;

  return {
    totalSignals: signals.length,
    winCount,
    lossCount,
    drawCount,
    noOperarCount,
    pendingCount,
    winRate: Math.round(winRate * 100) / 100,
    averageConfidence: Math.round(averageConfidence * 100) / 100,
    profitFactor: profitFactor === Infinity ? -1 : Math.round(profitFactor * 100) / 100,
    totalEstimatedProfit: Math.round(totalEstimatedProfit * 100) / 100,
    totalEstimatedLoss: Math.round(totalEstimatedLoss * 100) / 100,
    netResult: Math.round(netResult * 100) / 100,
    winRateByAsset,
    winRateByTimeframe,
    winRateByDirection,
    winRateByHour,
    bestAsset,
    worstAsset,
    bestTimeframe,
    worstTimeframe,
    bestHour,
    worstHour,
    currentConsecutiveWins,
    currentConsecutiveLosses,
    maxConsecutiveWins,
    maxConsecutiveLosses,
    weeklyPerformance,
    monthlyPerformance,
    recommendedConfidenceThreshold,
  };
}

export interface AlertCondition {
  type: string;
  message: string;
  severity: "info" | "warning" | "critical";
}

export function checkAlerts(signals: SignalRecord[]): AlertCondition[] {
  const alerts: AlertCondition[] = [];
  const closedSignals = signals.filter(
    (s) => s.status === "CLOSED" && s.result
  );

  // Check 3 consecutive losses
  const sorted = [...closedSignals].sort(
    (a, b) => new Date(b.entryTime).getTime() - new Date(a.entryTime).getTime()
  );
  let consecutiveLosses = 0;
  for (const s of sorted) {
    if (s.result === "LOSS") consecutiveLosses++;
    else break;
  }
  if (consecutiveLosses >= 3) {
    alerts.push({
      type: "CONSECUTIVE_LOSSES",
      message: `${consecutiveLosses} pérdidas consecutivas detectadas. Considere pausar las operaciones.`,
      severity: consecutiveLosses >= 5 ? "critical" : "warning",
    });
  }

  // Check win rate below 55%
  const totalDecisive = closedSignals.filter(
    (s) => s.result === "WIN" || s.result === "LOSS"
  );
  const wins = totalDecisive.filter((s) => s.result === "WIN").length;
  const winRate = totalDecisive.length > 0 ? (wins / totalDecisive.length) * 100 : 100;
  if (totalDecisive.length >= 10 && winRate < 55) {
    alerts.push({
      type: "LOW_WINRATE",
      message: `Tasa de victoria baja: ${winRate.toFixed(1)}%. Por debajo del 55% en las últimas ${totalDecisive.length} señales.`,
      severity: winRate < 45 ? "critical" : "warning",
    });
  }

  // Check for bad asset performance
  const assetStats: Record<string, { wins: number; total: number }> = {};
  closedSignals.forEach((s) => {
    if (s.result === "WIN" || s.result === "LOSS") {
      if (!assetStats[s.asset]) assetStats[s.asset] = { wins: 0, total: 0 };
      assetStats[s.asset].total++;
      if (s.result === "WIN") assetStats[s.asset].wins++;
    }
  });
  Object.entries(assetStats).forEach(([asset, data]) => {
    if (data.total >= 5) {
      const rate = (data.wins / data.total) * 100;
      if (rate < 40) {
        alerts.push({
          type: "BAD_ASSET_PERFORMANCE",
          message: `Activo ${asset} con rendimiento bajo: ${rate.toFixed(1)}% en ${data.total} señales.`,
          severity: rate < 30 ? "critical" : "warning",
        });
      }
    }
  });

  // Check for contradictory signals (recent HIGHER and LOWER on same asset)
  const recentSignals = sorted.slice(0, 10);
  const assetDirections: Record<string, string[]> = {};
  recentSignals.forEach((s) => {
    if (!assetDirections[s.asset]) assetDirections[s.asset] = [];
    assetDirections[s.asset].push(s.direction);
  });
  Object.entries(assetDirections).forEach(([asset, dirs]) => {
    const hasHigher = dirs.includes("HIGHER");
    const hasLower = dirs.includes("LOWER");
    if (hasHigher && hasLower) {
      alerts.push({
        type: "CONTRADICTORY_SIGNALS",
        message: `Señales contradictorias en ${asset}: HIGHER y LOWER en las últimas operaciones.`,
        severity: "warning",
      });
    }
  });

  // High volatility check
  const recentWithPrice = closedSignals.filter((s) => s.priceDifference !== null).slice(0, 20);
  if (recentWithPrice.length >= 5) {
    const avgDiff = recentWithPrice.reduce((sum, s) => sum + Math.abs(s.priceDifference || 0), 0) / recentWithPrice.length;
    const avgEntry = recentWithPrice.reduce((sum, s) => sum + s.entryPrice, 0) / recentWithPrice.length;
    const volatilityPct = avgEntry > 0 ? (avgDiff / avgEntry) * 100 : 0;
    if (volatilityPct > 2) {
      alerts.push({
        type: "EXTREME_VOLATILITY",
        message: `Alta volatilidad detectada: ${volatilityPct.toFixed(1)}% de movimiento promedio.`,
        severity: volatilityPct > 5 ? "critical" : "warning",
      });
    }
  }

  return alerts;
}

export function simulateExitPrice(entryPrice: number, direction: string): number {
  // Simulate realistic price movement for demo mode
  const volatility = 0.001 + Math.random() * 0.003; // 0.1% to 0.4% movement
  const movement = entryPrice * volatility;
  // Slight bias toward the predicted direction but not guaranteed (realistic)
  const bias = direction === "HIGHER" ? 0.55 : direction === "LOWER" ? 0.45 : 0.5;
  const goesUp = Math.random() < bias;
  const exitPrice = goesUp
    ? entryPrice + movement
    : entryPrice - movement;
  return Math.round(exitPrice * 100000) / 100000;
}
