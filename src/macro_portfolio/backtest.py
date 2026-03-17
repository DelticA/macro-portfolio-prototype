from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .policy import PortfolioPolicy


@dataclass
class BacktestResult:
    nav: pd.Series
    weights: pd.DataFrame
    monthly_returns: pd.Series
    metrics: pd.Series
    benchmarks: pd.DataFrame
    attribution: pd.DataFrame


class BacktestEngine:
    def __init__(self, policy: PortfolioPolicy, training_window: int = 60, transaction_cost_bps: float = 5.0) -> None:
        self.policy = policy
        self.training_window = training_window
        self.transaction_cost = transaction_cost_bps / 10000.0

    def run(
        self,
        asset_returns: pd.DataFrame,
        regime_table: pd.DataFrame,
    ) -> BacktestResult:
        dates = asset_returns.index.intersection(regime_table.index)
        asset_returns = asset_returns.reindex(dates).fillna(0.0)
        regime_table = regime_table.reindex(dates).ffill()

        portfolio_returns = []
        weights_history = []
        attribution_rows = []
        current_weights = pd.Series(1 / asset_returns.shape[1], index=asset_returns.columns)

        for idx in range(self.training_window, len(dates)):
            date = dates[idx]
            history = asset_returns.iloc[idx - self.training_window : idx]
            signal = regime_table.loc[date]
            target = self.policy.target_weights(
                returns_window=history,
                portfolio_regime=signal["portfolio_regime"],
                confidence=float(signal["regime_confidence"]),
                current_weights=current_weights,
            ).reindex(asset_returns.columns)
            realized = asset_returns.loc[date]
            turnover = (target - current_weights).abs().sum()
            port_ret = float((target * realized).sum() - turnover * self.transaction_cost)
            portfolio_returns.append((date, port_ret))
            weights_history.append(target.rename(date))
            current_weights = target * (1 + realized)
            current_weights = current_weights / current_weights.sum()
            attribution_rows.append(
                {
                    "date": date,
                    "portfolio_regime": signal["portfolio_regime"],
                    "gross_return": float((target * realized).sum()),
                    "transaction_cost": float(turnover * self.transaction_cost),
                    "net_return": port_ret,
                }
            )

        monthly_returns = pd.Series(dict(portfolio_returns)).sort_index()
        nav = (1 + monthly_returns).cumprod()
        weights = pd.DataFrame(weights_history)
        attribution = pd.DataFrame(attribution_rows).set_index("date")
        benchmarks = self._benchmarks(asset_returns.loc[monthly_returns.index])
        metrics = self._metrics(monthly_returns, benchmarks)
        return BacktestResult(nav=nav, weights=weights, monthly_returns=monthly_returns, metrics=metrics, benchmarks=benchmarks, attribution=attribution)

    def _benchmarks(self, returns: pd.DataFrame) -> pd.DataFrame:
        benchmark_weights = {
            "permanent_portfolio": {"SPY": 0.25, "TLT": 0.25, "GLD": 0.25, "CGB": 0.25},
            "sixty_forty": {"SPY": 0.36, "CSI300": 0.24, "TLT": 0.20, "CGB": 0.20},
            "risk_parity_static": {asset: 1 / len(returns.columns) for asset in returns.columns},
        }
        data = {}
        for name, weight_map in benchmark_weights.items():
            weights = pd.Series(weight_map, index=returns.columns, dtype=float).fillna(0.0)
            weights = weights / weights.sum()
            data[name] = (returns * weights).sum(axis=1)
        return pd.DataFrame(data)

    def _metrics(self, monthly_returns: pd.Series, benchmarks: pd.DataFrame) -> pd.Series:
        metrics = {
            "cagr": self._cagr(monthly_returns),
            "annualized_vol": monthly_returns.std(ddof=0) * np.sqrt(12),
            "sharpe": self._sharpe(monthly_returns),
            "sortino": self._sortino(monthly_returns),
            "max_drawdown": self._max_drawdown(monthly_returns),
            "cvar_95": -monthly_returns[monthly_returns <= monthly_returns.quantile(0.05)].mean(),
            "calmar": self._calmar(monthly_returns),
        }
        for name, series in benchmarks.items():
            metrics[f"excess_return_vs_{name}"] = self._cagr(monthly_returns) - self._cagr(series)
        return pd.Series(metrics)

    def _cagr(self, monthly_returns: pd.Series) -> float:
        if monthly_returns.empty:
            return 0.0
        years = len(monthly_returns) / 12
        total = (1 + monthly_returns).prod()
        return total ** (1 / years) - 1

    def _sharpe(self, monthly_returns: pd.Series) -> float:
        vol = monthly_returns.std(ddof=0)
        if vol == 0:
            return 0.0
        return monthly_returns.mean() / vol * np.sqrt(12)

    def _sortino(self, monthly_returns: pd.Series) -> float:
        downside = monthly_returns[monthly_returns < 0].std(ddof=0)
        if downside == 0 or np.isnan(downside):
            return 0.0
        return monthly_returns.mean() / downside * np.sqrt(12)

    def _max_drawdown(self, monthly_returns: pd.Series) -> float:
        nav = (1 + monthly_returns).cumprod()
        drawdown = nav / nav.cummax() - 1
        return drawdown.min()

    def _calmar(self, monthly_returns: pd.Series) -> float:
        max_dd = abs(self._max_drawdown(monthly_returns))
        if max_dd == 0:
            return 0.0
        return self._cagr(monthly_returns) / max_dd
