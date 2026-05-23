# SignalTrader Pro

**Motor Cuantitativo Experimental** para registro y verificación de señales de trading.

> EL DATASET ES EL ACTIVO. No operamos sin edge. NO_OPERAR > operar sin edge.

## Stack

| Componente | Tecnología | Plan |
|---|---|---|
| Frontend | Next.js + Tailwind + shadcn/ui | Vercel Hobby (gratis) |
| Base de Datos | Turso (libSQL) | 5GB gratis |
| Auth | Supabase Auth (futuro) | 50K usuarios gratis |
| Storage | Supabase Storage (futuro) | 1GB gratis |
| Datos Crypto | Binance WebSocket | Gratis |
| Datos Forex | Twelve Data + Finnhub | Free tier |
| Deploy | Vercel | Hobby gratis |

## Arquitectura

```
Vercel → Next.js App → API Routes → Turso DB
                                    ↕
                          Signal Engine
                          Learning Engine
                          Market Data Engine
                          Dashboard
```

## Motores

1. **Market Data Engine** — Datos de mercado (Binance, TwelveData, Finnhub)
2. **Indicators Engine** — RSI, MACD, Bollinger, ATR, EMA, Stochastic, ADX
3. **Pattern Engine** — Breakout, Liquidity Sweep, Engulfing, Fakeout, Reversal
4. **Session Engine** — Asia, London, New York, Overlap
5. **Regime Detection** — TRENDING, RANGING, VOLATILE, LOW_VOL, NEWS, LIQUIDITY_TRAP
6. **Bayesian Stats** — Confidence intervals, adjusted WR, p-values
7. **Expectancy Engine** — EV = (Win% × AvgWin) - (Loss% × AvgLoss)
8. **Quality Filter** — Block low liquidity, high spread, toxic volatility
9. **Feature Engineering** — 20+ features per signal
10. **Auto-Trader** — Data Collection Mode with 24/7 signal generation

## Setup Rápido

### 1. Clonar e instalar

```bash
git clone https://github.com/yecos/signalTrade.git
cd signalTrade
bun install
```

### 2. Configurar base de datos

**Opción A: SQLite local (desarrollo)**

```bash
cp .env.example .env
npx prisma db push
npx prisma generate
```

**Opción B: Turso (producción)**

```bash
# Instalar Turso CLI
curl -sSfL https://get.tur.so/install.sh | bash
turso auth login

# Crear base de datos
turso db create signaltrader-pro --enable-wal

# Obtener credenciales
turso db show signaltrader-pro --url    # → TURSO_DATABASE_URL
turso db tokens create signaltrader-pro  # → TURSO_AUTH_TOKEN

# Agregar a .env
echo "TURSO_DATABASE_URL=libsql://..." >> .env
echo "TURSO_AUTH_TOKEN=eyJhbG..." >> .env

# Push schema
npx prisma db push
```

### 3. Configurar APIs de mercado (opcional)

```bash
# En .env, agregar:
TWELVEDATA_API_KEY=tu_key
FINNHUB_API_KEY=tu_key
# Binance no requiere API key para WebSocket público
```

### 4. Ejecutar

```bash
bun dev
# → http://localhost:3000
```

## Deploy en Vercel

1. Push a GitHub
2. Conectar repo en [vercel.com](https://vercel.com)
3. Agregar environment variables:
   - `TURSO_DATABASE_URL`
   - `TURSO_AUTH_TOKEN`
   - `DATABASE_URL` = `file:./db/custom.db` (para build)
4. Deploy automático

## Filosofía

- **DATA FIRST**: El dataset es el activo más valioso. Cada señal guarda 20+ features.
- **STATS OVER AI**: No usamos LLMs hasta tener 5000+ señales limpias. Prioridad: estadística.
- **TRANSPARENCIA TOTAL**: Si no hay edge, decimos NO HAY EDGE. Si la muestra es pequeña, lo indicamos.
- **NO_OPERAR > OPERAR SIN EDGE**: Pensamiento institucional. Proteger el capital.

## Roadmap Estadístico

- [x] Registro de señales con verificación automática
- [x] Pattern Engine (6 patrones con lógica matemática)
- [x] Session Engine (4 sesiones + overlap)
- [x] Regime Detection (6 regímenes de mercado)
- [x] Bayesian Stats (CI, p-value, adjusted WR)
- [x] Expectancy Engine (EV, risk/reward)
- [x] Quality Filter (liquidez, spread, volatilidad)
- [x] Feature Engineering (20+ variables por señal)
- [ ] 1000+ señales recolectadas → activar modo estricto
- [ ] Feature Importance (qué variables importan más)
- [ ] Monte Carlo Simulation
- [ ] Walk-Forward Testing
- [ ] Ensemble Models (solo con dataset suficiente)
- [ ] Reinforcement Learning (solo con 5000+ señales)

## Límites del Free Tier

| Servicio | Límite | Suficiente para |
|---|---|---|
| Turso | 5GB storage | ~1M señales |
| Vercel Hobby | 100GB bandwidth, 1000hr/serverless | MVP completo |
| Supabase Auth | 50K MAU | Miles de usuarios |
| Twelve Data | 800 req/día | Forex data |
| Finnhub | 60 calls/min | Stock/Forex data |
| Binance WS | Sin límite (público) | Crypto real-time |
