from __future__ import annotations

from pathlib import Path
import math
import shutil
from datetime import datetime

import pandas as pd

from ..backtest import BacktestEngine
from ..data import MacroDataset
from ..engine.artifacts import read_frame, read_json, write_frame, write_json
from ..engine.run_store import RunStore
from ..engine.schemas import BacktestRequest, DataRequest, PolicyRequest, ProvidersRequest, RegimeRequest
from ..live import DEFAULT_ASSETS
from ..policy import PolicyConfig
from ..providers import (
    AkshareClient,
    BinanceClient,
    DEFAULT_FRED_FX_SERIES,
    DEFAULT_FRED_SERIES,
    DEFAULT_STOOQ_SYMBOLS,
    DEFAULT_YAHOO_SYMBOLS,
    FredClient,
    OpenBBClient,
    StooqClient,
    YahooFinanceClient,
)
from .registry import build_policy_model, build_regime_model


class PipelineService:
    def __init__(self, run_store: RunStore) -> None:
        self.run_store = run_store

    def run_providers(self, run_id: str, request: ProvidersRequest) -> dict:
        stage = "providers"
        self.run_store.mark_stage(run_id, stage, "running")
        item_definitions = _provider_items_map(request)
        selected_items = request.selected_items or list(item_definitions.keys())
        self.run_store.log(run_id, stage, f"Fetching data for {request.start_date} -> {request.end_date} | items={','.join(selected_items)}")

        try:
            stage_dir = self.run_store.stage_dir(run_id, stage)
            items_dir = self.run_store.stage_dir(run_id, stage) / "items"
            items_dir.mkdir(parents=True, exist_ok=True)

            for item_id in selected_items:
                item_frame = self._fetch_provider_item(item_id, request, item_definitions)
                write_frame(item_frame, items_dir / f"{item_id}.csv")
                self.run_store.log(run_id, stage, f"Fetched {item_id}")

            us_macro, cn_macro, global_prices, cn_assets = self._assemble_provider_artifacts(items_dir, item_definitions)
            write_frame(us_macro, stage_dir / "us_macro.csv")
            write_frame(cn_macro, stage_dir / "cn_macro.csv")
            write_frame(global_prices, stage_dir / "global_prices.csv")
            write_frame(cn_assets, stage_dir / "cn_assets.csv")

            catalog = self._provider_catalog(items_dir, request, item_definitions)
            write_json(catalog, stage_dir / "catalog.json")
            self.run_store.log(run_id, stage, "Provider stage finished successfully")
            self.run_store.mark_stage(run_id, stage, "success", {"summary": catalog})
            return catalog
        except Exception as exc:
            return self._fail_stage(run_id, stage, exc)

    def run_data(self, run_id: str, request: DataRequest) -> dict:
        stage = "data"
        self.run_store.mark_stage(run_id, stage, "running")
        self.run_store.log(run_id, stage, "Building aligned monthly features and asset panels")

        try:
            self._require_stage_success(run_id, "providers")
            providers_dir = self.run_store.stage_dir(run_id, "providers")
            us_macro = read_frame(providers_dir / "us_macro.csv")
            cn_macro = read_frame(providers_dir / "cn_macro.csv")
            global_prices = read_frame(providers_dir / "global_prices.csv")
            cn_assets = read_frame(providers_dir / "cn_assets.csv")

            dataset = MacroDataset(
                release_lag_months={"US": request.us_release_lag, "CN": request.cn_release_lag, "GLOBAL": request.global_release_lag, "default": 1},
                release_date_regions=frozenset({"CN"}),
                z_window=request.z_window,
            )
            features = dataset.build_feature_table({"US": us_macro, "CN": cn_macro})
            merged_prices = pd.concat([global_prices.drop(columns=["USDCNY"], errors="ignore"), cn_assets], axis=1).sort_index()
            required_assets = [asset.asset for asset in DEFAULT_ASSETS]
            merged_prices = merged_prices[[column for column in merged_prices.columns if column in required_assets]]
            usdcny = global_prices["USDCNY"].dropna()
            cnyusd = (1 / usdcny).rename("CNYUSD")
            fx_returns = cnyusd.resample("ME").last().pct_change()
            asset_panel = dataset.build_asset_panel(merged_prices, DEFAULT_ASSETS, fx_returns=fx_returns)
            asset_returns = asset_panel.pivot(index="date", columns="asset", values="return_1m").sort_index()

            stage_dir = self.run_store.stage_dir(run_id, stage)
            write_frame(features, stage_dir / "features.csv")
            write_frame(asset_panel, stage_dir / "asset_panel.csv")
            write_frame(asset_returns, stage_dir / "asset_returns.csv")
            summary = {
                "feature_columns": list(features.columns[:12]),
                "feature_rows": int(len(features)),
                "asset_panel_rows": int(len(asset_panel)),
                "asset_names": list(asset_returns.columns),
                "raw_datasets": {
                    "us_macro": _frame_summary("us_macro", us_macro),
                    "cn_macro": _frame_summary("cn_macro", cn_macro),
                    "global_prices": _frame_summary("global_prices", global_prices),
                    "cn_assets": _frame_summary("cn_assets", cn_assets),
                },
                "processed_datasets": {
                    "features": _frame_summary("features", features),
                    "asset_returns": _frame_summary("asset_returns", asset_returns),
                    "asset_panel": _column_date_summary("asset_panel", asset_panel, "date"),
                },
            }
            summary["intersections"] = {
                "raw": _intersection_summary(summary["raw_datasets"]),
                "processed": _intersection_summary(summary["processed_datasets"]),
            }
            summary["timeline"] = _build_timeline(us_macro, cn_macro, global_prices, cn_assets)
            summary["series_groups"] = _build_series_groups(us_macro, cn_macro, global_prices, cn_assets)
            write_json(summary, stage_dir / "summary.json")
            self.run_store.log(run_id, stage, f"Data stage produced {len(features)} feature rows")
            self.run_store.mark_stage(run_id, stage, "success", {"summary": summary})
            return summary
        except Exception as exc:
            return self._fail_stage(run_id, stage, exc)

    def load_providers_from_run(self, run_id: str, source_run_id: str) -> dict:
        stage = "providers"
        self._require_stage_success(source_run_id, stage)
        self.run_store.mark_stage(run_id, stage, "running")
        self.run_store.log(run_id, stage, f"Loading providers artifacts from existing run {source_run_id}")
        try:
            source_dir = self.run_store.stage_dir(source_run_id, stage)
            target_dir = self.run_store.stage_dir(run_id, stage)
            if target_dir.exists():
                shutil.rmtree(target_dir)
            shutil.copytree(source_dir, target_dir, copy_function=shutil.copy2)

            source_log = self.run_store.run_dir(source_run_id) / "logs" / f"{stage}.log"
            target_log = self.run_store.run_dir(run_id) / "logs" / f"{stage}.log"
            target_log.parent.mkdir(parents=True, exist_ok=True)
            if source_log.exists():
                shutil.copy2(source_log, target_log)
                self.run_store.log(run_id, stage, f"Reused providers log from {source_run_id}")

            catalog = read_json(target_dir / "catalog.json")
            catalog["loaded_from_run"] = source_run_id
            write_json(catalog, target_dir / "catalog.json")
            self.run_store.mark_stage(run_id, stage, "success", {"summary": catalog})
            return catalog
        except Exception as exc:
            return self._fail_stage(run_id, stage, exc)

    def run_regime(self, run_id: str, request: RegimeRequest) -> dict:
        stage = "regime"
        self.run_store.mark_stage(run_id, stage, "running")
        self.run_store.log(run_id, stage, f"Running regime model {request.model_name}")

        try:
            self._require_stage_success(run_id, "data")
            data_dir = self.run_store.stage_dir(run_id, "data")
            features = read_frame(data_dir / "features.csv")
            if request.feature_columns:
                selected = [column for column in request.feature_columns if column in features.columns]
                if selected:
                    features = features[selected]
                    self.run_store.log(run_id, stage, f"Using {len(selected)} selected feature columns")
            model = build_regime_model(request.model_name, smoothing_window=request.smoothing_window, n_states=request.n_states)
            regime = model.fit_predict(features)

            stage_dir = self.run_store.stage_dir(run_id, stage)
            write_frame(regime, stage_dir / "regime.csv")
            diagnostics = model.diagnostics().details
            diagnostics["available_models"] = ["rule_based", "kmeans", "gmm"]
            diagnostics["counts"] = regime["portfolio_regime"].value_counts().to_dict()
            write_json(diagnostics, stage_dir / "diagnostics.json")
            summary = {
                "model_name": request.model_name,
                "latest_regime": str(regime["portfolio_regime"].iloc[-1]),
                "latest_confidence": float(regime["regime_confidence"].iloc[-1]),
                "counts": diagnostics["counts"],
            }
            write_json(summary, stage_dir / "summary.json")
            self.run_store.mark_stage(run_id, stage, "success", {"summary": summary})
            return summary
        except Exception as exc:
            return self._fail_stage(run_id, stage, exc)

    def run_policy(self, run_id: str, request: PolicyRequest) -> dict:
        stage = "policy"
        self.run_store.mark_stage(run_id, stage, "running")
        self.run_store.log(run_id, stage, f"Allocating weights with {request.model_name}")

        try:
            self._require_stage_success(run_id, "data")
            self._require_stage_success(run_id, "regime")
            asset_returns = read_frame(self.run_store.stage_dir(run_id, "data") / "asset_returns.csv")
            regime = read_frame(self.run_store.stage_dir(run_id, "regime") / "regime.csv")
            config = self._policy_config(request.overrides)
            model = build_policy_model(request.model_name, DEFAULT_ASSETS, config)

            aligned_dates = asset_returns.index.intersection(regime.index)
            history = asset_returns.loc[aligned_dates].iloc[-request.training_window :]
            latest_signal = regime.loc[aligned_dates].iloc[-1]
            weights = model.allocate(
                history,
                str(latest_signal["portfolio_regime"]),
                float(latest_signal["regime_confidence"]),
                None,
            )
            frame = weights.rename("target_weight").reset_index().rename(columns={"index": "asset"})
            frame["lower_bound"] = frame["asset"].map({asset.asset: asset.min_weight for asset in DEFAULT_ASSETS})
            frame["upper_bound"] = frame["asset"].map({asset.asset: asset.max_weight for asset in DEFAULT_ASSETS})

            stage_dir = self.run_store.stage_dir(run_id, stage)
            write_frame(frame, stage_dir / "weights_target.csv")
            summary = {
                "model_name": request.model_name,
                "latest_regime": str(latest_signal["portfolio_regime"]),
                "top_weights": frame.sort_values("target_weight", ascending=False).head(5).to_dict(orient="records"),
            }
            write_json(summary, stage_dir / "summary.json")
            self.run_store.mark_stage(run_id, stage, "success", {"summary": summary})
            return summary
        except Exception as exc:
            return self._fail_stage(run_id, stage, exc)

    def run_backtest(self, run_id: str, request: BacktestRequest) -> dict:
        stage = "backtest"
        self.run_store.mark_stage(run_id, stage, "running")
        self.run_store.log(run_id, stage, f"Running backtest with {request.model_name}")

        try:
            self._require_stage_success(run_id, "data")
            self._require_stage_success(run_id, "regime")
            asset_returns = read_frame(self.run_store.stage_dir(run_id, "data") / "asset_returns.csv")
            regime = read_frame(self.run_store.stage_dir(run_id, "regime") / "regime.csv")
            policy_config = self._policy_config(request.overrides)
            model = build_policy_model(request.model_name, DEFAULT_ASSETS, policy_config)

            engine = BacktestEngine(
                _BacktestPolicyAdapter(model),
                training_window=request.training_window,
                transaction_cost_bps=request.transaction_cost_bps,
            )
            result = engine.run(asset_returns, regime)

            stage_dir = self.run_store.stage_dir(run_id, stage)
            write_frame(result.nav.to_frame(name="nav"), stage_dir / "nav.csv")
            write_frame(result.weights, stage_dir / "weights.csv")
            write_frame(result.benchmarks, stage_dir / "benchmarks.csv")
            write_frame(result.attribution, stage_dir / "attribution.csv")
            write_json(result.metrics.to_dict(), stage_dir / "metrics.json")
            summary = {
                "model_name": request.model_name,
                "metrics": {key: float(value) for key, value in result.metrics.to_dict().items()},
                "nav_rows": int(len(result.nav)),
            }
            write_json(summary, stage_dir / "summary.json")
            self.run_store.mark_stage(run_id, stage, "success", {"summary": summary})
            return summary
        except Exception as exc:
            return self._fail_stage(run_id, stage, exc)

    def get_stage_payload(self, run_id: str, stage: str) -> dict:
        stage_dir = self.run_store.stage_dir(run_id, stage)
        metadata = self.run_store.load_metadata(run_id)
        payload: dict[str, object] = {"stage": stage, "status": metadata["stages"][stage]["status"]}
        if (stage_dir / "summary.json").exists():
            payload["summary"] = read_json(stage_dir / "summary.json")
        elif (stage_dir / "catalog.json").exists():
            payload["summary"] = read_json(stage_dir / "catalog.json")
        else:
            payload["summary"] = metadata["stages"][stage].get("summary", {})
        payload["preview"] = self._stage_preview(stage_dir)
        payload["log"] = self._stage_log(run_id, stage)
        return _json_safe(payload)

    def _stage_preview(self, stage_dir: Path) -> dict[str, list[dict]]:
        preview = {}
        for csv_path in sorted(stage_dir.glob("*.csv")):
            frame = read_frame(csv_path)
            preview_frame = frame.reset_index()
            first_column = preview_frame.columns[0]
            if str(first_column).startswith("Unnamed"):
                preview_frame = preview_frame.rename(columns={first_column: "date"})
            if first_column == "index" and "date" in preview_frame.columns:
                preview_frame = preview_frame.drop(columns=["index"])
            preview[csv_path.stem] = _json_safe(preview_frame.head(8).to_dict(orient="records"))
        return preview

    def _stage_log(self, run_id: str, stage: str) -> str:
        path = self.run_store.run_dir(run_id) / "logs" / f"{stage}.log"
        return path.read_text(encoding="utf-8") if path.exists() else ""

    def _policy_config(self, overrides: dict[str, dict[str, float]]) -> PolicyConfig:
        config = PolicyConfig()
        for field, value in overrides.get("policy_config", {}).items():
            if hasattr(config, field):
                setattr(config, field, value)
        return config

    def _require_stage_success(self, run_id: str, stage: str) -> None:
        metadata = self.run_store.load_metadata(run_id)
        status = metadata["stages"].get(stage, {}).get("status")
        if status != "success":
            raise ValueError(f"Stage '{stage}' must complete successfully before this step runs.")

    def _fail_stage(self, run_id: str, stage: str, exc: Exception) -> dict:
        message = f"{type(exc).__name__}: {exc}"
        self.run_store.log(run_id, stage, message)
        self.run_store.mark_stage(run_id, stage, "failed", {"summary": {"error": message}})
        raise exc

    def _fetch_provider_item(self, item_id: str, request: ProvidersRequest, item_definitions: dict[str, dict]) -> pd.DataFrame:
        if item_id not in item_definitions:
            raise ValueError(f"Unknown provider item: {item_id}")
        item = item_definitions[item_id]
        source = getattr(request, item["source_field"], item["sources"][0])
        kind = item["kind"]
        if kind == "us_macro":
            return self._fetch_us_macro_item(item["alias"], source, request)
        if kind == "cn_macro":
            return self._fetch_cn_macro_item(item["alias"])
        if kind == "us_asset":
            return self._fetch_us_asset_item(item["column"], source, request)
        if kind == "hk_asset":
            symbol = getattr(request, item["code_field"], item["symbol"]) if item.get("code_field") else item["symbol"]
            return self._fetch_generic_equity_item(item["column"], symbol, source, request)
        if kind == "cn_asset":
            return self._fetch_cn_asset_item(item["column"], request)
        if kind == "custom_equity":
            return self._fetch_generic_equity_item(item["column"], item["symbol"], source, request)
        if kind == "crypto":
            return self._fetch_crypto_item(source, request)
        if kind == "fx":
            return self._fetch_fx_item(source, request)
        raise ValueError(f"Unsupported provider item kind: {kind}")

    def _fetch_us_macro_item(self, alias: str, source: str, request: ProvidersRequest) -> pd.DataFrame:
        mapping = {alias: DEFAULT_FRED_SERIES["US"][alias]}
        if source == "openbb":
            return OpenBBClient().fetch_fred_series(mapping, start_date=request.start_date, end_date=request.end_date)
        return FredClient(api_key=request.fred_api_key or None).fetch_series(mapping, start_date=request.start_date, end_date=request.end_date)

    def _fetch_cn_macro_item(self, alias: str) -> pd.DataFrame:
        return AkshareClient().fetch_cn_macro([alias])

    def _fetch_us_asset_item(self, column: str, source: str, request: ProvidersRequest) -> pd.DataFrame:
        yahoo_symbol = "BTC-USD" if column == "BTC" else column
        if source == "openbb":
            asset_class = "currency" if column == "USDCNY" else "equity"
            symbol = "USDCNY=X" if column == "USDCNY" else yahoo_symbol
            return OpenBBClient().fetch_price_history({column: symbol}, start_date=request.start_date, end_date=request.end_date, asset_class=asset_class).resample("ME").last()
        if source == "yahoo":
            symbol = "CNY=X" if column == "USDCNY" else yahoo_symbol
            frame = YahooFinanceClient().fetch_close_prices({column: symbol}, start_date=request.start_date, end_date=request.end_date, interval="1mo").resample("ME").last()
            if column == "USDCNY":
                frame[column] = 1 / frame[column]
            return frame
        frame = StooqClient().fetch_close_prices({column: DEFAULT_STOOQ_SYMBOLS[column]}).resample("ME").last()
        frame = frame.loc[frame.index >= pd.Timestamp(request.start_date)]
        frame = frame.loc[frame.index <= pd.Timestamp(request.end_date)]
        return frame

    def _fetch_cn_asset_item(self, column: str, request: ProvidersRequest) -> pd.DataFrame:
        frame = AkshareClient().fetch_cn_assets(
            request.csi300_code,
            request.star50_code,
            request.cgb_code,
            request.start_date,
            request.end_date,
        )
        return frame[[column]]

    def _fetch_generic_equity_item(self, column: str, symbol: str, source: str, request: ProvidersRequest) -> pd.DataFrame:
        if source == "openbb":
            return OpenBBClient().fetch_price_history({column: symbol}, start_date=request.start_date, end_date=request.end_date, asset_class="equity")
        try:
            return YahooFinanceClient().fetch_close_prices({column: symbol}, start_date=request.start_date, end_date=request.end_date, interval="1d")
        except Exception:
            return OpenBBClient().fetch_price_history({column: symbol}, start_date=request.start_date, end_date=request.end_date, asset_class="equity")

    def _fetch_crypto_item(self, source: str, request: ProvidersRequest) -> pd.DataFrame:
        if source == "openbb":
            return OpenBBClient().fetch_price_history({"BTC": "BTC-USD"}, start_date=request.start_date, end_date=request.end_date, asset_class="crypto").resample("ME").last()
        if source == "yahoo":
            return YahooFinanceClient().fetch_close_prices({"BTC": "BTC-USD"}, start_date=request.start_date, end_date=request.end_date, interval="1mo").resample("ME").last()
        return BinanceClient().fetch_btc_prices(start_date=request.start_date, end_date=request.end_date).to_frame(name="BTC")

    def _fetch_fx_item(self, source: str, request: ProvidersRequest) -> pd.DataFrame:
        if source == "openbb":
            return OpenBBClient().fetch_price_history({"USDCNY": "USDCNY=X"}, start_date=request.start_date, end_date=request.end_date, asset_class="currency").resample("ME").last()
        if source == "yahoo":
            frame = YahooFinanceClient().fetch_close_prices({"USDCNY": "CNY=X"}, start_date=request.start_date, end_date=request.end_date, interval="1mo").resample("ME").last()
            frame["USDCNY"] = 1 / frame["USDCNY"]
            return frame
        return FredClient(api_key=request.fred_api_key or None).fetch_series(DEFAULT_FRED_FX_SERIES, start_date=request.start_date, end_date=request.end_date).resample("ME").last()

    def _assemble_provider_artifacts(self, items_dir: Path, item_definitions: dict[str, dict]) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame]:
        us_macro_parts = []
        cn_macro_parts = []
        global_price_parts = []
        cn_asset_parts = []
        for item_id, item in item_definitions.items():
            path = items_dir / f"{item_id}.csv"
            if not path.exists():
                continue
            frame = read_frame(path)
            if item["kind"] == "us_macro":
                us_macro_parts.append(frame)
            elif item["kind"] == "cn_macro":
                cn_macro_parts.append(frame)
            elif item["kind"] in {"us_asset", "hk_asset", "custom_equity", "crypto", "fx"}:
                global_price_parts.append(frame)
            elif item["kind"] == "cn_asset":
                cn_asset_parts.append(frame)
        return (
            pd.concat(us_macro_parts, axis=1).sort_index() if us_macro_parts else pd.DataFrame(),
            pd.concat(cn_macro_parts, axis=1).sort_index() if cn_macro_parts else pd.DataFrame(),
            pd.concat(global_price_parts, axis=1).sort_index() if global_price_parts else pd.DataFrame(),
            pd.concat(cn_asset_parts, axis=1).sort_index() if cn_asset_parts else pd.DataFrame(),
        )

    def _provider_catalog(self, items_dir: Path, request: ProvidersRequest, item_definitions: dict[str, dict]) -> dict:
        return {"categories": [_provider_group_payload(group, items_dir, request, item_definitions) for group in _provider_groups(request)]}


