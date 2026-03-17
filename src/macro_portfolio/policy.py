from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.optimize import Bounds, minimize

from .types import AssetConfig


@dataclass
class PolicyConfig:
    max_weight_default: float = 0.35
    btc_max_weight: float = 0.10
    oil_max_weight: float = 0.15
    min_trade_weight: float = 0.01
    turnover_penalty: float = 0.50
    confidence_blend: float = 0.40
    cvar_alpha: float = 0.95
    country_equity_cap: float = 0.45


class PortfolioPolicy:
    def __init__(self, assets: list[AssetConfig], config: PolicyConfig | None = None) -> None:
        self.assets = assets
        self.config = config or PolicyConfig()
        self.asset_names = [asset.asset for asset in assets]

    def target_weights(
        self,
        returns_window: pd.DataFrame,
        portfolio_regime: str,
        confidence: float,
        current_weights: pd.Series | None = None,
    ) -> pd.Series:
        current = self._normalize_current(current_weights)
        template = self._template_weights(portfolio_regime)
        if len(returns_window) < 12 or returns_window.isna().all().all():
            return template

        bounds = self._bounds_for_regime(portfolio_regime)
        try:
            optimized = self._optimize_cvar(returns_window[self.asset_names].fillna(0.0), bounds, current, template, confidence)
        except Exception:
            optimized = self._risk_parity_fallback(returns_window[self.asset_names].fillna(0.0), bounds, template)

        optimized = self._apply_country_caps(optimized)
        optimized = self._threshold_trades(current, optimized)
        optimized = self._enforce_bounds(optimized, bounds)
        return optimized / optimized.sum()

    def _template_weights(self, regime: str) -> pd.Series:
        templates = {
            "global_easing_growth": {
                "SPY": 0.18,
                "QQQ": 0.10,
                "TLT": 0.10,
                "GLD": 0.08,
                "DBC": 0.05,
                "BTC": 0.04,
                "CSI300": 0.20,
                "STAR50": 0.12,
                "CGB": 0.13,
            },
            "reflation": {
                "SPY": 0.15,
                "QQQ": 0.07,
                "TLT": 0.06,
                "GLD": 0.14,
                "DBC": 0.12,
                "BTC": 0.04,
                "CSI300": 0.18,
                "STAR50": 0.08,
                "CGB": 0.16,
            },
            "disinflationary_slowdown": {
                "SPY": 0.09,
                "QQQ": 0.04,
                "TLT": 0.20,
                "GLD": 0.18,
                "DBC": 0.02,
                "BTC": 0.02,
                "CSI300": 0.10,
                "STAR50": 0.03,
                "CGB": 0.32,
            },
            "stagflation_pressure": {
                "SPY": 0.08,
                "QQQ": 0.03,
                "TLT": 0.07,
                "GLD": 0.24,
                "DBC": 0.11,
                "BTC": 0.03,
                "CSI300": 0.12,
                "STAR50": 0.04,
                "CGB": 0.28,
            },
            "china_recovery_us_weak": {
                "SPY": 0.08,
                "QQQ": 0.04,
                "TLT": 0.08,
                "GLD": 0.12,
                "DBC": 0.04,
                "BTC": 0.03,
                "CSI300": 0.24,
                "STAR50": 0.14,
                "CGB": 0.23,
            },
        }
        weights = pd.Series(templates.get(regime, templates["disinflationary_slowdown"]), dtype=float)
        return weights.reindex(self.asset_names).fillna(0.0)

    def _bounds_for_regime(self, regime: str) -> dict[str, tuple[float, float]]:
        bounds = {}
        for asset in self.assets:
            upper = min(asset.max_weight, self.config.max_weight_default)
            if asset.asset == "BTC":
                upper = min(upper, self.config.btc_max_weight)
            if asset.asset == "DBC":
                upper = min(upper, self.config.oil_max_weight)
            if regime == "disinflationary_slowdown" and asset.sleeve == "satellite":
                upper = min(upper, 0.06)
            if regime == "stagflation_pressure" and asset.asset == "TLT":
                upper = min(upper, 0.10)
            bounds[asset.asset] = (asset.min_weight, upper)
        return bounds

    def _optimize_cvar(
        self,
        returns_window: pd.DataFrame,
        bounds: dict[str, tuple[float, float]],
        current: pd.Series,
        template: pd.Series,
        confidence: float,
    ) -> pd.Series:
        confidence = float(np.clip(confidence, 0.0, 1.0))
        target = (1 - self.config.confidence_blend * confidence) * self._risk_parity_fallback(
            returns_window, bounds, template
        ) + (self.config.confidence_blend * confidence) * template
        target = target / target.sum()

        x0 = target.values
        lower = [bounds[name][0] for name in self.asset_names]
        upper = [bounds[name][1] for name in self.asset_names]
        scenarios = returns_window.to_numpy()
        alpha_index = max(1, int(np.ceil((1 - self.config.cvar_alpha) * len(scenarios))))

        def objective(weights: np.ndarray) -> float:
            port = scenarios @ weights
            tail = np.sort(port)[:alpha_index]
            cvar = -tail.mean()
            tracking = 0.5 * np.sum((weights - target.values) ** 2)
            turnover = self.config.turnover_penalty * np.sum(np.abs(weights - current.values))
            return cvar + tracking + turnover

        constraints = [{"type": "eq", "fun": lambda w: np.sum(w) - 1.0}]
        result = minimize(
            objective,
            x0=x0,
            method="SLSQP",
            bounds=Bounds(lower, upper),
            constraints=constraints,
            options={"maxiter": 50, "ftol": 1e-6},
        )
        if not result.success:
            raise RuntimeError(result.message)
        return pd.Series(result.x, index=self.asset_names)

    def _risk_parity_fallback(
        self, returns_window: pd.DataFrame, bounds: dict[str, tuple[float, float]], template: pd.Series
    ) -> pd.Series:
        cov = returns_window.cov().to_numpy()
        cov = cov + np.eye(cov.shape[0]) * 1e-6
        n_assets = cov.shape[0]
        lower = [bounds[name][0] for name in self.asset_names]
        upper = [bounds[name][1] for name in self.asset_names]
        x0 = np.clip(template.values, lower, upper)
        x0 = x0 / x0.sum()

        def objective(weights: np.ndarray) -> float:
            portfolio_var = float(weights.T @ cov @ weights)
            if portfolio_var <= 0:
                return 1e6
            marginal = cov @ weights
            risk_contrib = weights * marginal / np.sqrt(portfolio_var)
            target = np.ones(n_assets) / n_assets
            return float(np.sum((risk_contrib - target) ** 2))

        constraints = [{"type": "eq", "fun": lambda w: np.sum(w) - 1.0}]
        result = minimize(
            objective,
            x0=x0,
            method="SLSQP",
            bounds=Bounds(lower, upper),
            constraints=constraints,
            options={"maxiter": 40, "ftol": 1e-6},
        )
        if not result.success:
            clipped = pd.Series(x0, index=self.asset_names)
            return clipped / clipped.sum()
        return pd.Series(result.x, index=self.asset_names)

    def _apply_country_caps(self, weights: pd.Series) -> pd.Series:
        capped = weights.copy()
        country_assets = {"US": ["SPY", "QQQ"], "CN": ["CSI300", "STAR50"]}
        for names in country_assets.values():
            total = capped.reindex(names).sum()
            if total > self.config.country_equity_cap:
                scale = self.config.country_equity_cap / total
                capped.loc[names] *= scale
                residual = 1.0 - capped.sum()
                defensive = ["TLT", "GLD", "CGB"]
                capped.loc[defensive] += residual / len(defensive)
        return capped

    def _threshold_trades(self, current: pd.Series, target: pd.Series) -> pd.Series:
        adjusted = target.copy()
        small_moves = (adjusted - current).abs() < self.config.min_trade_weight
        adjusted.loc[small_moves] = current.loc[small_moves]
        if adjusted.sum() <= 0:
            return target
        return adjusted / adjusted.sum()

    def _enforce_bounds(self, weights: pd.Series, bounds: dict[str, tuple[float, float]]) -> pd.Series:
        adjusted = weights.copy()
        for _ in range(5):
            adjusted = adjusted.clip(
                lower=pd.Series({name: lower for name, (lower, _) in bounds.items()}),
                upper=pd.Series({name: upper for name, (_, upper) in bounds.items()}),
            )
            residual = 1.0 - adjusted.sum()
            if abs(residual) < 1e-8:
                break
            capacity = pd.Series({name: bounds[name][1] - adjusted[name] for name in adjusted.index})
            if residual < 0:
                capacity = pd.Series({name: adjusted[name] - bounds[name][0] for name in adjusted.index})
            eligible = capacity[capacity > 1e-8]
            if eligible.empty:
                break
            adjusted.loc[eligible.index] += residual * (eligible / eligible.sum())
        return adjusted

    def _normalize_current(self, current_weights: pd.Series | None) -> pd.Series:
        if current_weights is None or current_weights.empty:
            return pd.Series(1 / len(self.asset_names), index=self.asset_names)
        current = current_weights.reindex(self.asset_names).fillna(0.0)
        total = current.sum()
        if total <= 0:
            return pd.Series(1 / len(self.asset_names), index=self.asset_names)
        return current / total
