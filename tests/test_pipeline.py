from __future__ import annotations

import numpy as np
import pandas as pd

from macro_portfolio import (
    AssetConfig,
    BacktestEngine,
    MacroDataset,
    PolicyConfig,
    PortfolioPolicy,
    PortfolioRegimeAggregator,
    RegionalRegimeModel,
)


ASSETS = [
    AssetConfig("SPY", "US", "risk_core"),
    AssetConfig("QQQ", "US", "satellite"),
    AssetConfig("TLT", "US", "defensive"),
    AssetConfig("GLD", "US", "defensive"),
    AssetConfig("DBC", "US", "satellite"),
    AssetConfig("BTC", "US", "satellite"),
    AssetConfig("CSI300", "CN", "risk_core"),
    AssetConfig("STAR50", "CN", "satellite"),
    AssetConfig("CGB", "CN", "defensive"),
]


def make_macro_frame(index: pd.DatetimeIndex, prefix: str) -> pd.DataFrame:
    t = np.arange(len(index))
    if prefix == "us":
        return pd.DataFrame(
            {
                "ip": 100 + 0.3 * t,
                "payroll": 200 + 0.4 * t,
                "pmi": 50 + np.sin(t / 4),
                "cpi": 2 + 0.02 * t,
                "core": 2.1 + 0.015 * t,
                "breakeven": 2 + np.cos(t / 6) * 0.1,
            },
            index=index,
        )
    return pd.DataFrame(
        {
            "pmi": 50 + np.cos(t / 5),
            "industrial": 100 + 0.35 * t,
            "retail": 100 + 0.25 * t,
            "export": 100 + 0.2 * t,
            "cpi": 2 + np.sin(t / 6) * 0.1,
            "ppi": 1.5 + np.cos(t / 7) * 0.2,
        },
        index=index,
    )


def make_global_frame(index: pd.DatetimeIndex) -> pd.DataFrame:
    t = np.arange(len(index))
    return pd.DataFrame(
        {
            "oil": np.sin(t / 8) * 2,
            "gold": np.cos(t / 9) * 1.5,
            "dxy": 100 + np.sin(t / 10),
        },
        index=index,
    )


def make_price_frame(index: pd.DatetimeIndex) -> pd.DataFrame:
    rng = np.random.default_rng(7)
    returns = pd.DataFrame(
        {
            "SPY": 0.008 + rng.normal(0, 0.02, len(index)),
            "QQQ": 0.010 + rng.normal(0, 0.03, len(index)),
            "TLT": 0.003 + rng.normal(0, 0.015, len(index)),
            "GLD": 0.004 + rng.normal(0, 0.018, len(index)),
            "DBC": 0.005 + rng.normal(0, 0.03, len(index)),
            "BTC": 0.012 + rng.normal(0, 0.06, len(index)),
            "CSI300": 0.007 + rng.normal(0, 0.025, len(index)),
            "STAR50": 0.009 + rng.normal(0, 0.035, len(index)),
            "CGB": 0.002 + rng.normal(0, 0.01, len(index)),
        },
        index=index,
    )
    prices = 100 * (1 + returns).cumprod()
    return prices


def build_pipeline_inputs():
    index = pd.date_range("2010-01-31", periods=180, freq="ME")
    dataset = MacroDataset(release_lag_months={"US": 1, "CN": 0, "GLOBAL": 1, "default": 1})
    features = dataset.build_feature_table(
        {"US": make_macro_frame(index, "us"), "CN": make_macro_frame(index, "cn")},
        global_features=make_global_frame(index),
    )
    regime_model = RegionalRegimeModel()
    regional = regime_model.fit_transform(features)
    aggregator = PortfolioRegimeAggregator()
    regime_table = aggregator.transform(regional, features)
    asset_panel = dataset.build_asset_panel(
        make_price_frame(index),
        ASSETS,
        fx_returns=pd.Series(0.01, index=index),
    )
    asset_returns = asset_panel.pivot(index="date", columns="asset", values="return_1m").sort_index()
    return dataset, features, regime_table, asset_panel, asset_returns


def test_release_lag_prevents_lookahead():
    index = pd.date_range("2020-01-31", periods=15, freq="ME")
    dataset = MacroDataset(release_lag_months=1)
    features = dataset.build_feature_table({"US": pd.DataFrame({"ip": np.arange(15)}, index=index)})
    assert pd.isna(features.loc[pd.Timestamp("2020-01-31"), "us_ip_level"])
    assert features.loc[pd.Timestamp("2020-02-29"), "us_ip_level"] == 0