class _BacktestPolicyAdapter:
    def __init__(self, model) -> None:
        self.model = model

    def target_weights(self, returns_window, portfolio_regime, confidence, current_weights=None):
        return self.model.allocate(returns_window, portfolio_regime, confidence, current_weights)


def _frame_summary(name: str, frame: pd.DataFrame) -> dict:
    return {
        "name": name,
        "rows": int(len(frame)),
        "columns": list(frame.columns),
        "start": str(frame.index.min()) if len(frame.index) else None,
        "end": str(frame.index.max()) if len(frame.index) else None,
        "missing_ratio": float(frame.isna().mean().mean()) if not frame.empty else 0.0,
        "frequency": _infer_frequency_label(frame),
    }


def _provider_item_summary(
    label: str,
    source: str,
    frame: pd.DataFrame,
    artifact: str,
    column_name: str,
    *,
    status: str | None = None,
) -> dict:
    has_rows = not frame.empty
    non_null_count = int(frame.notna().sum().sum()) if has_rows else 0
    return {
        "label": label,
        "source": source,
        "artifact": artifact,
        "column": column_name,
        "status": status or ("success" if has_rows and non_null_count > 0 else "failed"),
        "rows": int(len(frame)),
        "non_null": non_null_count,
        "start": str(frame.index.min()) if has_rows else None,
        "end": str(frame.index.max()) if has_rows else None,
        "frequency": _infer_frequency_label(frame),
    }


