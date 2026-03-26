from __future__ import annotations

import numpy as np
import pandas as pd

from macro_portfolio.live import DEFAULT_ASSETS
from macro_portfolio.models.risk.confidence_guard import ConfidenceGuardRiskModel
from macro_portfolio.models.risk.vol_target import VolTargetRiskModel


def _base_weights() -> pd.Series:
    return pd.Series(
        {
            "SPY": 0.22,
            "QQQ": 0.10,
            "TLT": 0.14,
            "GLD": 0.10,
            "DBC": 0.08,
            "BTC": 0.04,
            "CSI300": 0.16,
            "STAR50": 0.06,
            "CGB": 0.10,
        }
    )


def test_confidence_guard_shifts_capital_into_defensive_assets():
    model = ConfidenceGuardRiskModel(assets=DEFAULT_ASSETS, trigger_confidence=0.60, max_defensive_shift=0.35)
    weights = _base_weights()
    defensive_before = float(weights[["TLT", "GLD", "CGB"]].sum())

    adjusted = model.apply(
        weights,
        returns_window=pd.DataFrame(index=pd.date_range("2022-01-31", periods=12, freq="ME")),
        signal_row=pd.Series({"portfolio_regime": "reflation", "regime_confidence": 0.25}),
    )

    defensive_after = float(adjusted[["TLT", "GLD", "CGB"]].sum())
    assert np.isclose(adjusted.sum(), 1.0)
    assert defensive_after > defensive_before


def test_vol_target_reduces_risk_assets_when_realized_vol_is_high():
    model = VolTargetRiskModel(assets=DEFAULT_ASSETS, target_annualized_vol=0.03, max_defensive_shift=0.30, lookback_months=12)
    weights = _base_weights()
    defensive_before = float(weights[["TLT", "GLD", "CGB"]].sum())
    index = pd.date_range("2023-01-31", periods=18, freq="ME")
    returns_window = pd.DataFrame(
        {
            "SPY": np.linspace(-0.14, 0.18, len(index)),
            "QQQ": np.linspace(0.20, -0.17, len(index)),
            "TLT": np.linspace(0.01, 0.02, len(index)),
            "GLD": np.linspace(0.015, -0.005, len(index)),
            "DBC": np.linspace(-0.09, 0.11, len(index)),
            "BTC": np.linspace(0.28, -0.24, len(index)),
            "CSI300": np.linspace(-0.11, 0.13, len(index)),
            "STAR50": np.linspace(0.16, -0.12, len(index)),
            "CGB": np.linspace(0.008, 0.012, len(index)),
        },
        index=index,
    )

    adjusted = model.apply(
        weights,
        returns_window=returns_window,
        signal_row=pd.Series({"portfolio_regime": "stagflation_pressure", "regime_confidence": 0.8}),
    )

    defensive_after = float(adjusted[["TLT", "GLD", "CGB"]].sum())
    assert np.isclose(adjusted.sum(), 1.0)
    assert defensive_after > defensive_before
