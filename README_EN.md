# Macro Portfolio Prototype

中文版: [README.md](README.md)

A local macro quant research workbench. The current version splits the research workflow into 5 sequential stages:

1. `providers`: fetch raw macro and asset data
2. `data`: align timestamps, engineer features, and build the asset return panel
3. `regime`: generate state / signal outputs
4. `policy`: build the portfolio and apply a risk overlay
5. `backtest`: run walk-forward backtests, metrics, and benchmark comparisons

This project is not just a collection of notebooks. It is a research framework with `run_id`, stage-level artifacts, logs, APIs, and a browser-based workbench. Every experiment is stored under `runs/<run_id>/` so results remain traceable and comparable.

## 1. What This Is For

This project is suitable for:

- macro state-driven multi-asset allocation
- dual-region US / China growth-inflation research
- selecting a research window and input variables before handing filtered data to downstream models
- trying multiple portfolio construction and risk overlays on top of the same signal layer
- iterating on customized local strategy research before building a heavier execution stack

The built-in tradable universe is currently the core 9 assets:

- `SPY`
- `QQQ`
- `TLT`
- `GLD`
- `DBC`
- `BTC`
- `CSI300`
- `STAR50`
- `CGB`

The custom A-share / HK stock / US stock entries added on page 1 can already flow into data browsing and parts of the feature-input path, but they are not yet part of the default tradable universe on pages 4 and 5.

## 2. Quick Start

Start the local workbench:

```bash
cd /path/to/macro-portfolio-prototype
PYTHONPATH=src python scripts/run_lab_api.py
```

Then open:

- `http://127.0.0.1:8010/`

Run tests:

```bash
PYTHONPATH=src pytest
```

If the repository already contains a local virtual environment, you can also use:

```bash
PYTHONPATH=src ./venv/bin/python scripts/run_lab_api.py
PYTHONPATH=src ./venv/bin/python -m pytest
```

## 3. Top-Level Architecture

The system is split into 4 layers.

### 3.1 UI / API Layer

- frontend pages live in `src/macro_portfolio/api/static/`
- the FastAPI entrypoint is `src/macro_portfolio/api/app.py`
- pages are stage-based and map directly to backend stage endpoints

### 3.2 Pipeline Orchestration Layer

- `src/macro_portfolio/services/pipeline.py`
- `PipelineService` orchestrates the full workflow
- each stage is responsible for:
  - checking upstream stage success
  - reading upstream artifacts
  - producing its own artifacts / summary / log
  - updating `run.json`

### 3.3 Research Model Layer

- `src/macro_portfolio/data.py`: alignment and feature engineering
- `src/macro_portfolio/regime.py` + `src/macro_portfolio/models/regime/`: state recognition
- `src/macro_portfolio/policy.py` + `src/macro_portfolio/models/policy/`: portfolio construction
- `src/macro_portfolio/models/risk/`: risk overlays
- `src/macro_portfolio/backtest.py`: walk-forward backtest engine

### 3.4 Experiment Storage Layer

- `src/macro_portfolio/engine/run_store.py`
- `src/macro_portfolio/engine/artifacts.py`
- one `run_id` per experiment
- one directory per stage
- each directory stores `csv/json` artifacts
- stage logs are stored in `logs/<stage>.log`

## 4. Principles Behind the Five Stages

## 4.1 Stage 1: Data Acquisition `providers`

### Principle

This stage solves two problems:

- where raw data comes from
- how raw data should be organized for research

Instead of immediately collapsing everything into one large table, it first splits raw data into 4 base datasets:

- `us_macro.csv`
- `cn_macro.csv`
- `global_prices.csv`
- `cn_assets.csv`

This design matters because:

- macro data and price data have very different frequencies, release calendars, and missing-value patterns
- China assets need extra FX handling later
- the UI needs research context such as which item was fetched, from which source, and with what coverage

### Supported data sources

- `FRED`
- `Stooq`
- `Yahoo Finance`
- `Binance`
- `Akshare`
- `OpenBB` (optional)

### What this stage does

- fetches data item by item instead of forcing full-batch refreshes
- supports custom A-share / HK stock / US stock inputs
- records per-item metadata:
  - label
  - source
  - artifact
  - column
  - start / end
  - rows / non_null
  - frequency