def _json_safe(value):
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    if value is pd.NA:
        return None
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    return value


PROVIDER_ITEMS = {
    "tlt": {"label": "美国国债 ETF (TLT)", "group": "债券", "category": "资产数据", "artifact": "global_prices.csv", "column": "TLT", "kind": "us_asset", "source_field": "us_bond_source", "sources": ["stooq", "yahoo", "openbb"], "quote_unit": "USD", "research_note": "原始数据为美元计价；进入 data 阶段后直接作为美元资产处理。"},
    "cgb": {"label": "中国国债 ETF", "group": "债券", "category": "资产数据", "artifact": "cn_assets.csv", "column": "CGB", "kind": "cn_asset", "source_field": "cn_bond_source", "sources": ["akshare"], "quote_unit": "CNY", "research_note": "原始数据为人民币计价；进入 data 阶段后按 USD 研究口径换算收益。", "code_field": "cgb_code", "code_label": "中债 ETF 代码"},
    "spy": {"label": "标普500 ETF (SPY)", "group": "股票", "category": "资产数据", "artifact": "global_prices.csv", "column": "SPY", "kind": "us_asset", "source_field": "us_equity_source", "sources": ["stooq", "yahoo", "openbb"], "quote_unit": "USD", "research_note": "原始数据为美元计价。"},
    "qqq": {"label": "纳斯达克100 ETF (QQQ)", "group": "股票", "category": "资产数据", "artifact": "global_prices.csv", "column": "QQQ", "kind": "us_asset", "source_field": "us_equity_source", "sources": ["stooq", "yahoo", "openbb"], "quote_unit": "USD", "research_note": "原始数据为美元计价。"},
    "csi300": {"label": "沪深300 ETF", "group": "股票", "category": "资产数据", "artifact": "cn_assets.csv", "column": "CSI300", "kind": "cn_asset", "source_field": "cn_equity_source", "sources": ["akshare"], "quote_unit": "CNY", "research_note": "原始数据为人民币计价；进入 data 阶段后按 USD 研究口径换算收益。", "code_field": "csi300_code", "code_label": "沪深300 ETF 代码"},
    "star50": {"label": "科创50 ETF", "group": "股票", "category": "资产数据", "artifact": "cn_assets.csv", "column": "STAR50", "kind": "cn_asset", "source_field": "cn_equity_source", "sources": ["akshare"], "quote_unit": "CNY", "research_note": "原始数据为人民币计价；进入 data 阶段后按 USD 研究口径换算收益。", "code_field": "star50_code", "code_label": "科创50 ETF 代码"},
    "hsi_hk": {"label": "恒生指数 ETF", "group": "股票", "category": "资产数据", "artifact": "global_prices.csv", "column": "HSI_HK", "symbol": "2800.HK", "kind": "hk_asset", "source_field": "hk_equity_source", "sources": ["yahoo", "openbb"], "quote_unit": "HKD", "research_note": "原始数据为港币计价。", "code_field": "hsi_code", "code_label": "恒生 ETF 代码"},
    "hstech_hk": {"label": "恒生科技 ETF", "group": "股票", "category": "资产数据", "artifact": "global_prices.csv", "column": "HSTECH_HK", "symbol": "3033.HK", "kind": "hk_asset", "source_field": "hk_equity_source", "sources": ["yahoo", "openbb"], "quote_unit": "HKD", "research_note": "原始数据为港币计价。", "code_field": "hstech_code", "code_label": "恒生科技 ETF 代码"},
    "gld": {"label": "黄金 ETF (GLD)", "group": "其他资产", "category": "资产数据", "artifact": "global_prices.csv", "column": "GLD", "kind": "us_asset", "source_field": "other_assets_source", "sources": ["stooq", "yahoo", "openbb"], "quote_unit": "USD", "research_note": "原始数据为美元计价。"},
    "slv": {"label": "白银 ETF (SLV)", "group": "其他资产", "category": "资产数据", "artifact": "global_prices.csv", "column": "SLV", "kind": "us_asset", "source_field": "other_assets_source", "sources": ["stooq", "yahoo", "openbb"], "quote_unit": "USD", "research_note": "原始数据为美元计价。"},
    "dbc": {"label": "商品 ETF (DBC)", "group": "其他资产", "category": "资产数据", "artifact": "global_prices.csv", "column": "DBC", "kind": "us_asset", "source_field": "other_assets_source", "sources": ["stooq", "yahoo", "openbb"], "quote_unit": "USD", "research_note": "原始数据为美元计价。"},
    "uso": {"label": "原油 ETF (USO)", "group": "其他资产", "category": "资产数据", "artifact": "global_prices.csv", "column": "USO", "kind": "us_asset", "source_field": "other_assets_source", "sources": ["stooq", "yahoo", "openbb"], "quote_unit": "USD", "research_note": "原始数据为美元计价。"},
    "btc": {"label": "比特币", "group": "其他资产", "category": "资产数据", "artifact": "global_prices.csv", "column": "BTC", "kind": "crypto", "source_field": "crypto_source", "sources": ["binance", "yahoo", "openbb"], "quote_unit": "USD", "research_note": "原始数据统一按美元口径拉取。"},
    "us_ip": {"label": "工业生产", "group": "美国", "category": "宏观经济数据", "artifact": "us_macro.csv", "column": "ip", "kind": "us_macro", "alias": "ip", "source_field": "us_macro_source", "sources": ["fred", "openbb"], "quote_unit": "-", "research_note": "宏观原始口径保留，不做货币换算。"},
    "us_payroll": {"label": "非农就业", "group": "美国", "category": "宏观经济数据", "artifact": "us_macro.csv", "column": "payroll", "kind": "us_macro", "alias": "payroll", "source_field": "us_macro_source", "sources": ["fred", "openbb"], "quote_unit": "-", "research_note": "宏观原始口径保留，不做货币换算。"},
    "us_unemployment": {"label": "失业率", "group": "美国", "category": "宏观经济数据", "artifact": "us_macro.csv", "column": "unemployment", "kind": "us_macro", "alias": "unemployment", "source_field": "us_macro_source", "sources": ["fred", "openbb"], "quote_unit": "-", "research_note": "宏观原始口径保留，不做货币换算。"},
    "us_cpi": {"label": "CPI", "group": "美国", "category": "宏观经济数据", "artifact": "us_macro.csv", "column": "cpi", "kind": "us_macro", "alias": "cpi", "source_field": "us_macro_source", "sources": ["fred", "openbb"], "quote_unit": "-", "research_note": "宏观原始口径保留，不做货币换算。"},
    "us_core_cpi": {"label": "核心 CPI", "group": "美国", "category": "宏观经济数据", "artifact": "us_macro.csv", "column": "core_cpi", "kind": "us_macro", "alias": "core_cpi", "source_field": "us_macro_source", "sources": ["fred", "openbb"], "quote_unit": "-", "research_note": "宏观原始口径保留，不做货币换算。"},
    "us_m2": {"label": "M2", "group": "美国", "category": "宏观经济数据", "artifact": "us_macro.csv", "column": "m2", "kind": "us_macro", "alias": "m2", "source_field": "us_macro_source", "sources": ["fred", "openbb"], "quote_unit": "-", "research_note": "宏观原始口径保留，不做货币换算。"},
    "us_fed_funds": {"label": "联邦基金利率", "group": "美国", "category": "宏观经济数据", "artifact": "us_macro.csv", "column": "fed_funds", "kind": "us_macro", "alias": "fed_funds", "source_field": "us_macro_source", "sources": ["fred", "openbb"], "quote_unit": "-", "research_note": "宏观原始口径保留，不做货币换算。"},
    "us_yield_10y": {"label": "10Y 国债收益率", "group": "美国", "category": "宏观经济数据", "artifact": "us_macro.csv", "column": "yield_10y", "kind": "us_macro", "alias": "yield_10y", "source_field": "us_macro_source", "sources": ["fred", "openbb"], "quote_unit": "-", "research_note": "宏观原始口径保留，不做货币换算。"},
    "us_yield_2y": {"label": "2Y 国债收益率", "group": "美国", "category": "宏观经济数据", "artifact": "us_macro.csv", "column": "yield_2y", "kind": "us_macro", "alias": "yield_2y", "source_field": "us_macro_source", "sources": ["fred", "openbb"], "quote_unit": "-", "research_note": "宏观原始口径保留，不做货币换算。"},
    "us_term_spread": {"label": "期限利差", "group": "美国", "category": "宏观经济数据", "artifact": "us_macro.csv", "column": "term_spread", "kind": "us_macro", "alias": "term_spread", "source_field": "us_macro_source", "sources": ["fred", "openbb"], "quote_unit": "-", "research_note": "宏观原始口径保留，不做货币换算。"},
    "us_breakeven_5y": {"label": "5Y Breakeven", "group": "美国", "category": "宏观经济数据", "artifact": "us_macro.csv", "column": "breakeven_5y", "kind": "us_macro", "alias": "breakeven_5y", "source_field": "us_macro_source", "sources": ["fred", "openbb"], "quote_unit": "-", "research_note": "宏观原始口径保留，不做货币换算。"},
    "cn_pmi": {"label": "PMI", "group": "中国", "category": "宏观经济数据", "artifact": "cn_macro.csv", "column": "pmi", "kind": "cn_macro", "alias": "pmi", "source_field": "cn_macro_source", "sources": ["akshare"], "quote_unit": "-", "research_note": "宏观原始口径保留，不做货币换算。"},
    "cn_cpi": {"label": "CPI", "group": "中国", "category": "宏观经济数据", "artifact": "cn_macro.csv", "column": "cpi", "kind": "cn_macro", "alias": "cpi", "source_field": "cn_macro_source", "sources": ["akshare"], "quote_unit": "-", "research_note": "宏观原始口径保留，不做货币换算。"},
    "cn_ppi": {"label": "PPI", "group": "中国", "category": "宏观经济数据", "artifact": "cn_macro.csv", "column": "ppi", "kind": "cn_macro", "alias": "ppi", "source_field": "cn_macro_source", "sources": ["akshare"], "quote_unit": "-", "research_note": "宏观原始口径保留，不做货币换算。"},
    "cn_m2": {"label": "M2", "group": "中国", "category": "宏观经济数据", "artifact": "cn_macro.csv", "column": "m2", "kind": "cn_macro", "alias": "m2", "source_field": "cn_macro_source", "sources": ["akshare"], "quote_unit": "-", "research_note": "宏观原始口径保留，不做货币换算。"},
    "cn_industrial": {"label": "工业增加值", "group": "中国", "category": "宏观经济数据", "artifact": "cn_macro.csv", "column": "industrial", "kind": "cn_macro", "alias": "industrial", "source_field": "cn_macro_source", "sources": ["akshare"], "quote_unit": "-", "research_note": "宏观原始口径保留，不做货币换算。"},
    "cn_gdp": {"label": "GDP", "group": "中国", "category": "宏观经济数据", "artifact": "cn_macro.csv", "column": "gdp", "kind": "cn_macro", "alias": "gdp", "source_field": "cn_macro_source", "sources": ["akshare"], "quote_unit": "-", "research_note": "宏观原始口径保留，不做货币换算。"},
    "cn_non_man_pmi": {"label": "非制造业 PMI", "group": "中国", "category": "宏观经济数据", "artifact": "cn_macro.csv", "column": "non_man_pmi", "kind": "cn_macro", "alias": "non_man_pmi", "source_field": "cn_macro_source", "sources": ["akshare"], "quote_unit": "-", "research_note": "服务和建筑景气补充。"},
    "cn_exports_yoy": {"label": "出口同比", "group": "中国", "category": "宏观经济数据", "artifact": "cn_macro.csv", "column": "exports_yoy", "kind": "cn_macro", "alias": "exports_yoy", "source_field": "cn_macro_source", "sources": ["akshare"], "quote_unit": "-", "research_note": "外需与制造业景气补充。"},
    "cn_imports_yoy": {"label": "进口同比", "group": "中国", "category": "宏观经济数据", "artifact": "cn_macro.csv", "column": "imports_yoy", "kind": "cn_macro", "alias": "imports_yoy", "source_field": "cn_macro_source", "sources": ["akshare"], "quote_unit": "-", "research_note": "内需与补库周期补充。"},
    "cn_retail_sales": {"label": "社零同比", "group": "中国", "category": "宏观经济数据", "artifact": "cn_macro.csv", "column": "retail_sales", "kind": "cn_macro", "alias": "retail_sales", "source_field": "cn_macro_source", "sources": ["akshare"], "quote_unit": "-", "research_note": "居民消费补充。"},
    "cn_new_credit": {"label": "新增人民币贷款", "group": "中国", "category": "宏观经济数据", "artifact": "cn_macro.csv", "column": "new_credit", "kind": "cn_macro", "alias": "new_credit", "source_field": "cn_macro_source", "sources": ["akshare"], "quote_unit": "-", "research_note": "信用脉冲补充。"},
    "cn_trade_balance": {"label": "贸易差额", "group": "中国", "category": "宏观经济数据", "artifact": "cn_macro.csv", "column": "trade_balance", "kind": "cn_macro", "alias": "trade_balance", "source_field": "cn_macro_source", "sources": ["akshare"], "quote_unit": "-", "research_note": "外贸总量补充。"},
    "usdcny": {"label": "美元兑人民币", "group": "美国", "category": "宏观经济数据", "artifact": "global_prices.csv", "column": "USDCNY", "kind": "fx", "source_field": "fx_source", "sources": ["fred", "yahoo", "openbb"], "quote_unit": "-", "research_note": "该序列只用于人民币资产换算到 USD 研究口径。"},
}

