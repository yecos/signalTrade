---
Task ID: 1
Agent: Main
Task: Fix backtest v8 bugs + update strategy presets based on backtest findings

Work Log:
- Analyzed backtest v8.1 results: Mean Reversion ETHUSDT 1h is the only legitimate winner (PF 2.32, WR 62.3%, Sharpe 6.04)
- Funding arb: $0.00 prices partially fixed in v8.1 (Binance price matching), but strategy still has no edge (0% WR)
- Grid trading: v8.1 now shows realistic results with underwater positions and global stop-loss
- Updated Mean Reversion default config: timeframe M15 → H1 (backtest proven)
- Updated all strategy presets: disable funding arb (no edge), prioritize MR ETH H1 + Grid ETH
- Pushed changes to GitHub (commit a02bd26)

Stage Summary:
- Mean Reversion ETHUSDT 1H is the key strategy with genuine edge
- Funding Arb disabled in all presets (no edge in backtest)
- Grid Trading ETH is secondary strategy (PF 3.17 but with range break risk)
- All changes pushed to GitHub successfully
