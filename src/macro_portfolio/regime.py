from __future__ import annotations

from collections import Counter
from dataclasses import dataclass

import numpy as np
import pandas as pd


@dataclass
class RegionalRegimeModel:
    smoothing_window: int = 3

    def fit_transform(self, features: pd.DataFrame) -> pd.DataFrame:
        result = pd.DataFrame(index=features.index)
        result["growth_score_us"] = self._score_region(features, "us", include=("ip", "payroll", "pmi", "growth"))
        result["inflation_score_us"] = self._score_region(features, "us", include=("cpi", "core", "breakeven", "inflation"))
        result["growth_score_cn"] = self._score_region(features, "cn", include=("pmi", "industrial", "retail", "export", "growth"))
        result["inflation_score_cn"] = self._score_region(features, "cn", include=("cpi", "ppi", "inflation"))
        result["regional_regime_us"] = result.apply(
            lambda row: self._quadrant_regime(row["growth_score_us"], row["inflation_score_us"]), axis=1
        )
        result["regional_regime_cn"] = result.apply(
            lambda row: self._quadrant_regime(row["growth_score_cn"], row["inflation_score_cn"]), axis=1
        )
        result["regional_regime_us"] = self._smooth_labels(result["regional_regime_us"])
        result["regional_regime_cn"] = self._smooth_labels(result["regional_regime_cn"])
        return result

    def _score_region(self, features: pd.DataFrame, prefix: str, include: tuple[str, ...]) -> pd.Series:
        candidates = [
            col for col in features.columns if col.startswith(f"{prefix}_") and col.endswith("_z") and any(key in col for key in include)
        ]
        if not candidates:
            return pd.Series(0.0, index=features.index)
        return features[candidates].mean(axis=1).fillna(0.0)

    def _quadrant_regime(self, growth: float, inflation: float) -> str:
        if growth >= 0 and inflation < 0:
            return "growth_up_inflation_down"
        if growth >= 0 and inflation >= 0:
            return "growth_up_inflation_up"
        if growth < 0 and inflation < 0:
            return "growth_down_inflation_down"
        return "growth_down_inflation_up"

    def _smooth_labels(self, labels: pd.Series) -> pd.Series:
        smoothed = []
        window: list[str] = []
        for label in labels.ffill().fillna("growth_down_inflation_down"):
            window.append(label)
            window = window[-self.smoothing_window :]
            smoothed.append(Counter(window).most_common(1)[0][0])
        return pd.Series(smoothed, index=labels.index)


@dataclass
class PortfolioRegimeAggregator:
    divergence_buffer: float = 0.25

    def transform(self, regional_state: pd.DataFrame, features: pd.DataFrame) -> pd.DataFrame:
        result = regional_state.copy()
        result["portfolio_regime"] = result.apply(lambda row: self._aggregate_row(row), axis=1)
        result["portfolio_regime"] = self._smooth(result["portfolio_regime"])
        result["regime_confidence"] = result.apply(self._confidence, axis=1)
        if "global_oil_z" in features.columns:
            reinflation_mask = features["global_oil_z"].fillna(0.0) > 0.75
            result.loc[reinflation_mask & result["portfolio_regime"].eq("global_easing_growth"), "portfolio_regime"] = (
                "reflation"
            )
        return result

    def _aggregate_row(self, row: pd.Series) -> str:
        us_growth = row["growth_score_us"]
        us_infl = row["inflation_score_us"]
        cn_growth = row["growth_score_cn"]
        cn_infl = row["inflation_score_cn"]
        if cn_growth - us_growth > self.divergence_buffer and us_growth < 0:
            return "china_recovery_us_weak"
        avg_growth = np.mean([us_growth, cn_growth])
        avg_infl = np.mean([us_infl, cn_infl])
        if avg_growth >= 0 and avg_infl < 0:
            return "global_easing_growth"
        if avg_growth >= 0 and avg_infl >= 0:
            return "reflation"
        if avg_growth < 0 and avg_infl < 0:
            return "disinflationary_slowdown"
        return "stagflation_pressure"

    def _confidence(self, row: pd.Series) -> float:
        signal_strength = np.mean(
            [
                abs(row["growth_score_us"]),
                abs(row["inflation_score_us"]),
                abs(row["growth_score_cn"]),
                abs(row["inflation_score_cn"]),
            ]
        )
        return float(np.clip(signal_strength / 2.0, 0.0, 1.0))

    def _smooth(self, labels: pd.Series) -> pd.Series:
        smoothed = []
        window: list[str] = []
        for label in labels:
            window.append(label)
            window = window[-3:]
            smoothed.append(Counter(window).most_common(1)[0][0])
        return pd.Series(smoothed, index=labels.index)