PROVIDER_GROUPS = [
    {"category": "资产数据", "group": "债券", "items": ["tlt", "cgb"]},
    {"category": "资产数据", "group": "股票", "items": ["spy", "qqq", "csi300", "star50", "hsi_hk", "hstech_hk"]},
    {"category": "资产数据", "group": "其他资产", "items": ["gld", "slv", "dbc", "uso", "btc"]},
    {"category": "宏观经济数据", "group": "美国", "items": ["us_ip", "us_payroll", "us_unemployment", "us_cpi", "us_core_cpi", "us_m2", "us_fed_funds", "us_yield_10y", "us_yield_2y", "us_term_spread", "us_breakeven_5y", "usdcny"]},
    {"category": "宏观经济数据", "group": "中国", "items": ["cn_pmi", "cn_non_man_pmi", "cn_cpi", "cn_ppi", "cn_m2", "cn_industrial", "cn_gdp", "cn_exports_yoy", "cn_imports_yoy", "cn_retail_sales", "cn_new_credit", "cn_trade_balance"]},
]

DEFAULT_PROVIDER_CODE_VALUES = {
    "csi300_code": "510300.SH",
    "star50_code": "588000.SH",
    "cgb_code": "511010.SH",
    "hsi_code": "2800.HK",
    "hstech_code": "3033.HK",
}

