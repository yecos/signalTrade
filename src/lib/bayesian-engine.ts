// BAYESIAN STATISTICS ENGINE — SignalTrader Pro
// "60% con 500 trades vale MÁS que 100% con 2"
//
// Provides REAL statistical rigor via Bayesian inference.
// Uses Beta-Binomial conjugate prior to properly adjust win rates
// based on sample size, preventing overconfidence from small samples.
//
// Core insight: A 100% WR with 2 trades tells you almost nothing.
// A 60% WR with 500 trades is a genuine, tradeable edge.
// The Bayesian adjustment reflects this reality mathematically.

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BayesianResult {
  rawWinRate: number;           // Raw observed WR (0-100)
  bayesianWinRate: number;      // Bayesian adjusted WR (0-100)
  confidenceInterval: { lower: number; upper: number }; // 95% CI (0-100)
  pValue: number;               // P-value vs random (0-1)
  bayesFactor: number;          // BF10 evidence ratio (≥0)
  sampleVariance: number;       // Variance of estimated proportion (0-1 scale)
  significanceLevel: 'INSUFFICIENT' | 'WEAK' | 'MODERATE' | 'STRONG' | 'VERY_STRONG';
  sampleSize: number;
  wins: number;
  losses: number;
  interpretation: string;       // Spanish: human-readable interpretation
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Prior parameters for Beta-Binomial model: Beta(α₀, β₀) centered at 50% */
const PRIOR_ALPHA = 25;
const PRIOR_BETA = 25;
/** Equivalent pseudo-observations from the prior */
const PRIOR_STRENGTH = PRIOR_ALPHA + PRIOR_BETA; // 50

// ─── Mathematical Foundation ──────────────────────────────────────────────────

/**
 * Log-Gamma function using Lanczos approximation.
 * Accurate to ~15 significant digits for positive real arguments.
 * Required for computing the Beta function in log-space to avoid overflow.
 */
function logGamma(z: number): number {
  if (z <= 0) {
    throw new Error(`logGamma: argument must be positive, got ${z}`);
  }

  // Lanczos approximation with g=7, coefficients from Numerical Recipes
  const g = 7;
  const coef = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];

  // Reflection formula for z < 0.5
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }

  // Shift to z >= 0.5
  z -= 1;
  let x = coef[0];
  for (let i = 1; i < g + 2; i++) {
    x += coef[i] / (z + i);
  }

  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * Beta function B(a, b) = Γ(a)Γ(b) / Γ(a+b)
 * Computed in log-space to prevent overflow for large arguments.
 */
export function betaFunction(a: number, b: number): number {
  if (a <= 0 || b <= 0) {
    throw new Error(`betaFunction: arguments must be positive, got (${a}, ${b})`);
  }
  return Math.exp(logGamma(a) + logGamma(b) - logGamma(a + b));
}

/**
 * Log of Beta function — safer for large arguments.
 */