### Outputs

- `providers/us_macro.csv`
- `providers/cn_macro.csv`
- `providers/global_prices.csv`
- `providers/cn_assets.csv`
- `providers/catalog.json`

## 4.2 Stage 2: Data Processing `data`

### Principle

This stage answers: what data is actually visible at each research timestamp?

It does 3 core things:

1. align mixed-frequency data to a monthly research grid
2. apply region-specific release lags to avoid lookahead bias
3. turn raw series into model-ready features and asset return panels

### Key implementation

`MacroDataset.build_feature_table(...)` applies:

- month-end alignment
- deduplication
- `ffill`
- region-level lagging
- feature engineering

Each raw series currently produces:

- `*_level`
- `*_mom`
- `*_yoy`
- `*_z`
- `*_pct`

`MacroDataset.build_asset_panel(...)` handles:

- monthly return calculation
- converting China assets from CNY research pricing into USD research pricing
- building a unified asset panel

### Why data selection is a formal step

Page 2 is not only for browsing. It is also the formal handoff layer to downstream stages.

At this stage you can filter both:

- the time window
- the set of series handed to stage 3

After applying the selection, the system writes explicit downstream inputs instead of only storing temporary frontend state.

### Data selection logic

- `display_series_ids`: the raw series you checked on page 2
- `feature_columns`: the actual feature columns mapped from those raw series
- `selected_series.csv`: filtered raw display series within the selected window
- `selected_features.csv`: processed features actually passed to stage 3
- `selected_asset_returns.csv` / `selected_asset_panel.csv`: synchronized slices of returns and asset panel

The aggregate missing-rate shown in the UI reflects:

- the series you selected
- inside the currently selected window
- observed cells / expected cells

### Outputs

- `data/features.csv`
- `data/asset_returns.csv`
- `data/asset_panel.csv`
- `data/summary.json`
- `data/selection.json`
- `data/selected_series.csv`
- `data/selected_features.csv`
- `data/selected_asset_returns.csv`
- `data/selected_asset_panel.csv`

## 4.3 Stage 3: State Recognition `regime`

### Principle

This stage is effectively the signal layer. The UI is still labeled “state recognition”, but architecturally it already acts as the downstream signal provider.

Default input source:

- if stage 2 selection has been applied, it uses `selected_features.csv`
- otherwise it uses the full `features.csv`

### Built-in models

- `rule_based`
- `kmeans`
- `gmm`

### Rule-based model logic

The rule-based model works in two steps:

1. `RegionalRegimeModel`
   - computes growth / inflation scores separately for the US and China
   - maps them into region-level quadrant states
2. `PortfolioRegimeAggregator`
   - aggregates regional states into portfolio-level states
   - outputs a portfolio regime and a confidence score

Current portfolio-level states:

- `global_easing_growth`
- `reflation`
- `disinflationary_slowdown`
- `stagflation_pressure`
- `china_recovery_us_weak`

### Why outputs are materialized

Page 4 should not refit the state model. It should consume a stable and explicit signal artifact.

### Outputs

- `regime/regime.csv`
- `regime/diagnostics.json`
- `regime/summary.json`

## 4.4 Stage 4: Strategy Decision `policy`

### Principle

This stage is no longer just one opaque `policy`. It is split into two layers:

1. `portfolio_model`
2. `risk_model`

This is a much better pattern for future quant research. When customized strategies are added later, you can swap only the portfolio construction layer or only the risk layer instead of rewriting the whole stage.

### Portfolio construction layer `portfolio_model`

Current built-ins:

- `template_rule`
- `risk_parity`
- `cvar`

The core class is `PortfolioPolicy`, which does the following:

- switches template weights by state
- applies asset- and regime-specific bounds
- solves an objective combining `CVaR + tracking + turnover`
- falls back to risk parity if optimization fails
- applies US / China equity caps
- filters very small trades

### Risk overlay layer `risk_model`

Current built-ins:

- `none`
- `confidence_guard`
- `vol_target`

Both active risk overlays follow the same idea: shift capital from risk assets into defensive assets.

