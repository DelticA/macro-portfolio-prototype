from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from ...policy import PolicyConfig, PortfolioPolicy
from ...types import AssetConfig
from .base import BasePolicyModel, PolicyDiagnostics


@dataclass
class TemplateRulePolicyModel(BasePolicyModel):
    assets: list[AssetConfig]
    config: PolicyConfig
    name: str = "template_rule"

    def __post_init__(self) -> None:
        self._policy = PortfolioPolicy(self.assets, self.config)

    def allocate(
        self,
        returns_window: pd.DataFrame,
        portfolio_regime: str,
        confidence: float,
        current_weights: pd.Series | None = None,
    ) -> pd.Series:
        weights = self._policy._template_weights(portfolio_regime)
        return weights / weights.sum()

    def diagnostics(self) -> PolicyDiagnostics:
        return PolicyDiagnostics(model_name=self.name, details={})
