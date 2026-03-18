from __future__ import annotations

from dataclasses import dataclass

import pandas as pd


@dataclass
class RegimeDiagnostics:
    model_name: str
    details: dict


class BaseRegimeModel:
    name = "base"

    def fit_predict(self, features: pd.DataFrame) -> pd.DataFrame:
        raise NotImplementedError

    def diagnostics(self) -> RegimeDiagnostics:
        return RegimeDiagnostics(model_name=self.name, details={})