PIPELINE_SERVICE_METADATA = {
    "provider_tree": [
        {
            "category": category,
            "groups": [
                {
                    "group": group["group"],
                    "items": [
                        {
                            "id": item_id,
                            "label": PROVIDER_ITEMS[item_id]["label"],
                            "column": PROVIDER_ITEMS[item_id]["column"],
                            "sources": PROVIDER_ITEMS[item_id]["sources"],
                            "source_field": PROVIDER_ITEMS[item_id]["source_field"],
                            "artifact": PROVIDER_ITEMS[item_id]["artifact"],
                            "quote_unit": PROVIDER_ITEMS[item_id].get("quote_unit"),
                            "research_note": PROVIDER_ITEMS[item_id].get("research_note"),
                            "code_field": PROVIDER_ITEMS[item_id].get("code_field"),
                            "code_label": PROVIDER_ITEMS[item_id].get("code_label"),
                            "code_value": DEFAULT_PROVIDER_CODE_VALUES.get(PROVIDER_ITEMS[item_id].get("code_field")),
                            "supports_openbb": "openbb" in PROVIDER_ITEMS[item_id]["sources"],
                        }
                        for item_id in group["items"]
                    ],
                }
                for group in PROVIDER_GROUPS
                if group["category"] == category
            ],
        }
        for category in ["资产数据", "宏观经济数据"]
    ]
}


