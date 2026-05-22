// EXPECTANCY ENGINE
// "55% WR puede perder dinero. 45% WR puede ganar dinero." — Win Rate alone is insufficient.
// Expected Value (EV) is the true measure of a trading edge.
// EV = (WR × avgWin) − (LR × avgLoss) in R-multiples, where risk = 1R
//
// A system with 55% WR and 0.7:1 R:R loses money: EV = (0.55 × 0.7) − (0.45 × 1) = −0.065R
// A system with 45% WR and 2:1 R:R makes money:  EV = (0.45 × 2.0) − (0.55 × 1) = +0.35R
// Win Rate tells you HOW OFTEN you win. EV tells you HOW MUCH you win.

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExpectancyResult {
  expectedValue: number;        // EV per trade (in R-multiples: risk = 1R)
  riskRewardRatio: number;      // Average R:R ratio
  kellyFraction: number;        // Kelly criterion optimal fraction (0-1)
  profitFactor: number;         // Gross profit / Gross loss
  avgWin: number;               // Average winning trade in R
  avgLoss: number;              // Average losing trade in R
  sharpeRatio: number;          // Approximate Sharpe ratio of trade outcomes
  maxDrawdown: number;          // Maximum drawdown in R (from cumulative P&L)
  calmarRatio: number;          // Return / Max Drawdown
  expectancyPerTrade: number;   // = (WR * avgWin) - (LR * avgLoss) in R
  interpretation: string;       // Spanish interpretation
  isProfitable: boolean;        // EV > 0
}

export interface TradeRecord {
  result: 'WIN' | 'LOSS';
  profit: number;   // Profit in R-multiples for WIN trades (e.g., 1.5 means 1.5R profit)
  loss: number;     // Loss in R-multiples for LOSS trades (e.g., 1.0 means 1R loss)
}

// ─── Main Analysis Function ───────────────────────────────────────────────────

/**
 * Calculate comprehensive expectancy metrics from individual trade records.
 * Each trade specifies its profit (for wins) or loss (for losses) in R-multiples.
 *
 * @param trades - Array of trade records with result, profit, and loss
 * @returns Complete ExpectancyResult with all metrics and Spanish interpretation
 */
export function calculateExpectancy(trades: TradeRecord[]): ExpectancyResult {
  if (trades.length === 0) {
    return emptyExpectancyResult('Sin datos: no hay trades para analizar.');
  }

  const wins = trades.filter(t => t.result === 'WIN');
  const losses = trades.filter(t => t.result === 'LOSS');
  const totalTrades = trades.length;

  const winRate = wins.length / totalTrades;
  const lossRate = losses.length / totalTrades;

  // Average win/loss in R-multiples
  const avgWin = wins.length > 0
    ? wins.reduce((sum, t) => sum + t.profit, 0) / wins.length
    : 0;
  const avgLoss = losses.length > 0
    ? losses.reduce((sum, t) => sum + t.loss, 0) / losses.length
    : 0;

  // Risk-Reward Ratio (avg win / avg loss)
  const riskRewardRatio = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0;

  // Expected Value per trade in R-multiples
  const expectedValue = (winRate * avgWin) - (lossRate * avgLoss);
  const expectancyPerTrade = expectedValue; // Same as EV, explicit alias

  // Profit Factor: gross profit / gross loss
  const grossProfit = wins.reduce((sum, t) => sum + t.profit, 0);
  const grossLoss = losses.reduce((sum, t) => sum + t.loss, 0);
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Kelly Criterion
  const kellyFraction = kellyCriterion(winRate, riskRewardRatio);

  // Sharpe Ratio (simplified for binary outcomes)
  const sharpeRatio = calculateSharpeRatio(trades, expectedValue);

  // Max Drawdown from cumulative P&L curve
  const maxDrawdown = calculateMaxDrawdown(trades);

  // Calmar Ratio: total return / max drawdown
  const totalReturn = trades.reduce((sum, t) => {
    return sum + (t.result === 'WIN' ? t.profit : -t.loss);
  }, 0);
  const calmarRatio = maxDrawdown > 0 ? totalReturn / maxDrawdown : totalReturn > 0 ? Infinity : 0;

  // Interpretation in Spanish
  const interpretation = generateInterpretation(
    expectedValue,
    winRate,
    riskRewardRatio,
    kellyFraction,
    profitFactor,
    totalTrades
  );

  return {
    expectedValue: roundTo4(expectedValue),
    riskRewardRatio: roundTo4(riskRewardRatio),
    kellyFraction: roundTo4(kellyFraction),
    profitFactor: profitFactor === Infinity ? -1 : roundTo4(profitFactor),
    avgWin: roundTo4(avgWin),
    avgLoss: roundTo4(avgLoss),
    sharpeRatio: roundTo4(sharpeRatio),
    maxDrawdown: roundTo4(maxDrawdown),
    calmarRatio: calmarRatio === Infinity ? -1 : roundTo4(calmarRatio),
    expectancyPerTrade: roundTo4(expectancyPerTrade),
    interpretation,
    isProfitable: expectedValue > 0,
  };
}

