from __future__ import annotations

from dataclasses import dataclass

import pandas as pd


@dataclass
class PolicyDiagnostics:
    model_name: str
    details: dict


class BasePolicyModel:
    name = "base"

    def allocate(
        self,
        returns_window: pd.DataFrame,
        portfolio_regime: str,
        confidence: float,
        current_weights: pd.Series | None = None,
    ) -> pd.Series:
        raise NotImplementedError

    def diagnostics(self) -> PolicyDiagnostics:
        return PolicyDiagnostics(model_name=self.name, details={})