def test_cn_release_month_uses_release_date_without_extra_month_lag():
    release_dates = pd.to_datetime(["2020-03-10", "2020-04-10"])
    dataset = MacroDataset(release_lag_months={"US": 1, "CN": 0, "default": 1})
    features = dataset.build_feature_table({"CN": pd.DataFrame({"pmi": [50.0, 51.0]}, index=release_dates)})
    assert features.loc[pd.Timestamp("2020-03-31"), "cn_pmi_level"] == 50.0
    assert features.loc[pd.Timestamp("2020-04-30"), "cn_pmi_level"] == 51.0


def test_frequency_alignment_and_fx_conversion():
    _, _, _, panel, _ = build_pipeline_inputs()
    cn_rows = panel[panel["region"] == "CN"].copy()
    sample = cn_rows.iloc[0]
    expected = (1 + sample["local_return_1m"]) * (1 + sample["fx_return"]) - 1
    assert np.isclose(sample["return_1m"], expected)


def test_missing_cn_asset_history_is_not_forced_to_zero_or_fx_only():
    index = pd.date_range("2020-01-31", periods=6, freq="ME")
    prices = pd.DataFrame(
        {
            "SPY": [100, 101, 102, 103, 104, 105],
            "STAR50": [np.nan, np.nan, np.nan, 100, 110, 121],
        },
        index=index,
    )
    assets = [
        AssetConfig("SPY", "US", "risk_core"),
        AssetConfig("STAR50", "CN", "satellite"),
    ]
    panel = MacroDataset().build_asset_panel(prices, assets, fx_returns=pd.Series(0.01, index=index))
    star50 = panel[panel["asset"] == "STAR50"].set_index("date").sort_index()
    assert pd.isna(star50.loc[pd.Timestamp("2020-02-29"), "local_return_1m"])
    assert pd.isna(star50.loc[pd.Timestamp("2020-02-29"), "return_1m"])
    assert pd.isna(star50.loc[pd.Timestamp("2020-04-30"), "local_return_1m"])
    assert pd.isna(star50.loc[pd.Timestamp("2020-04-30"), "return_1m"])
    assert np.isclose(star50.loc[pd.Timestamp("2020-05-31"), "local_return_1m"], 0.1)


def test_policy_respects_constraints():
    _, _, regime_table, _, asset_returns = build_pipeline_inputs()
    policy = PortfolioPolicy(ASSETS, PolicyConfig())
    target = policy.target_weights(
        asset_returns.iloc[:60],
        regime_table.iloc[80]["portfolio_regime"],
        float(regime_table.iloc[80]["regime_confidence"]),
    )
    assert np.isclose(target.sum(), 1.0)
    assert target["BTC"] <= 0.10 + 1e-6
    assert target["DBC"] <= 0.15 + 1e-6
    assert target[["SPY", "QQQ"]].sum() <= 0.45 + 1e-6
    assert target[["CSI300", "STAR50"]].sum() <= 0.45 + 1e-6


def test_policy_falls_back_when_history_short():
    _, _, _, _, asset_returns = build_pipeline_inputs()
    policy = PortfolioPolicy(ASSETS, PolicyConfig())
    target = policy.target_weights(asset_returns.iloc[:5], "disinflationary_slowdown", 0.5)
    assert np.isclose(target.sum(), 1.0)
    assert target["CGB"] >= 0.30


def test_backtest_smoke_and_benchmark_comparison():
    _, _, regime_table, _, asset_returns = build_pipeline_inputs()
    policy = PortfolioPolicy(ASSETS, PolicyConfig())
    engine = BacktestEngine(policy, training_window=60, transaction_cost_bps=3)
    result = engine.run(asset_returns, regime_table)
    assert len(result.nav) >= 100
    assert {"permanent_portfolio", "sixty_forty", "risk_parity_static"} <= set(result.benchmarks.columns)
    assert result.metrics["max_drawdown"] <= 0
    assert "excess_return_vs_permanent_portfolio" in result.metrics.index


def test_sensitivity_to_china_proxy_is_not_direction_flip():
    _, _, regime_table, _, asset_returns = build_pipeline_inputs()
    alt_returns = asset_returns.copy()
    alt_returns["CSI300"] = alt_returns["CSI300"] * 0.85 + alt_returns["STAR50"] * 0.15
    policy = PortfolioPolicy(ASSETS, PolicyConfig())
    engine = BacktestEngine(policy, training_window=60)
    base = engine.run(asset_returns, regime_table).metrics["cagr"]
    alt = engine.run(alt_returns, regime_table).metrics["cagr"]
    assert np.sign(base + 1e-9) == np.sign(alt + 1e-9)
