from __future__ import annotations

from dataclasses import dataclass
import math

import pandas as pd

from ...types import AssetConfig
from .base import BaseRiskModel, RiskDiagnostics


@dataclass
class VolTargetRiskModel(BaseRiskModel):
    assets: list[AssetConfig]
    target_annualized_vol: float = 0.12
    max_defensive_shift: float = 0.30
    lookback_months: int = 12
    name: str = "vol_target"

    def apply(
        self,
        weights: pd.Series,
        returns_window: pd.DataFrame,
        signal_row: pd.Series,
        current_weights: pd.Series | None = None,
    ) -> pd.Series:
        if weights.sum() <= 0:
            return weights
        defensive_assets = [asset.asset for asset in self.assets if asset.is_defensive and asset.asset in weights.index]
        risk_assets = [asset for asset in weights.index if asset not in defensive_assets]
        if not defensive_assets or returns_window.empty or not risk_assets:
            return weights / weights.sum()

        sample = returns_window.reindex(columns=weights.index).tail(self.lookback_months).fillna(0.0)
        realized = (sample * weights.reindex(sample.columns).fillna(0.0)).sum(axis=1)
        realized_vol = float(realized.std(ddof=0) * math.sqrt(12))
        if realized_vol <= self.target_annualized_vol or realized_vol <= 1e-8:
            return weights / weights.sum()

        overshoot = realized_vol / self.target_annualized_vol - 1.0
        shift_ratio = min(self.max_defensive_shift, max(0.0, overshoot * 0.20))

        adjusted = weights.copy().astype(float)
        shifted_capital = adjusted[risk_assets].sum() * shift_ratio
        adjusted.loc[risk_assets] *= 1 - shift_ratio

        defensive_anchor = adjusted.reindex(defensive_assets).clip(lower=0.0)
        if defensive_anchor.sum() <= 0:
            defensive_anchor[:] = 1.0 / len(defensive_assets)
        else:
            defensive_anchor = defensive_anchor / defensive_anchor.sum()
        adjusted.loc[defensive_assets] += shifted_capital * defensive_anchor
        return adjusted / adjusted.sum()

    def diagnostics(self) -> RiskDiagnostics:
        return RiskDiagnostics(
            model_name=self.name,
            details={
                "target_annualized_vol": self.target_annualized_vol,
                "max_defensive_shift": self.max_defensive_shift,
                "lookback_months": self.lookback_months,
            },
        )