// ─── Quick EV Estimate ────────────────────────────────────────────────────────

/**
 * Quick EV estimate for auto-trader when we only have WR and assumed R:R.
 * This assumes avgWin = avgRiskReward × 1R and avgLoss = 1R.
 *
 * @param winRate - Win rate as a decimal (0.55 = 55%)
 * @param avgRiskReward - Average risk:reward ratio (1.8 = 1.8:1)
 * @returns Expected value per trade in R-multiples
 */
export function quickEV(winRate: number, avgRiskReward: number): number {
  // EV = (WR × avgWin) − (LR × avgLoss)
  // Where avgWin = avgRiskReward × 1R, avgLoss = 1R
  const lossRate = 1 - winRate;
  return roundTo4(winRate * avgRiskReward - lossRate * 1);
}

// ─── Kelly Criterion ──────────────────────────────────────────────────────────

/**
 * Kelly Criterion: optimal fraction of capital to risk per trade.
 * Kelly = WR − (LR / avgRiskReward)
 *
 * In practice, traders use half-Kelly or quarter-Kelly for safety.
 *
 * @param winRate - Win rate as a decimal (0.55 = 55%)
 * @param avgRiskReward - Average risk:reward ratio (1.8 = 1.8:1)
 * @returns Kelly fraction (0-1), clamped to valid range
 */
export function kellyCriterion(winRate: number, avgRiskReward: number): number {
  if (avgRiskReward <= 0) return 0;

  const lossRate = 1 - winRate;
  const kelly = winRate - (lossRate / avgRiskReward);

  // Clamp to [0, 1] — negative Kelly means no edge
  return Math.max(0, Math.min(1, roundTo4(kelly)));
}

// ─── Estimate from SetupStats ─────────────────────────────────────────────────

/**
 * Estimate expectancy when we don't have individual trade P&L data.
 * Uses reasonable defaults: avgWin = 1.5R (from pattern key levels),
 * avgLoss = 1R, adjusted by setup score quality.
 *
 * @param winRate - Win rate as percentage (55 = 55%)
 * @param totalSignals - Total number of historical signals
 * @param avgSetupScore - Average setup score (0-100) for quality adjustment
 * @returns Estimated ExpectancyResult
 */
