from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from ...regime import PortfolioRegimeAggregator, RegionalRegimeModel
from .base import BaseRegimeModel, RegimeDiagnostics


@dataclass
class RuleBasedRegimeModel(BaseRegimeModel):
    smoothing_window: int = 3
    name: str = "rule_based"

    def fit_predict(self, features: pd.DataFrame) -> pd.DataFrame:
        regional = RegionalRegimeModel(smoothing_window=self.smoothing_window).fit_transform(features)
        result = PortfolioRegimeAggregator().transform(regional, features)
        result["state_id"] = result["portfolio_regime"].astype("category").cat.codes
        result["state_label"] = result["portfolio_regime"]
        result["model_name"] = self.name
        return result

    def diagnostics(self) -> RegimeDiagnostics:
        return RegimeDiagnostics(model_name=self.name, details={"smoothing_window": self.smoothing_window})
