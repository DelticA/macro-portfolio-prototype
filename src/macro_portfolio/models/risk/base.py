from __future__ import annotations

from dataclasses import dataclass

import pandas as pd


@dataclass
class RiskDiagnostics:
    model_name: str
    details: dict


class BaseRiskModel:
    name = "base"

    def apply(
        self,
        weights: pd.Series,
        returns_window: pd.DataFrame,
        signal_row: pd.Series,
        current_weights: pd.Series | None = None,
    ) -> pd.Series:
        raise NotImplementedError

    def diagnostics(self) -> RiskDiagnostics:
        return RiskDiagnostics(model_name=self.name, details={})
