from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from .base import BaseRiskModel, RiskDiagnostics


@dataclass
class NoRiskOverlayModel(BaseRiskModel):
    name: str = "none"

    def apply(
        self,
        weights: pd.Series,
        returns_window: pd.DataFrame,
        signal_row: pd.Series,
        current_weights: pd.Series | None = None,
    ) -> pd.Series:
        if weights.sum() <= 0:
            return weights
        return weights / weights.sum()

    def diagnostics(self) -> RiskDiagnostics:
        return RiskDiagnostics(model_name=self.name, details={"overlay": "disabled"})