function logBeta(a: number, b: number): number {
  if (a <= 0 || b <= 0) {
    throw new Error(`logBeta: arguments must be positive, got (${a}, ${b})`);
  }
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

/**
 * Regularized incomplete beta function I_x(a, b).
 * Uses continued fraction representation (Lentz's modified method).
 *
 * I_x(a,b) = B(x; a,b) / B(a,b)
 *
 * where B(x; a,b) is the incomplete beta function.
 * Returns values in [0, 1].
 *
 * Algorithm: Continued fraction from Numerical Recipes (Press et al.),
 * using Lentz's method for numerical stability.
 */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x < 0 || x > 1) {
    throw new Error(`incompleteBeta: x must be in [0,1], got ${x}`);
  }
  if (a <= 0 || b <= 0) {
    throw new Error(`incompleteBeta: a and b must be positive, got (${a}, ${b})`);
  }

  // Trivial cases
  if (x === 0) return 0;
  if (x === 1) return 1;

  // Use symmetry relation I_x(a,b) = 1 - I_{1-x}(b,a) for convergence
  // The continued fraction converges faster when x < (a+1)/(a+b+2)
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - incompleteBeta(1 - x, b, a);
  }

  // Prefactor: x^a * (1-x)^b / (a * B(a,b))
  const logPrefactor = a * Math.log(x) + b * Math.log(1 - x) - logBeta(a, b) - Math.log(a);
  const prefactor = Math.exp(logPrefactor);

  // Continued fraction using Lentz's method
  // I_x(a,b) = prefactor * 1/(1 + d1/(1 + d2/(1 + ...)))
  //
  // Odd terms:  d_{2m+1} = -(a+m)(a+b+m) * x / ((a+2m)(a+2m+1))
  // Even terms: d_{2m}   = m(b-m) * x / ((a+2m-1)(a+2m))

  const maxIter = 200;
  const eps = 1e-14;
  const tiny = 1e-30;

  let f = 1; // f = 1 (first term of CF)
  let C = 1;
  let D = 1;

  for (let m = 0; m <= maxIter; m++) {
    let d: number;
    if (m === 0) {
      d = 1; // first term is 1
    } else {
      const m2 = m * 2;
      if (m % 2 === 0) {
        // Even: d_{2k} where k = m/2
        const k = m / 2;
        d = (k * (b - k) * x) / ((a + m2 - 1) * (a + m2));
      } else {
        // Odd: d_{2k+1} where k = (m-1)/2
        const k = (m - 1) / 2;
        d = -((a + k) * (a + b + k) * x) / ((a + m2 - 1) * (a + m2));
      }
    }

    // Lentz's method: update C and D
    D = 1 + d * D;
    if (Math.abs(D) < tiny) D = tiny;
    D = 1 / D;

    C = 1 + d / C;
    if (Math.abs(C) < tiny) C = tiny;

    const delta = C * D;
    f *= delta;

    if (Math.abs(delta - 1) < eps) {
      return prefactor * f;
    }
  }

  // If we didn't converge, return best estimate
  return prefactor * f;
}

/**
 * Standard normal CDF approximation (Abramowitz and Stegun).
 * Maximum error: 7.5e-8
 */
export function normalCDF(z: number): number {
  if (z < -8) return 0;
  if (z > 8) return 1;

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2);

  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}

// ─── Core Statistical Functions ───────────────────────────────────────────────

/**
 * Wilson score interval for binomial proportion.
 * Better behaved than the Wald interval, especially for small samples
 * or proportions near 0 or 1.
 *
 * @param wins  Number of successes
 * @param total Total number of trials
 * @param z     Z-score for confidence level (default 1.96 for 95%)
 * @returns     { lower, upper } bounds as proportions (0-1 scale)
 */
export function wilsonCI(
  wins: number,
  total: number,
  z: number = 1.96
): { lower: number; upper: number } {
  if (total === 0) {
    return { lower: 0, upper: 1 };
  }

  const pHat = wins / total;
  const z2 = z * z;
  const n = total;

  const denominator = 1 + z2 / n;
  const center = (pHat + z2 / (2 * n)) / denominator;
  const margin = (z * Math.sqrt(pHat * (1 - pHat) / n + z2 / (4 * n * n))) / denominator;

  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  };
}

/**
 * Compute p-value using normal approximation to binomial.
 * Tests H0: WR = 50% vs H1: WR ≠ 50% (two-tailed).
 *
 * Uses the null hypothesis proportion p₀ = 0.5 to compute the
 * standard error, which is the correct approach for hypothesis testing.
 */
function computePValue(wins: number, total: number): number {
  if (total < 2) return 1.0;

  const p0 = 0.5; // null hypothesis
  const pHat = wins / total;
  const se = Math.sqrt((p0 * (1 - p0)) / total);
  const z = Math.abs(pHat - p0) / se;

  // Two-tailed: P(|Z| > z) = 2 * (1 - Φ(z))
  const pValue = 2 * (1 - normalCDF(z));
  return Math.max(0, Math.min(1, pValue));
}

