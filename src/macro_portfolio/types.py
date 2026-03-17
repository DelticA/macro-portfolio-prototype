from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class AssetConfig:
    asset: str
    region: str
    sleeve: str
    min_weight: float = 0.0
    max_weight: float = 0.35

    @property
    def is_equity(self) -> bool:
        return self.sleeve in {"risk_core", "satellite"}

    @property
    def is_defensive(self) -> bool:
        return self.sleeve == "defensive"