export function estimateExpectancyFromStats(
  winRate: number,
  totalSignals: number,
  avgSetupScore: number
): ExpectancyResult {
  // Convert winRate from percentage to decimal
  const wr = winRate / 100;
  const lr = 1 - wr;

  // Base assumptions: avgWin = 1.5R (pattern key levels), avgLoss = 1R
  // Higher setup scores tend to have better R:R (better entry timing)
  const setupScoreMultiplier = 0.5 + (avgSetupScore / 100) * 1.5; // Range: 0.5 to 2.0
  const avgWin = 1.5 * setupScoreMultiplier;
  const avgLoss = 1.0;

  const riskRewardRatio = avgWin / avgLoss;
  const expectedValue = (wr * avgWin) - (lr * avgLoss);
  const profitFactor = lr > 0 && avgLoss > 0
    ? (wr * avgWin) / (lr * avgLoss)
    : wr > 0 ? Infinity : 0;
  const kellyFraction = kellyCriterion(wr, riskRewardRatio);

  // Estimate Sharpe from binary outcome distribution
  const variance = wr * Math.pow(avgWin - expectedValue, 2) + lr * Math.pow(-avgLoss - expectedValue, 2);
  const stdDev = Math.sqrt(variance);
  const sharpeRatio = stdDev > 0 ? (expectedValue / stdDev) * Math.sqrt(252) : 0;

  // Estimate max drawdown (rough: based on consecutive loss probability)
  const consecLossProb = Math.pow(lr, 3); // Probability of 3 consecutive losses
  const estimatedMaxDD = consecLossProb > 0 ? avgLoss * (1 / consecLossProb) * 0.1 : avgLoss * 3;

  const totalReturn = totalSignals * expectedValue;
  const calmarRatio = estimatedMaxDD > 0 ? totalReturn / estimatedMaxDD : totalReturn > 0 ? Infinity : 0;

  const interpretation = generateInterpretation(
    expectedValue,
    wr,
    riskRewardRatio,
    kellyFraction,
    profitFactor,
    totalSignals
  );

  return {
    expectedValue: roundTo4(expectedValue),
    riskRewardRatio: roundTo4(riskRewardRatio),
    kellyFraction: roundTo4(kellyFraction),
    profitFactor: profitFactor === Infinity ? -1 : roundTo4(profitFactor),
    avgWin: roundTo4(avgWin),
    avgLoss: roundTo4(avgLoss),
    sharpeRatio: roundTo4(sharpeRatio),
    maxDrawdown: roundTo4(estimatedMaxDD),
    calmarRatio: calmarRatio === Infinity ? -1 : roundTo4(calmarRatio),
    expectancyPerTrade: roundTo4(expectedValue),
    interpretation,
    isProfitable: expectedValue > 0,
  };
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Calculate approximate Sharpe ratio for a series of trade outcomes.
 * Simplified: treats each trade as a return observation, annualizes with sqrt(252).
 */
function calculateSharpeRatio(trades: TradeRecord[], expectedValue: number): number {
  if (trades.length < 2) return 0;

  // Convert trades to return series in R-multiples
  const returns = trades.map(t =>
    t.result === 'WIN' ? t.profit : -t.loss
  );

  // Calculate standard deviation of returns
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return 0;

  // Annualized Sharpe: (mean / stdDev) × sqrt(252)
  // Using ~252 trading days per year
  const sharpe = (expectedValue / stdDev) * Math.sqrt(252);
  return sharpe;
}

/**
 * Calculate maximum drawdown from a series of trades.
 * Max DD = maximum peak-to-trough decline in cumulative P&L.
 */
function calculateMaxDrawdown(trades: TradeRecord[]): number {
  if (trades.length === 0) return 0;

  let cumulativePnL = 0;
  let peak = 0;
  let maxDrawdown = 0;

  for (const trade of trades) {
    const tradePnL = trade.result === 'WIN' ? trade.profit : -trade.loss;
    cumulativePnL += tradePnL;

    // Update peak
    if (cumulativePnL > peak) {
      peak = cumulativePnL;
    }

    // Calculate drawdown from peak
    const drawdown = peak - cumulativePnL;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }

  return maxDrawdown;
}

/**
 * Generate a Spanish-language interpretation of the expectancy results.
 * Covers EV, R:R, Kelly, and profit factor insights.
 */
function generateInterpretation(
  expectedValue: number,
  winRate: number,
  riskRewardRatio: number,
  kellyFraction: number,
  profitFactor: number,
  sampleSize: number
): string {
  const parts: string[] = [];
  const wrPct = (winRate * 100).toFixed(1);
  const rrFormatted = riskRewardRatio.toFixed(2);
  const evFormatted = expectedValue >= 0
    ? `+${expectedValue.toFixed(2)}R`
    : `${expectedValue.toFixed(2)}R`;

  // EV interpretation
  if (expectedValue > 0) {
    parts.push(
      `EV positivo: ${evFormatted} por trade. Con R:R de ${rrFormatted}:1, un WR de ${wrPct}% genera beneficio.`
    );
  } else if (expectedValue < 0) {
    parts.push(
      `EV negativo: ${evFormatted} por trade. Aunque WR es ${wrPct}%, el R:R de ${rrFormatted}:1 genera pérdida.`
    );
  } else {
    parts.push(
      `EV neutro: ${evFormatted} por trade. El sistema está en break-even. Necesitas mejorar WR o R:R.`
    );
  }

  // Profit factor interpretation
  if (profitFactor >= 2) {
    parts.push(`Profit Factor ${profitFactor.toFixed(2)} es excelente (>2.0). Edge sólido.`);
  } else if (profitFactor >= 1.5) {
    parts.push(`Profit Factor ${profitFactor.toFixed(2)} es bueno (1.5-2.0). Edge operable.`);
  } else if (profitFactor >= 1.0) {
    parts.push(`Profit Factor ${profitFactor.toFixed(2)} es marginal (1.0-1.5). Edge débil, cuida el tamaño de posición.`);
  } else {
    parts.push(`Profit Factor ${profitFactor.toFixed(2)} es negativo (<1.0). Sistema perdedor. NO operar.`);
  }

  // Kelly interpretation
  if (kellyFraction > 0) {
    const halfKelly = (kellyFraction * 50).toFixed(1);
    parts.push(
      `Kelly sugiere arriesgar ${(kellyFraction * 100).toFixed(1)}% del capital por trade. Conservador: ${halfKelly}% (half-Kelly).`
    );
  } else {
    parts.push('Kelly = 0%: el sistema no tiene edge. No arriesques capital real.');
  }

  // Sample size caveat
  if (sampleSize < 30) {
    parts.push(`⚠ Solo ${sampleSize} muestras. Mínimo 30 para confianza básica. Resultados NO fiables.`);
  } else if (sampleSize < 100) {
    parts.push(`⚠ ${sampleSize} muestras es bajo. Se necesitan 100+ para confianza estadística.`);
  }

  return parts.join(' ');
}

/**
 * Return an empty expectancy result with a message.
 */
function emptyExpectancyResult(message: string): ExpectancyResult {
  return {
    expectedValue: 0,
    riskRewardRatio: 0,
    kellyFraction: 0,
    profitFactor: 0,
    avgWin: 0,
    avgLoss: 0,
    sharpeRatio: 0,
    maxDrawdown: 0,
    calmarRatio: 0,
    expectancyPerTrade: 0,
    interpretation: message,
    isProfitable: false,
  };
}

/**
 * Round a number to 4 decimal places.
 */
function roundTo4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