/**
 * Compute Bayes Factor BF10 = P(data | H1) / P(data | H0).
 *
 * H0: p = 0.5 (random, no edge)
 * H1: p ~ Beta(α₀, β₀) — the prior under the alternative hypothesis
 *
 * Using Beta-Binomial conjugacy:
 *   P(data | H1) = C(n,w) * B(α₀+w, β₀+l) / B(α₀, β₀)
 *   P(data | H0) = C(n,w) * 0.5^n
 *
 * Therefore:
 *   BF10 = B(α₀+w, β₀+l) / (B(α₀, β₀) * 0.5^n)
 *
 * All computation in log-space to prevent overflow.
 *
 * Interpretation scale (Kass & Raftery, 1995):
 *   BF10 < 1:     Evidence favors H0 (no edge)
 *   1-3:          Anecdotal evidence for H1
 *   3-10:         Moderate evidence for H1
 *   10-30:        Strong evidence for H1
 *   30-100:       Very strong evidence for H1
 *   > 100:        Extreme evidence for H1
 */
function computeBayesFactor(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1.0;

  // log(BF10) = logB(α₀+w, β₀+l) - logB(α₀, β₀) + n*log(2)
  const logBF =
    logBeta(PRIOR_ALPHA + wins, PRIOR_BETA + losses) -
    logBeta(PRIOR_ALPHA, PRIOR_BETA) +
    n * Math.log(2);

  return Math.exp(logBF);
}

/**
 * Compute sample variance of the estimated proportion.
 * For binary outcomes (WIN=1, LOSS=0), the variance of the
 * sample proportion estimate is p̂(1-p̂)/n.
 *
 * Uses the Bayesian posterior mean for p̂ to be consistent with
 * the overall Bayesian framework.
 */
function computeSampleVariance(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 0.25; // Maximum uncertainty

  const pBayesian = (PRIOR_ALPHA + wins) / (PRIOR_STRENGTH + n);
  return (pBayesian * (1 - pBayesian)) / n;
}

/**
 * Determine the composite statistical significance level.
 *
 * Tiers (checked from strongest to weakest):
 *   VERY_STRONG: n ≥ 500 AND p < 0.001
 *   STRONG:      n ≥ 100 AND p < 0.01
 *   MODERATE:    n ≥ 30  AND p < 0.05
 *   WEAK:        n ≥ 10  AND p < 0.1
 *   INSUFFICIENT: everything else (small sample or no significance)
 */
function computeSignificanceLevel(
  n: number,
  pValue: number
): 'INSUFFICIENT' | 'WEAK' | 'MODERATE' | 'STRONG' | 'VERY_STRONG' {
  if (n < 10) return 'INSUFFICIENT';

  // Check from strongest to weakest
  if (n >= 500 && pValue < 0.001) return 'VERY_STRONG';
  if (n >= 100 && pValue < 0.01) return 'STRONG';
  if (n >= 30 && pValue < 0.05) return 'MODERATE';
  if (n >= 10 && pValue < 0.1) return 'WEAK';

  return 'INSUFFICIENT';
}

/**
 * Generate a Spanish-language interpretation of the statistical results.
 * Contextualizes the numbers into actionable trading intelligence.
 */
