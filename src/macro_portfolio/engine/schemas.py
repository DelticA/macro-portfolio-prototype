from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class RunCreateRequest(BaseModel):
    label: str | None = None


class RunResponse(BaseModel):
    run_id: str
    label: str | None = None
    status: str
    current_stage: str | None = None


class ProvidersRequest(BaseModel):
    start_date: str
    end_date: str
    csi300_code: str = "510300.SH"
    star50_code: str = "588000.SH"
    cgb_code: str = "511010.SH"
    hsi_code: str = "2800.HK"
    hstech_code: str = "3033.HK"
    fred_api_key: str | None = None
    us_macro_source: Literal["fred", "openbb"] = "fred"
    us_equity_source: Literal["stooq", "yahoo", "openbb"] = "stooq"
    us_bond_source: Literal["stooq", "yahoo", "openbb"] = "stooq"
    hk_equity_source: Literal["yahoo", "openbb"] = "yahoo"
    cn_equity_source: Literal["akshare"] = "akshare"
    cn_bond_source: Literal["akshare"] = "akshare"
    cn_macro_source: Literal["akshare"] = "akshare"
    other_assets_source: Literal["stooq", "yahoo", "openbb"] = "stooq"
    crypto_source: Literal["binance", "yahoo", "openbb"] = "binance"
    fx_source: Literal["fred", "yahoo", "openbb"] = "fred"
    selected_items: list[str] | None = None
    custom_equities: list[dict[str, str]] = Field(default_factory=list)


class DataRequest(BaseModel):
    us_release_lag: int = 1
    cn_release_lag: int = 0
    global_release_lag: int = 1
    z_window: int = 36


class DataSelectionRequest(BaseModel):
    start_date: str
    end_date: str
    display_series_ids: list[str] | None = None


class RegimeRequest(BaseModel):
    model_name: Literal["rule_based", "kmeans", "gmm"] = "rule_based"
    smoothing_window: int = 3
    n_states: int = 4
    feature_columns: list[str] | None = None


class PolicyRequest(BaseModel):
    model_name: Literal["template_rule", "risk_parity", "cvar"] = "cvar"
    portfolio_model: Literal["template_rule", "risk_parity", "cvar"] | None = None
    risk_model: Literal["none", "confidence_guard", "vol_target"] = "confidence_guard"
    execution_model: Literal["immediate"] = "immediate"
    training_window: int = 60
    transaction_cost_bps: float = 5.0
    overrides: dict[str, dict[str, float]] = Field(default_factory=dict)


class BacktestRequest(BaseModel):
    model_name: Literal["template_rule", "risk_parity", "cvar"] = "cvar"
    portfolio_model: Literal["template_rule", "risk_parity", "cvar"] | None = None
    risk_model: Literal["none", "confidence_guard", "vol_target"] = "confidence_guard"
    execution_model: Literal["immediate"] = "immediate"
    training_window: int = 60
    transaction_cost_bps: float = 5.0
    overrides: dict[str, dict[str, float]] = Field(default_factory=dict)


class StageResponse(BaseModel):
    run_id: str
    stage: str
    status: str
    summary: dict[str, Any]
