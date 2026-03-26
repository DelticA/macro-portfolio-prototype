from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from ...types import AssetConfig
from .base import BaseRiskModel, RiskDiagnostics


@dataclass
class ConfidenceGuardRiskModel(BaseRiskModel):
    assets: list[AssetConfig]
    trigger_confidence: float = 0.60
    max_defensive_shift: float = 0.35
    name: str = "confidence_guard"

    def apply(
        self,
        weights: pd.Series,
        returns_window: pd.DataFrame,
        signal_row: pd.Series,
        current_weights: pd.Series | None = None,
    ) -> pd.Series:
        if weights.sum() <= 0:
            return weights
        confidence = float(signal_row.get("regime_confidence", 1.0))
        if confidence >= self.trigger_confidence:
            return weights / weights.sum()

        defensive_assets = [asset.asset for asset in self.assets if asset.is_defensive and asset.asset in weights.index]
        risk_assets = [asset for asset in weights.index if asset not in defensive_assets]
        if not defensive_assets or not risk_assets:
            return weights / weights.sum()

        shift_ratio = min(
            self.max_defensive_shift,
            max(0.0, (self.trigger_confidence - confidence) / max(self.trigger_confidence, 1e-6)) * self.max_defensive_shift,
        )
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
                "trigger_confidence": self.trigger_confidence,
                "max_defensive_shift": self.max_defensive_shift,
            },
        )