function generateInterpretation(
  result: Omit<BayesianResult, 'interpretation'>
): string {
  const {
    rawWinRate,
    bayesianWinRate,
    confidenceInterval,
    pValue,
    bayesFactor,
    significanceLevel,
    sampleSize,
  } = result;

  const ci = `${confidenceInterval.lower.toFixed(1)}%-${confidenceInterval.upper.toFixed(1)}%`;

  // ── INSUFFICIENT DATA ──
  if (sampleSize < 10) {
    if (sampleSize === 0) {
      return 'Sin datos. No hay trades para analizar. Recopila señales antes de evaluar edge.';
    }
    if (rawWinRate === 100) {
      return (
        `Muestra insuficiente (${sampleSize} trade${sampleSize > 1 ? 's' : ''}). ` +
        `WR observado 100% pero ajustado a ${bayesianWinRate.toFixed(1)}%. ` +
        `Probablemente ruido estadístico. Se necesitan mínimo 30 trades para conclusions básicas.`
      );
    }
    if (rawWinRate === 0) {
      return (
        `Muestra insuficiente (${sampleSize} trade${sampleSize > 1 ? 's' : ''}). ` +
        `WR observado 0% pero ajustado a ${bayesianWinRate.toFixed(1)}%. ` +
        `Probablemente ruido estadístico. Se necesitan mínimo 30 trades para conclusions básicas.`
      );
    }
    return (
      `Muestra insuficiente (${sampleSize} trades). ` +
      `WR observado ${rawWinRate.toFixed(1)}% ajustado a ${bayesianWinRate.toFixed(1)}%. ` +
      `IC 95% demasiado amplio (${ci}) para conclusions. Se necesitan mínimo 30 trades.`
    );
  }

  // ── BAYES FACTOR INTERPRETATION ──
  let bfLabel: string;
  if (bayesFactor < 1) {
    bfLabel = 'evidencia favorece H0 (sin edge)';
  } else if (bayesFactor < 3) {
    bfLabel = 'evidencia anecdótica';
  } else if (bayesFactor < 10) {
    bfLabel = 'evidencia moderada';
  } else if (bayesFactor < 30) {
    bfLabel = 'evidencia fuerte';
  } else if (bayesFactor < 100) {
    bfLabel = 'evidencia muy fuerte';
  } else {
    bfLabel = 'evidencia extrema';
  }

  // ── DETERMINE EDGE DIRECTION ──
  const isPositiveEdge = bayesianWinRate > 51;
  const isNegativeEdge = bayesianWinRate < 49;
  const isNeutral = !isPositiveEdge && !isNegativeEdge;

  // ── SIGNIFICANCE-BASED INTERPRETATION ──
  if (significanceLevel === 'INSUFFICIENT') {
    if (isNeutral) {
      return (
        `Sin edge detectado: WR ${rawWinRate.toFixed(1)}% (ajustado ${bayesianWinRate.toFixed(1)}%, IC 95%: ${ci}), ` +
        `p=${pValue.toFixed(3)}, BF₁₀=${bayesFactor.toFixed(2)} (${bfLabel}). ` +
        `No significativamente diferente de aleatorio. Continúa recolectando datos.`
      );
    }
    return (
      `Edge no significativo: WR ${rawWinRate.toFixed(1)}% (ajustado ${bayesianWinRate.toFixed(1)}%, IC 95%: ${ci}), ` +
      `p=${pValue.toFixed(3)}, BF₁₀=${bayesFactor.toFixed(2)} (${bfLabel}). ` +
      `Muestra insuficiente para confirmar edge. Se necesitan más datos.`
    );
  }

  if (significanceLevel === 'WEAK') {
    const direction = isPositiveEdge ? 'positivo débil' : isNegativeEdge ? 'negativo débil' : 'no confirmado';
    return (
      `Edge ${direction}: WR ${rawWinRate.toFixed(1)}% (ajustado ${bayesianWinRate.toFixed(1)}%, IC 95%: ${ci}), ` +
      `p=${pValue.toFixed(3)}, BF₁₀=${bayesFactor.toFixed(2)} (${bfLabel}). ` +
      `Significancia DÉBIL. Se necesitan más trades para confirmar. No operar con tamaño completo.`
    );
  }

  if (significanceLevel === 'MODERATE') {
    const direction = isPositiveEdge ? 'positivo moderado' : isNegativeEdge ? 'negativo moderado' : 'no confirmado';
    const action = isPositiveEdge
      ? 'Se puede operar con tamaño conservador.'
      : isNegativeEdge
        ? 'EVITAR este setup.'
        : 'Mantener observación.';
    return (
      `Edge ${direction}: WR ${rawWinRate.toFixed(1)}% (ajustado ${bayesianWinRate.toFixed(1)}%, IC 95%: ${ci}), ` +
      `p=${pValue.toFixed(4)}, BF₁₀=${bayesFactor.toFixed(2)} (${bfLabel}). ` +
      `Significancia MODERADA. ${action}`
    );
  }

  if (significanceLevel === 'STRONG') {
    const direction = isPositiveEdge ? 'positivo fuerte' : isNegativeEdge ? 'negativo fuerte' : 'neutro';
    const action = isPositiveEdge
      ? 'Edge operable con tamaño adecuado.'
      : isNegativeEdge
        ? 'NO operar este setup. Edge perdedor confirmado.'
        : 'No hay edge real.';
    return (
      `Edge ${direction}: WR ${rawWinRate.toFixed(1)}% (ajustado ${bayesianWinRate.toFixed(1)}%, IC 95%: ${ci}), ` +
      `p=${pValue.toFixed(4)}, BF₁₀=${bayesFactor.toFixed(2)} (${bfLabel}). ` +
      `Significancia FUERTE (${sampleSize} trades). ${action}`
    );
  }

  // VERY_STRONG
  const direction = isPositiveEdge ? 'positivo muy fuerte' : isNegativeEdge ? 'negativo muy fuerte' : 'neutro';
  const action = isPositiveEdge
    ? 'Edge altamente confiable. Operable con tamaño completo.'
    : isNegativeEdge
      ? 'EVITAR categóricamente. Edge perdedor altamente confirmado.'
      : 'No hay edge a pesar de la muestra grande.';
  return (
    `Edge ${direction}: WR ${rawWinRate.toFixed(1)}% (ajustado ${bayesianWinRate.toFixed(1)}%, IC 95%: ${ci}), ` +
    `p=${pValue.toFixed(5)}, BF₁₀=${bayesFactor.toFixed(2)} (${bfLabel}). ` +
    `Significancia MUY FUERTE (${sampleSize} trades). ${action}`
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Quick Bayesian Win Rate — optimized for the auto-trader hot path.
 * Returns only the posterior mean as a percentage (0-100).
 *
 * Posterior = Beta(α₀ + wins, β₀ + losses)
 * Posterior mean = (α₀ + wins) / (α₀ + β₀ + wins + losses)
 *
 * Examples with Beta(25, 25) prior:
 *   2 wins, 0 losses   → 27/52 ≈ 51.9%  (not 100%!)
 *   60 wins, 40 losses  → 85/150 ≈ 56.7%
 *   300 wins, 200 losses → 325/550 ≈ 59.1%
 */
export function quickBayesianWR(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 50; // No data → prior mean

  const posteriorMean = (PRIOR_ALPHA + wins) / (PRIOR_STRENGTH + n);
  return posteriorMean * 100;
}

/**
 * Full Bayesian statistical analysis of a setup's performance.
 *
 * This is the main function that provides complete statistical rigor.
 * Every number is computed from first principles — no shortcuts, no approximations
 * beyond the well-established ones documented below.
 *
 * @param wins   Number of winning trades
 * @param losses Number of losing trades
 * @returns      Complete BayesianResult with all metrics and interpretation
 */
export function calculateBayesianStats(wins: number, losses: number): BayesianResult {
  const n = wins + losses;

  // ── Raw Win Rate ──
  const rawWinRate = n > 0 ? (wins / n) * 100 : 0;

  // ── Bayesian Adjusted Win Rate ──
  // Posterior = Beta(α₀ + w, β₀ + l)
  // Posterior mean = (α₀ + w) / (α₀ + β₀ + w + l)
  const bayesianWR = quickBayesianWR(wins, losses);

  // ── 95% Confidence Interval (Wilson Score) ──
  const ciProportion = wilsonCI(wins, n, 1.96);
  const confidenceInterval = {
    lower: ciProportion.lower * 100,
    upper: ciProportion.upper * 100,
  };

  // ── P-value (Normal approximation to binomial) ──
  const pValue = computePValue(wins, n);

  // ── Bayes Factor BF10 ──
  const bayesFactor = computeBayesFactor(wins, losses);

  // ── Sample Variance ──
  const sampleVariance = computeSampleVariance(wins, losses);

  // ── Statistical Significance Level ──
  const significanceLevel = computeSignificanceLevel(n, pValue);

  // ── Build result ──
  const result: Omit<BayesianResult, 'interpretation'> = {
    rawWinRate: Math.round(rawWinRate * 100) / 100,
    bayesianWinRate: Math.round(bayesianWR * 100) / 100,
    confidenceInterval: {
      lower: Math.round(confidenceInterval.lower * 100) / 100,
      upper: Math.round(confidenceInterval.upper * 100) / 100,
    },
    pValue: Math.round(pValue * 100000) / 100000,
    bayesFactor: Math.round(bayesFactor * 100) / 100,
    sampleVariance,
    significanceLevel,
    sampleSize: n,
    wins,
    losses,
  };

  // ── Spanish Interpretation ──
  const interpretation = generateInterpretation(result);

  return {
    ...result,
    interpretation,
  };
}

// ─── Utility: Batch Analysis ──────────────────────────────────────────────────

/**
 * Compare two setups using Bayesian analysis.
 * Returns which setup has stronger evidence for a positive edge.
 */
export function compareSetups(
  setupA: { wins: number; losses: number },
  setupB: { wins: number; losses: number }
): {
  preferred: 'A' | 'B' | 'NEITHER';
  reason: string;
  statsA: BayesianResult;
  statsB: BayesianResult;
} {
  const statsA = calculateBayesianStats(setupA.wins, setupA.losses);
  const statsB = calculateBayesianStats(setupB.wins, setupB.losses);

  // Compare using a composite score: Bayesian WR * significance weight
  const significanceWeight = (level: string): number => {
    switch (level) {
      case 'VERY_STRONG': return 1.0;
      case 'STRONG': return 0.8;
      case 'MODERATE': return 0.6;
      case 'WEAK': return 0.3;
      case 'INSUFFICIENT': return 0.1;
      default: return 0;
    }
  };

  const scoreA = statsA.bayesianWinRate * significanceWeight(statsA.significanceLevel);
  const scoreB = statsB.bayesianWinRate * significanceWeight(statsB.significanceLevel);

  const preferred = scoreA > scoreB ? 'A' : scoreB > scoreA ? 'B' : 'NEITHER';

  let reason: string;
  if (preferred === 'NEITHER') {
    reason = 'Ambos setups tienen score similar. No hay suficiente diferencia para preferir uno.';
  } else {
    const winner = preferred === 'A' ? statsA : statsB;
    const loser = preferred === 'A' ? statsB : statsA;
    reason = `Setup ${preferred} preferido: WR bayesiano ${winner.bayesianWinRate.toFixed(1)}% ` +
      `vs ${loser.bayesianWinRate.toFixed(1)}%, significancia ${winner.significanceLevel} ` +
      `vs ${loser.significanceLevel}.`;
  }

  return { preferred, reason, statsA, statsB };
}

/**
 * Compute the minimum sample size needed to detect a given edge
 * with specified statistical power.
 *
 * Uses the normal approximation for sample size calculation.
 *
 * @param targetWR  The win rate you want to detect (0-100)
 * @param alpha     Significance level (default 0.05)
 * @param power     Statistical power (default 0.80)
 * @returns         Minimum number of trades needed
 */
export function minimumSampleSize(
  targetWR: number,
  alpha: number = 0.05,
  power: number = 0.80
): number {
  const p1 = targetWR / 100;
  const p0 = 0.5;

  // Z-scores for alpha and power
  const zAlpha = inverseNormalCDF(1 - alpha / 2);
  const zBeta = inverseNormalCDF(power);

  // Sample size formula for one-sample proportion test
  // n = ((z_α/2 * √(p0(1-p0)) + z_β * √(p1(1-p1))) / (p1 - p0))²
  const numerator =
    zAlpha * Math.sqrt(p0 * (1 - p0)) + zBeta * Math.sqrt(p1 * (1 - p1));
  const denominator = p1 - p0;

  if (Math.abs(denominator) < 0.001) return Infinity; // Can't distinguish from 50%

  return Math.ceil((numerator / denominator) ** 2);
}

/**
 * Approximate inverse of the standard normal CDF (quantile function).
 * Uses rational approximation by Peter Acklam.
 * Accurate to about 1.15e-9 in absolute value.
 */
function inverseNormalCDF(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p === 0.5) return 0;

  // Coefficients for rational approximation
  const a = [
    -3.969683028665376e1,
    2.209460984245205e2,
    -2.759285104469687e2,
    1.383577518672690e2,
    -3.066479806614716e1,
    2.506628277459239e0,
  ];

  const b = [
    -5.447609879822406e1,
    1.615858368580409e2,
    -1.556989798598866e2,
    6.680131188771972e1,
    -1.328068155288572e1,
  ];

  const c = [
    -7.784894002430293e-3,
    -3.223964580411365e-1,
    -2.400758277161838e0,
    -2.549732539343734e0,
    4.374664141464968e0,
    2.938163982698783e0,
  ];

  const d = [
    7.784695709041462e-3,
    3.224671290700398e-1,
    2.445134137142996e0,
    3.754408661907416e0,
  ];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  let q: number, r: number;

  if (p < pLow) {
    // Rational approximation for lower region
    q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  } else if (p <= pHigh) {
    // Rational approximation for central region
    q = p - 0.5;
    r = q * q;
    return (
      (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  } else {
    // Rational approximation for upper region
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
}

/**
 * Compute the posterior probability that the true win rate exceeds a threshold.
 * Uses the Beta-Binomial posterior.
 *
 * P(WR > threshold | data) = 1 - I_threshold(α₀+w, β₀+l)
 *
 * where I_x is the regularized incomplete beta function.
 *
 * @param wins      Number of wins
 * @param losses    Number of losses
 * @param threshold Threshold win rate as percentage (0-100), default 50%
 * @returns         Probability (0-1) that true WR exceeds threshold
 */
export function posteriorProbAboveThreshold(
  wins: number,
  losses: number,
  threshold: number = 50
): number {
  const n = wins + losses;
  if (n === 0) {
    // Prior probability: P(WR > threshold | no data)
    // For Beta(25,25), this is 1 - I_threshold(25, 25)
    return 1 - incompleteBeta(threshold / 100, PRIOR_ALPHA, PRIOR_BETA);
  }

  const a = PRIOR_ALPHA + wins;
  const b = PRIOR_BETA + losses;
  const x = threshold / 100;

  return 1 - incompleteBeta(x, a, b);
}

/**
 * Compute the Expected Value (EV) of a setup in risk-adjusted terms.
 * Uses Bayesian WR and accounts for sample size uncertainty.
 *
 * EV = (bayesianWR/100 * avgWin) - ((1 - bayesianWR/100) * avgLoss)
 *
 * If avgWin/avgLoss not provided, assumes 1:1 risk-reward (pure WR model).
 *
 * @param wins     Number of wins
 * @param losses   Number of losses
 * @param avgWin   Average winning trade value (default 1)
 * @param avgLoss  Average losing trade value (default 1)
 * @returns        Expected value per trade (positive = profitable)
 */
export function expectedValue(
  wins: number,
  losses: number,
  avgWin: number = 1,
  avgLoss: number = 1
): number {
  const bayesianWR = quickBayesianWR(wins, losses) / 100;
  return bayesianWR * avgWin - (1 - bayesianWR) * avgLoss;
}

/**
 * Kelly Criterion: Optimal fraction of bankroll to risk.
 * Uses Bayesian-adjusted win rate for more conservative sizing.
 *
 * f* = (p*b - q) / b
 * where p = Bayesian WR, q = 1-p, b = reward/risk ratio
 *
 * @param wins      Number of wins
 * @param losses    Number of losses
 * @param rewardRisk Average reward-to-risk ratio (default 1.5)
 * @returns         Optimal fraction of bankroll to risk (0-1, can be negative)
 */
export function kellyFraction(
  wins: number,
  losses: number,
  rewardRisk: number = 1.5
): number {
  const p = quickBayesianWR(wins, losses) / 100;
  const q = 1 - p;
  return (p * rewardRisk - q) / rewardRisk;
}
