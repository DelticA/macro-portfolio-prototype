from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from ...policy import PolicyConfig, PortfolioPolicy
from ...types import AssetConfig
from .base import BasePolicyModel, PolicyDiagnostics


@dataclass
class RiskParityPolicyModel(BasePolicyModel):
    assets: list[AssetConfig]
    config: PolicyConfig
    name: str = "risk_parity"

    def __post_init__(self) -> None:
        self._policy = PortfolioPolicy(self.assets, self.config)

    def allocate(
        self,
        returns_window: pd.DataFrame,
        portfolio_regime: str,
        confidence: float,
        current_weights: pd.Series | None = None,
    ) -> pd.Series:
        bounds = self._policy._bounds_for_regime(portfolio_regime)
        template = self._policy._template_weights(portfolio_regime)
        result = self._policy._risk_parity_fallback(returns_window[self._policy.asset_names].fillna(0.0), bounds, template)
        result = self._policy._apply_country_caps(result)
        result = self._policy._enforce_bounds(result, bounds)
        return result / result.sum()

    def diagnostics(self) -> PolicyDiagnostics:
        return PolicyDiagnostics(model_name=self.name, details={})
