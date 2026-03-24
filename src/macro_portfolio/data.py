from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .types import AssetConfig


@dataclass
class MacroDataset:
    release_lag_months: int | dict[str, int] = 1
    release_date_regions: frozenset[str] = frozenset()
    z_window: int = 36

    def build_feature_table(
        self,
        macro_frames: dict[str, pd.DataFrame],
        global_features: pd.DataFrame | None = None,
    ) -> pd.DataFrame:
        aligned = []
        for region, frame in macro_frames.items():
            regional = frame.copy().sort_index()
            regional.index = pd.to_datetime(regional.index).to_period("M").to_timestamp("M")
            regional = regional[~regional.index.duplicated(keep="last")]
            regional = regional.resample("ME").last().ffill()
            regional = regional.shift(self._lag_for_region(region))
            regional = self._feature_engineer(regional, prefix=region.lower())
            aligned.append(regional)

        merged = pd.concat(aligned, axis=1).sort_index()
        if global_features is not None:
            global_aligned = global_features.copy().sort_index()
            global_aligned.index = pd.to_datetime(global_aligned.index).to_period("M").to_timestamp("M")
            global_aligned = global_aligned[~global_aligned.index.duplicated(keep="last")]
            global_aligned = global_aligned.resample("ME").last().ffill()
            global_aligned = global_aligned.shift(self._lag_for_region("GLOBAL"))
            merged = merged.join(self._feature_engineer(global_aligned, prefix="global"), how="outer")

        return merged.sort_index()

    def build_asset_panel(
        self,
        prices: pd.DataFrame,
        assets: list[AssetConfig],
        fx_returns: pd.Series | None = None,
        base_currency: str = "USD",
    ) -> pd.DataFrame:
        monthly_prices = prices.copy().sort_index()
        monthly_prices.index = pd.to_datetime(monthly_prices.index).to_period("M").to_timestamp("M")
        monthly_prices = monthly_prices[~monthly_prices.index.duplicated(keep="last")]
        returns = monthly_prices.pct_change(fill_method=None).dropna(how="all")

        fx = pd.Series(np.nan, index=returns.index, dtype=float)
        if fx_returns is not None:
            fx = fx_returns.copy().sort_index()
            fx.index = pd.to_datetime(fx.index).to_period("M").to_timestamp("M")
            fx = fx.reindex(returns.index)

        panel_records: list[pd.DataFrame] = []
        config_map = {asset.asset: asset for asset in assets}
        for asset_name, series in returns.items():
            config = config_map[asset_name]
            local_return = series.astype(float)
            if config.region == "CN" and base_currency == "USD":
                fx_return = pd.Series(np.nan, index=returns.index, dtype=float)
                usd_return = pd.Series(np.nan, index=returns.index, dtype=float)
                valid = local_return.notna() & fx.notna()
                fx_return.loc[valid] = fx.loc[valid]
                usd_return.loc[valid] = (1 + local_return.loc[valid]) * (1 + fx_return.loc[valid]) - 1
            else:
                fx_return = pd.Series(0.0, index=returns.index, dtype=float)
                usd_return = local_return.copy()
            panel_records.append(
                pd.DataFrame(
                    {
                        "date": returns.index,
                        "asset": asset_name,
                        "region": config.region,
                        "price": monthly_prices[asset_name].reindex(returns.index),
                        "return_1m": usd_return.values,
                        "local_return_1m": local_return.values,
                        "fx_return": fx_return.values,
                    }
                )
            )

        return pd.concat(panel_records, ignore_index=True)

    def _feature_engineer(self, frame: pd.DataFrame, prefix: str) -> pd.DataFrame:
        engineered: dict[str, pd.Series] = {}
        for col in frame.columns:
            series = pd.to_numeric(frame[col], errors="coerce")
            engineered[f"{prefix}_{col}_level"] = series
            engineered[f"{prefix}_{col}_mom"] = series.diff(1)
            engineered[f"{prefix}_{col}_yoy"] = series.diff(12)
            rolling_mean = series.rolling(self.z_window, min_periods=12).mean()
            rolling_std = series.rolling(self.z_window, min_periods=12).std().replace(0, np.nan)
            engineered[f"{prefix}_{col}_z"] = (series - rolling_mean) / rolling_std
            engineered[f"{prefix}_{col}_pct"] = series.rank(pct=True)
        return pd.DataFrame(engineered, index=frame.index)

    def _lag_for_region(self, region: str) -> int:
        if isinstance(self.release_lag_months, dict):
            return self.release_lag_months.get(region, self.release_lag_months.get("default", 1))
        return self.release_lag_months