def _provider_groups(request: ProvidersRequest) -> list[dict]:
    groups = [dict(group) for group in PROVIDER_GROUPS]
    custom_ids = [item["id"] for item in _custom_provider_items(request).values()]
    if custom_ids:
        for group in groups:
            if group["category"] == "资产数据" and group["group"] == "股票":
                group["items"] = [*group["items"], *custom_ids]
                break
    return groups


def _provider_items_map(request: ProvidersRequest) -> dict[str, dict]:
    return {**PROVIDER_ITEMS, **_custom_provider_items(request)}


def _custom_provider_items(request: ProvidersRequest) -> dict[str, dict]:
    items: dict[str, dict] = {}
    for raw in request.custom_equities:
        symbol = str(raw.get("symbol", "")).strip()
        if not symbol:
            continue
        item_id = str(raw.get("id", "")).strip() or f"custom_{_safe_custom_id(symbol)}"
        label = str(raw.get("label", "")).strip() or symbol
        source = str(raw.get("source", "yahoo")).strip() or "yahoo"
        items[item_id] = {
            "id": item_id,
            "label": label,
            "group": "股票",
            "category": "资产数据",
            "artifact": "global_prices.csv",
            "column": item_id.upper(),
            "symbol": symbol,
            "kind": "custom_equity",
            "source_field": "custom_equity_source",
            "sources": [source] if source == "openbb" else ["yahoo", "openbb"],
            "quote_unit": _infer_quote_unit(symbol),
            "research_note": "按当前 run 自定义添加。",
            "code_field": None,
            "code_label": None,
            "is_custom": True,
        }
    return items


