from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.cluster import KMeans
from sklearn.preprocessing import StandardScaler

from .base import BaseRegimeModel, RegimeDiagnostics


@dataclass
class KMeansRegimeModel(BaseRegimeModel):
    n_states: int = 4
    random_state: int = 7
    name: str = "kmeans"

    def fit_predict(self, features: pd.DataFrame) -> pd.DataFrame:
        cols = [col for col in features.columns if col.endswith("_z")]
        X = features[cols].fillna(0.0)
        scaled = StandardScaler().fit_transform(X)
        model = KMeans(n_clusters=self.n_states, random_state=self.random_state, n_init="auto")
        cluster = model.fit_predict(scaled)

        result = pd.DataFrame(index=features.index)
        result["growth_score_us"] = _mean_like(features, "us_", ("ip", "payroll", "pmi", "growth"))
        result["inflation_score_us"] = _mean_like(features, "us_", ("cpi", "core", "breakeven", "inflation"))
        result["growth_score_cn"] = _mean_like(features, "cn_", ("pmi", "industrial", "growth"))
        result["inflation_score_cn"] = _mean_like(features, "cn_", ("cpi", "ppi", "inflation"))
        result["state_id"] = cluster
        result["state_label"] = [f"kmeans_state_{item}" for item in cluster]
        result["portfolio_regime"] = result["state_label"]
        result["regime_confidence"] = _cluster_confidence(scaled, model.cluster_centers_, cluster)
        result["regional_regime_us"] = "model_driven"
        result["regional_regime_cn"] = "model_driven"
        result["model_name"] = self.name
        return result

    def diagnostics(self) -> RegimeDiagnostics:
        return RegimeDiagnostics(model_name=self.name, details={"n_states": self.n_states})


def _mean_like(features: pd.DataFrame, prefix: str, include: tuple[str, ...]) -> pd.Series:
    cols = [col for col in features.columns if col.startswith(prefix) and col.endswith("_z") and any(token in col for token in include)]
    if not cols:
        return pd.Series(0.0, index=features.index)
    return features[cols].mean(axis=1).fillna(0.0)


def _cluster_confidence(scaled: np.ndarray, centers: np.ndarray, labels: np.ndarray) -> np.ndarray:
    distances = np.linalg.norm(scaled - centers[labels], axis=1)
    if distances.max() == distances.min():
        return np.ones_like(distances)
    normalized = 1 - (distances - distances.min()) / (distances.max() - distances.min())
    return normalized.clip(0.0, 1.0)