- `confidence_guard`
  - reduces risky exposure when regime confidence drops below a threshold
- `vol_target`
  - reduces risky exposure when realized portfolio volatility exceeds a target

### Why raw and final weights are both stored

From a research perspective, it is important to separate:

- what the portfolio construction layer wanted to hold
- how much the risk overlay changed afterward

So the system stores both:

- `weights_target_raw.csv`
- `weights_target.csv`

### Outputs

- `policy/weights_target_raw.csv`
- `policy/weights_target.csv`
- `policy/strategy_manifest.json`
- `policy/summary.json`

## 4.5 Stage 5: Backtest Analysis `backtest`

### Principle

This stage runs a monthly walk-forward backtest.

The core loop is:

1. at each month `t`
2. use the previous `training_window` months of returns as history
3. read the signal at month `t`
4. generate target weights through `portfolio_model + risk_model`
5. compute monthly return, turnover, and transaction cost
6. update NAV and the weight history

### Key design choices

- the backtest consumes the full strategy stack, not only the optimizer
- transaction costs are charged on turnover
- outputs include:
  - `nav`
  - `weights`
  - `benchmarks`
  - `attribution`
  - `metrics`

### Current benchmarks

- `permanent_portfolio`
- `sixty_forty`
- `risk_parity_static`

### Outputs

- `backtest/nav.csv`
- `backtest/weights.csv`
- `backtest/benchmarks.csv`
- `backtest/attribution.csv`
- `backtest/metrics.json`
- `backtest/strategy_manifest.json`
- `backtest/summary.json`

## 5. Data Flow and Artifact Flow

The end-to-end workflow can be read as a stateful artifact pipeline:

```text
providers
  -> us_macro.csv / cn_macro.csv / global_prices.csv / cn_assets.csv
  -> data
      -> features.csv / asset_returns.csv / asset_panel.csv
      -> optional selection
          -> selected_series.csv / selected_features.csv / selected_asset_returns.csv / selected_asset_panel.csv
      -> regime
          -> regime.csv
          -> policy
              -> weights_target_raw.csv / weights_target.csv
              -> backtest
                  -> nav.csv / weights.csv / metrics.json / benchmarks.csv / attribution.csv
```

If a stage 2 selection has been applied, downstream stages prefer the selected artifacts.

## 6. Run Directory Layout

Every experiment is stored under `runs/<run_id>/`.

A typical layout looks like this:

```text
runs/<run_id>/
  run.json
  logs/
    providers.log
    data.log
    regime.log
    policy.log
    backtest.log
  providers/
    us_macro.csv
    cn_macro.csv
    global_prices.csv
    cn_assets.csv
    catalog.json
  data/
    features.csv
    asset_returns.csv
    asset_panel.csv
    summary.json
    selection.json
    selected_series.csv
    selected_features.csv
    selected_asset_returns.csv
    selected_asset_panel.csv
  regime/
    regime.csv
    diagnostics.json
    summary.json
  policy/
    weights_target_raw.csv
    weights_target.csv
    strategy_manifest.json
    summary.json
  backtest/
    nav.csv
    weights.csv
    benchmarks.csv
    attribution.csv
    metrics.json
    strategy_manifest.json
    summary.json
```

## 7. Code Layout

Core directories:

```text
src/macro_portfolio/
  api/
    app.py                 # FastAPI entrypoint
    static/                # frontend workbench
  engine/
    artifacts.py           # csv/json I/O
    run_store.py           # run metadata and logs
    schemas.py             # API request models
  models/
    regime/                # state recognition models
    policy/                # portfolio construction models
    risk/                  # risk overlay models
  services/
    pipeline.py            # 5-stage orchestration
    registry.py            # model registry
  data.py                  # alignment and feature engineering
  providers.py             # data-source adapters
  regime.py                # rule-based regime logic
  policy.py                # portfolio construction core
  backtest.py              # backtest engine
  live.py                  # default asset universe and live-pipeline helpers
```

## 8. Extension Pattern

The current architecture is designed to preserve room for future customized strategies.

### 8.1 Add a new regime model

Add the model under `src/macro_portfolio/models/regime/` and register it in `services/registry.py`.

