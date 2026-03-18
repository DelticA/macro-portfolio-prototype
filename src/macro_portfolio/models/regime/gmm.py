from __future__ import annotations

from dataclasses import dataclass

import pandas as pd
from sklearn.mixture import GaussianMixture
from sklearn.preprocessing import StandardScaler

from .base import BaseRegimeModel, RegimeDiagnostics
from .kmeans import _mean_like


@dataclass
class GMMRegimeModel(BaseRegimeModel):
    n_states: int = 4
    random_state: int = 7
    name: str = "gmm"

    def fit_predict(self, features: pd.DataFrame) -> pd.DataFrame:
        cols = [col for col in features.columns if col.endswith("_z")]
        X = features[cols].fillna(0.0)
        scaled = StandardScaler().fit_transform(X)
        model = GaussianMixture(n_components=self.n_states, random_state=self.random_state)
        model.fit(scaled)
        cluster = model.predict(scaled)
        probabilities = model.predict_proba(scaled).max(axis=1)

        result = pd.DataFrame(index=features.index)
        result["growth_score_us"] = _mean_like(features, "us_", ("ip", "payroll", "pmi", "growth"))
        result["inflation_score_us"] = _mean_like(features, "us_", ("cpi", "core", "breakeven", "inflation"))
        result["growth_score_cn"] = _mean_like(features, "cn_", ("pmi", "industrial", "growth"))
        result["inflation_score_cn"] = _mean_like(features, "cn_", ("cpi", "ppi", "inflation"))
        result["state_id"] = cluster
        result["state_label"] = [f"gmm_state_{item}" for item in cluster]
        result["portfolio_regime"] = result["state_label"]
        result["regime_confidence"] = probabilities
        result["regional_regime_us"] = "model_driven"
        result["regional_regime_cn"] = "model_driven"
        result["model_name"] = self.name
        return result

    def diagnostics(self) -> RegimeDiagnostics:
        return RegimeDiagnostics(model_name=self.name, details={"n_states": self.n_states})