def _provider_group_payload(group: dict, items_dir: Path, request: ProvidersRequest, item_definitions: dict[str, dict]) -> dict:
    return {
        "category": group["category"],
        "group": group["group"],
        "items": [_provider_item_payload(item_id, items_dir, request, item_definitions) for item_id in group["items"]],
    }


def _provider_item_payload(item_id: str, items_dir: Path, request: ProvidersRequest, item_definitions: dict[str, dict]) -> dict:
    item = item_definitions[item_id]
    path = items_dir / f"{item_id}.csv"
    if path.exists():
        frame = read_frame(path)
        status = None
    else:
        frame = pd.DataFrame(columns=[item["column"]])
        status = "not_run"
    if item["kind"] == "custom_equity":
        source = next((raw.get("source") for raw in request.custom_equities if raw.get("id") == item_id), item["sources"][0])
    else:
        source = getattr(request, item["source_field"], item["sources"][0])
    payload = _provider_item_summary(item["label"], source, frame, item["artifact"], item["column"], status=status)
    payload["id"] = item_id
    payload["sources"] = item["sources"]
    payload["selected_source"] = source
    payload["quote_unit"] = item.get("quote_unit")
    payload["research_note"] = item.get("research_note")
    payload["code_field"] = item.get("code_field")
    payload["code_value"] = getattr(request, item["code_field"]) if item.get("code_field") else None
    payload["code_label"] = item.get("code_label")
    payload["symbol"] = item.get("symbol")
    payload["is_custom"] = item.get("is_custom", False)
    payload["supports_openbb"] = "openbb" in item["sources"]
    payload["last_updated"] = (
        datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds")
        if path.exists()
        else None
    )
    return payload


