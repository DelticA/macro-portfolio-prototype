from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from ...policy import PolicyConfig, PortfolioPolicy
from ...types import AssetConfig
from .base import BasePolicyModel, PolicyDiagnostics


@dataclass
class CvarPolicyModel(BasePolicyModel):
    assets: list[AssetConfig]
    config: PolicyConfig
    name: str = "cvar"

    def __post_init__(self) -> None:
        self._policy = PortfolioPolicy(self.assets, self.config)

    def allocate(
        self,
        returns_window: pd.DataFrame,
        portfolio_regime: str,
        confidence: float,
        current_weights: pd.Series | None = None,
    ) -> pd.Series:
        return self._policy.target_weights(returns_window, portfolio_regime, confidence, current_weights=current_weights)

    def diagnostics(self) -> PolicyDiagnostics:
        return PolicyDiagnostics(model_name=self.name, details=self.config.__dict__)
