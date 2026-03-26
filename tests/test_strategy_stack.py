from __future__ import annotations

import numpy as np
import pandas as pd

from macro_portfolio.engine.artifacts import read_json, write_frame
from macro_portfolio.engine.run_store import RunStore
from macro_portfolio.engine.schemas import BacktestRequest, PolicyRequest
from macro_portfolio.live import DEFAULT_ASSETS
from macro_portfolio.services.pipeline import PipelineService


def _asset_returns_frame() -> pd.DataFrame:
    index = pd.date_range("2020-01-31", periods=48, freq="ME")
    t = np.arange(len(index))
    data = {}
    for idx, asset in enumerate(DEFAULT_ASSETS):
        data[asset.asset] = (
            0.004
            + idx * 0.0004
            + np.sin(t / (4.0 + idx)) * 0.012
            + np.cos(t / (6.0 + idx)) * 0.006
        )
    return pd.DataFrame(data, index=index)


def _regime_frame(index: pd.DatetimeIndex) -> pd.DataFrame:
    regimes = [
        "global_easing_growth",
        "reflation",
        "disinflationary_slowdown",
        "stagflation_pressure",
        "china_recovery_us_weak",
    ]
    return pd.DataFrame(
        {
            "portfolio_regime": [regimes[idx % len(regimes)] for idx in range(len(index))],
            "regime_confidence": [0.42 + (idx % 6) * 0.09 for idx in range(len(index))],
            "state_id": [idx % len(regimes) for idx in range(len(index))],
        },
        index=index,
    )


def _setup_strategy_run(tmp_path):
    run_store = RunStore(tmp_path / "runs")
    run_id = run_store.create_run("strategy-stack-test")
    data_dir = run_store.stage_dir(run_id, "data")
    regime_dir = run_store.stage_dir(run_id, "regime")

    asset_returns = _asset_returns_frame()
    regime = _regime_frame(asset_returns.index)
    write_frame(asset_returns, data_dir / "asset_returns.csv")
    write_frame(regime, regime_dir / "regime.csv")

    run_store.mark_stage(run_id, "data", "success", {"summary": {}})
    run_store.mark_stage(run_id, "regime", "success", {"summary": {}})
    return PipelineService(run_store), run_id


def test_run_policy_writes_raw_and_risk_adjusted_weights(tmp_path):
    service, run_id = _setup_strategy_run(tmp_path)

    summary = service.run_policy(
        run_id,
        PolicyRequest(
            model_name="risk_parity",
            portfolio_model="risk_parity",
            risk_model="confidence_guard",
            training_window=24,
        ),
    )

    stage_dir = service.run_store.stage_dir(run_id, "policy")
    weights = pd.read_csv(stage_dir / "weights_target.csv")
    raw_weights = pd.read_csv(stage_dir / "weights_target_raw.csv")
    manifest = read_json(stage_dir / "strategy_manifest.json")

    assert np.isclose(weights["target_weight"].sum(), 1.0)
    assert "raw_weight" in weights.columns
    assert "risk_delta" in weights.columns
    assert np.isclose(raw_weights["target_weight"].sum(), 1.0)
    assert summary["portfolio_model"] == "risk_parity"
    assert summary["risk_model"] == "confidence_guard"
    assert summary["risk_shift"] >= 0.0
    assert manifest["portfolio_model"] == "risk_parity"
    assert manifest["risk_model"] == "confidence_guard"


def test_run_backtest_uses_strategy_stack_and_writes_metrics(tmp_path):
    service, run_id = _setup_strategy_run(tmp_path)

    summary = service.run_backtest(
        run_id,
        BacktestRequest(
            model_name="cvar",
            portfolio_model="cvar",
            risk_model="vol_target",
            training_window=24,
            transaction_cost_bps=4.0,
        ),
    )

    stage_dir = service.run_store.stage_dir(run_id, "backtest")
    metrics = read_json(stage_dir / "metrics.json")
    manifest = read_json(stage_dir / "strategy_manifest.json")
    nav = pd.read_csv(stage_dir / "nav.csv")

    assert summary["portfolio_model"] == "cvar"
    assert summary["risk_model"] == "vol_target"
    assert summary["nav_rows"] == len(nav)
    assert summary["latest_nav"] == nav["nav"].iloc[-1]
    assert "cagr" in metrics
    assert manifest["transaction_cost_bps"] == 4.0
    assert manifest["risk_model"] == "vol_target"