def _infer_frequency_label(frame: pd.DataFrame) -> str:
    if frame.empty or len(frame.index) < 2:
        return "未知"
    index = pd.Index(pd.to_datetime(frame.index)).sort_values()
    deltas = pd.Series(index[1:] - index[:-1]).dropna()
    if deltas.empty:
        return "未知"
    median_days = deltas.dt.total_seconds().median() / 86400
    if median_days <= 2:
        return "日频"
    if median_days <= 10:
        return "周频"
    if median_days <= 35:
        return "月频"
    if median_days <= 100:
        return "季频"
    return "低频"


def _column_date_summary(name: str, frame: pd.DataFrame, column: str) -> dict:
    if frame.empty or column not in frame.columns:
        return {"name": name, "rows": int(len(frame)), "columns": list(frame.columns), "start": None, "end": None, "missing_ratio": 0.0, "frequency": "未知"}
    indexed = frame.copy()
    indexed[column] = pd.to_datetime(indexed[column], errors="coerce")
    indexed = indexed.dropna(subset=[column]).set_index(column).sort_index()
    return _frame_summary(name, indexed)


def _intersection_summary(datasets: dict[str, dict]) -> dict:
    starts = [pd.Timestamp(item["start"]) for item in datasets.values() if item.get("start")]
    ends = [pd.Timestamp(item["end"]) for item in datasets.values() if item.get("end")]
    if not starts or not ends:
        return {"start": None, "end": None}
    start = max(starts)
    end = min(ends)
    if start > end:
        return {"start": None, "end": None}
    return {"start": str(start), "end": str(end)}


def _safe_custom_id(symbol: str) -> str:
    return "".join(char.lower() if char.isalnum() else "_" for char in symbol).strip("_")


def _infer_quote_unit(symbol: str) -> str:
    symbol = symbol.upper()
    if symbol.endswith(".HK"):
        return "HKD"
    if symbol.endswith(".SH") or symbol.endswith(".SZ"):
        return "CNY"
    return "USD"


# ---------------------------------------------------------------------------
# Timeline and series-group helpers
# ---------------------------------------------------------------------------

_SERIES_GROUP_MAP: dict[str, str] = {
    # US macro
    "ip": "growth", "payroll": "growth", "unemployment": "growth",
    "cpi": "inflation", "core_cpi": "inflation", "breakeven_5y": "inflation",
    "m2": "money_supply",
    "fed_funds": "rates", "yield_10y": "rates", "yield_2y": "rates", "term_spread": "rates",
    # CN macro
    "pmi": "growth", "non_man_pmi": "growth", "industrial": "growth", "gdp": "growth",
    "exports_yoy": "trade", "imports_yoy": "trade", "trade_balance": "trade",
    "retail_sales": "growth",
    "cn_cpi": "inflation", "cn_ppi": "inflation",
    "cn_m2": "money_supply", "new_credit": "credit",
    # Assets / prices
    "SPY": "asset_price", "QQQ": "asset_price", "TLT": "asset_price",
    "GLD": "asset_price", "SLV": "asset_price", "DBC": "asset_price",
    "USO": "asset_price", "BTC": "asset_price",
    "CSI300": "asset_price", "STAR50": "asset_price", "CGB": "asset_price",
    "HSI_HK": "asset_price", "HSTECH_HK": "asset_price",
    "USDCNY": "fx",
}

_GROUP_LABELS: dict[str, str] = {
    "asset_price": "资产价格",
    "rates": "利率 & 期限利差",
    "growth": "成长性指标",
    "inflation": "通胀指标",
    "money_supply": "货币供应",
    "trade": "贸易指标",
    "credit": "信贷指标",
    "fx": "汇率",
    "other": "其他",
}


def _build_series_groups(
    us_macro: pd.DataFrame,
    cn_macro: pd.DataFrame,
    global_prices: pd.DataFrame,
    cn_assets: pd.DataFrame,
) -> dict[str, str]:
    """Return {column_name: group_key} for all available columns."""
    result: dict[str, str] = {}
    for col in list(us_macro.columns) + list(cn_macro.columns):
        result[col] = _SERIES_GROUP_MAP.get(col, "other")
    for col in list(global_prices.columns) + list(cn_assets.columns):
        result[col] = _SERIES_GROUP_MAP.get(col, "asset_price")
    return result


def _build_timeline(
    us_macro: pd.DataFrame,
    cn_macro: pd.DataFrame,
    global_prices: pd.DataFrame,
    cn_assets: pd.DataFrame,
) -> dict:
    """Return a month-by-source coverage matrix for the alignment table."""
    sources = {
        "us_macro": us_macro,
        "cn_macro": cn_macro,
        "global_prices": global_prices,
        "cn_assets": cn_assets,
    }
    all_months: list[pd.Period] = []
    monthly_index: dict[str, pd.PeriodIndex] = {}
    for name, frame in sources.items():
        if frame.empty:
            monthly_index[name] = pd.PeriodIndex([], freq="M")
            continue
        try:
            idx = pd.DatetimeIndex(pd.to_datetime(frame.index, errors="coerce"))
            periods = idx.to_period("M").dropna().unique()
        except Exception:
            periods = pd.PeriodIndex([], freq="M")
        monthly_index[name] = periods
        all_months.extend(periods.tolist())
    if not all_months:
        return {"sources": list(sources.keys()), "months": [], "coverage": {}}
    all_unique = sorted(set(all_months))
    month_strs = [str(m) for m in all_unique]
    coverage: dict[str, list[bool]] = {}
    for name, periods in monthly_index.items():
        period_set = set(periods)
        coverage[name] = [m in period_set for m in all_unique]
    return {
        "sources": list(sources.keys()),
        "months": month_strs,
        "coverage": coverage,
        "group_labels": _GROUP_LABELS,
    }
