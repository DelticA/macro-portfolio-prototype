# Macro Portfolio Prototype

Rule-based, macro regime-aware portfolio construction prototype for a mixed US/China asset universe.

Core modules:
- `MacroDataset`: aligns macro releases, engineers monthly features, and converts local asset returns into a USD research view.
- `RegionalRegimeModel`: estimates US and China growth/inflation scores and regional regimes.
- `PortfolioRegimeAggregator`: maps regional signals into a portfolio-level regime.
- `PortfolioPolicy`: applies regime-specific bounds and solves either a CVaR-style or risk-parity allocation.
- `BacktestEngine`: runs walk-forward monthly backtests with benchmarks and attribution outputs.
- `providers`: connects the prototype to FRED, Stooq, Binance, Akshare, and optional OpenBB.

Run tests:

```bash
PYTHONPATH=src pytest
```

## Macro Portfolio Lab 2.0

2.0 adds a step-by-step research workbench on top of the original pipeline. It is designed for quant research, so every stage keeps its own artifacts, logs, previews, and configuration inside `runs/<run_id>/`.

Main ideas:
- each experiment gets a dedicated `run_id`
- each stage writes artifacts under its own folder
- the backend exposes separate endpoints for `providers`, `data`, `regime`, `policy`, and `backtest`
- regime and policy models now have pluggable adapters, so clustering and ML models can be added without rewriting the UI

Start the local lab API:

```bash
PYTHONPATH=src python3 -m uvicorn macro_portfolio.api.app:app --host 127.0.0.1 --port 8010
```

Then open:

- [http://127.0.0.1:8010/](http://127.0.0.1:8010/)

Current built-in models:
- Regime:
  - `rule_based`
  - `kmeans`
  - `gmm`
- Policy:
  - `template_rule`
  - `risk_parity`
  - `cvar`

Example API flow:

```bash
curl -X POST http://127.0.0.1:8010/api/runs -H 'Content-Type: application/json' -d '{"label":"research run"}'
curl -X POST http://127.0.0.1:8010/api/runs/<run_id>/providers -H 'Content-Type: application/json' -d '{"start_date":"2018-01-01","end_date":"2026-03-17"}'
curl -X POST http://127.0.0.1:8010/api/runs/<run_id>/data -H 'Content-Type: application/json' -d '{}'
curl -X POST http://127.0.0.1:8010/api/runs/<run_id>/regime -H 'Content-Type: application/json' -d '{"model_name":"rule_based"}'
curl -X POST http://127.0.0.1:8010/api/runs/<run_id>/policy -H 'Content-Type: application/json' -d '{"model_name":"cvar"}'
curl -X POST http://127.0.0.1:8010/api/runs/<run_id>/backtest -H 'Content-Type: application/json' -d '{"model_name":"cvar"}'
```

## Real Data Setup

### Free / no-key by default
- Stooq ETF prices: no key.
- Binance BTC monthly prices: no key.
- Akshare China index / ETF prices: no key after local install.
- OpenBB: optional local dependency, no key needed if you use its `yfinance` provider.

### Keys you likely need
- `FRED_API_KEY`
  - Get it from: https://fred.stlouisfed.org/docs/api/api_key.html
  - Set it in your shell:

```bash
export FRED_API_KEY="your_fred_key"
```

Or keep it in a git-ignored file named `.env.secrets`:

```bash
FRED_API_KEY=your_fred_key
```

### What is implemented
- `FredClient.fetch_series(...)`: US macro from FRED.
- `StooqClient.fetch_close_prices(...)`: overseas ETF and commodity proxies.
- `BinanceClient.fetch_btc_prices(...)`: BTC monthly history.
- `AkshareClient.fetch_cn_assets(...)`: China ETF proxy prices via `fund_etf_hist_sina`.
- `AkshareClient.fetch_cn_macro(...)`: China macro series via Akshare release-date datasets.
- `YahooFinanceClient.fetch_close_prices(...)`: still available as an adapter, but not the default path.
- `OpenBBClient`: optional adapter for FRED and Yahoo-backed price history.
- `ResearchDataLoader.load_cn_assets(...)`: default China asset loader via Akshare.
- `ResearchDataLoader.load_default_cn_macro(...)`: default China macro loader via Akshare.
- `scripts/run_live_pipeline.py`: one command to fetch raw data and optionally run the whole backtest.

### Example

```python
from macro_portfolio import ResearchDataLoader

loader = ResearchDataLoader()
us_macro = loader.load_default_us_macro(start_date="2010-01-01")
market_prices = loader.load_default_market_prices(start_date="2010-01-01")
cn_prices = loader.load_cn_assets(
    csi300_code="510300.SH",
    star50_code="588000.SH",
    cgb_code="511010.SH",
    start_date="2010-01-01",
    end_date="2026-03-17",
)
```

默认中国资产代理现在使用 ETF 路线：`510300.SH`、`588000.SH`、`511010.SH`。

### Full pipeline

If you already have `FRED_API_KEY`, you can fetch raw data and run the full pipeline with:

```bash
PYTHONPATH=src python3 scripts/run_live_pipeline.py \
  --start-date 2012-01-01 \
  --end-date 2026-03-17
```
China macro now uses Akshare release-date series by default. That means a February reading published in March only becomes visible to the strategy at March month-end.
