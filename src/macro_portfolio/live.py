from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from .backtest import BacktestEngine
from .data import MacroDataset
from .policy import PolicyConfig, PortfolioPolicy
from .providers import ResearchDataLoader
from .regime import PortfolioRegimeAggregator, RegionalRegimeModel
from .types import AssetConfig


DEFAULT_ASSETS = [
    AssetConfig("SPY", "US", "risk_core"),
    AssetConfig("QQQ", "US", "satellite"),
    AssetConfig("TLT", "US", "defensive"),
    AssetConfig("GLD", "US", "defensive"),
    AssetConfig("DBC", "US", "satellite"),
    AssetConfig("BTC", "US", "satellite", max_weight=0.10),
    AssetConfig("CSI300", "CN", "risk_core"),
    AssetConfig("STAR50", "CN", "satellite"),
    AssetConfig("CGB", "CN", "defensive"),
]


@dataclass
class LivePipelineConfig:
    start_date: str
    end_date: str
    csi300_code: str = "510300.SH"
    star50_code: str = "588000.SH"
    cgb_code: str = "511010.SH"
    output_dir: str = "data/live_run"
    fred_api_key: str | None = None


def run_live_pipeline(config: LivePipelineConfig) -> dict[str, Path]:
    output_dir = Path(config.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    loader = ResearchDataLoader()
    if config.fred_api_key:
        loader.fred = loader.fred or None
        from .providers import FredClient

        loader.fred = FredClient(api_key=config.fred_api_key)
    us_macro = loader.load_default_us_macro(config.start_date, config.end_date)["US"]
    cn_macro = loader.load_default_cn_macro()["CN"]
    market_prices = loader.load_default_market_prices(config.start_date, config.end_date)
    cn_assets = loader.load_cn_assets(
        csi300_code=config.csi300_code,
        star50_code=config.star50_code,
        cgb_code=config.cgb_code,
        start_date=config.start_date,
        end_date=config.end_date,
    )

    paths = {
        "us_macro": _write_csv(us_macro, output_dir / "us_macro.csv"),
        "cn_macro": _write_csv(cn_macro, output_dir / "cn_macro.csv"),
        "market_prices": _write_csv(market_prices, output_dir / "global_prices.csv"),
        "cn_assets": _write_csv(cn_assets, output_dir / "cn_assets.csv"),
    }

    full_prices = pd.concat(
        [
            market_prices.drop(columns=["USDCNY"], errors="ignore"),
            cn_assets,
        ],
        axis=1,
    ).sort_index()
    usdcny = market_prices["USDCNY"].dropna()
    cnyusd = (1 / usdcny).rename("CNYUSD")
    fx_returns = cnyusd.resample("ME").last().pct_change()

    dataset = MacroDataset(
        release_lag_months={"US": 1, "CN": 0, "GLOBAL": 1, "default": 1},
        release_date_regions=frozenset({"CN"}),
    )
    us_macro = us_macro.resample("ME").last()
    features = dataset.build_feature_table({"US": us_macro, "CN": cn_macro})
    regional = RegionalRegimeModel().fit_transform(features)
    regime_table = PortfolioRegimeAggregator().transform(regional, features)
    asset_panel = dataset.build_asset_panel(full_prices, DEFAULT_ASSETS, fx_returns=fx_returns)
    asset_returns = asset_panel.pivot(index="date", columns="asset", values="return_1m").sort_index()
    asset_returns = asset_returns.replace([np.inf, -np.inf], np.nan).dropna(how="all")
    engine = BacktestEngine(PortfolioPolicy(DEFAULT_ASSETS, PolicyConfig()))
    result = engine.run(asset_returns, regime_table)

    paths["regime_table"] = _write_csv(regime_table, output_dir / "regime_table.csv")
    paths["weights"] = _write_csv(result.weights, output_dir / "weights.csv")
    paths["nav"] = _write_csv(result.nav.to_frame(name="nav"), output_dir / "nav.csv")
    paths["metrics"] = _write_csv(result.metrics.to_frame(name="value"), output_dir / "metrics.csv")
    paths["benchmarks"] = _write_csv(result.benchmarks, output_dir / "benchmarks.csv")
    return paths


def _write_csv(frame: pd.DataFrame, path: Path) -> Path:
    frame.to_csv(path)
    return path