Natural future directions:

- more advanced clustering
- hidden Markov models
- supervised signal models
- factor-scoring models

### 8.2 Add a new portfolio construction model

Add the model under `src/macro_portfolio/models/policy/` and register it in `services/registry.py`.

Suitable future additions:

- Black-Litterman
- mean-variance
- hierarchical risk parity
- tracking-error constrained optimizers

### 8.3 Add a new risk overlay

Add the model under `src/macro_portfolio/models/risk/`.

Suitable future additions:

- drawdown guard
- exposure cap
- macro veto
- liquidity filter

### 8.4 Custom tradable universes

The current tradable universe comes from `DEFAULT_ASSETS` in `live.py`. If custom stocks are later promoted into pages 4 and 5, the separation between research series and tradable assets will need to be made more explicit.

## 9. API Examples

Create a new run:

```bash
curl -X POST http://127.0.0.1:8010/api/runs \
  -H 'Content-Type: application/json' \
  -d '{"label":"research run"}'
```

Fetch raw data:

```bash
curl -X POST http://127.0.0.1:8010/api/runs/<run_id>/providers \
  -H 'Content-Type: application/json' \
  -d '{
    "start_date":"2018-01-01",
    "end_date":"2026-03-17"
  }'
```

Run data processing:

```bash
curl -X POST http://127.0.0.1:8010/api/runs/<run_id>/data \
  -H 'Content-Type: application/json' \
  -d '{
    "us_release_lag":1,
    "cn_release_lag":0,
    "global_release_lag":1,
    "z_window":36
  }'
```

Apply a page-2 selection:

```bash
curl -X POST http://127.0.0.1:8010/api/runs/<run_id>/data/selection \
  -H 'Content-Type: application/json' \
  -d '{
    "start_date":"2020-01-31",
    "end_date":"2024-12-31",
    "display_series_ids":["us_macro::cpi","cn_macro::pmi","global_prices::SPY"]
  }'
```

Run state recognition:

```bash
curl -X POST http://127.0.0.1:8010/api/runs/<run_id>/regime \
  -H 'Content-Type: application/json' \
  -d '{
    "model_name":"rule_based",
    "smoothing_window":3,
    "n_states":4
  }'
```

Run portfolio construction:

```bash
curl -X POST http://127.0.0.1:8010/api/runs/<run_id>/policy \
  -H 'Content-Type: application/json' \
  -d '{
    "model_name":"cvar",
    "portfolio_model":"cvar",
    "risk_model":"confidence_guard",
    "execution_model":"immediate",
    "training_window":60,
    "transaction_cost_bps":5.0,
    "overrides":{}
  }'
```

Run backtest:

```bash
curl -X POST http://127.0.0.1:8010/api/runs/<run_id>/backtest \
  -H 'Content-Type: application/json' \
  -d '{
    "model_name":"cvar",
    "portfolio_model":"cvar",
    "risk_model":"vol_target",
    "execution_model":"immediate",
    "training_window":60,
    "transaction_cost_bps":5.0,
    "overrides":{}
  }'
```

## 10. Data Source Configuration

### Usually no key required

- Stooq ETF prices
- Binance BTC history
- Akshare China macro and asset data
- OpenBB if installed locally

### Key you will likely need

- `FRED_API_KEY`

Set it in your shell:

```bash
export FRED_API_KEY="your_fred_key"
```

Or place it in a git-ignored `.env.secrets` file:

```bash
FRED_API_KEY=your_fred_key
```

## 11. Current Limitations

- the tradable universe on pages 4 and 5 is still fixed to the core 9 assets
- the execution layer is currently only `immediate`; more detailed slippage / liquidity / matching models are not implemented yet
- after stage 2 selection, display-only series are preserved in handoff metadata but do not directly enter the regime model
- current backtesting frequency is monthly, not daily or event-driven

## 12. Design Direction

At this stage, the project is intentionally closer to a macro quant research workbench than a production trading system.

The main design priorities are:

- a clear research chain
- fully traceable steps
- strict consistency between data selection and downstream inputs
- pluggable model layers
- low-friction local experimentation

Once the research workflow stabilizes, the live / execution layer can be made heavier.
