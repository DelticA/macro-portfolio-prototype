from __future__ import annotations

from pathlib import Path
import subprocess
import math
import pandas as pd

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from ..engine.run_store import RunStore
from ..engine.artifacts import read_frame, read_json
from ..engine.schemas import (
    BacktestRequest,
    DataRequest,
    PolicyRequest,
    ProvidersRequest,
    RegimeRequest,
    RunCreateRequest,
    RunResponse,
    StageResponse,
)
from ..providers import get_prefilled_secret_fields
from ..services.pipeline import PIPELINE_SERVICE_METADATA, PipelineService


ROOT = Path(__file__).resolve().parents[3]
STATIC_DIR = Path(__file__).resolve().parent / "static"
run_store = RunStore(ROOT / "runs")
pipeline = PipelineService(run_store)

app = FastAPI(title="Macro Portfolio Lab API", version="0.2.0")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.post("/api/runs", response_model=RunResponse)
def create_run(request: RunCreateRequest):
    run_id = run_store.create_run(request.label)
    metadata = run_store.load_metadata(run_id)
    return RunResponse(run_id=run_id, label=metadata.get("label"), status=metadata["status"], current_stage=metadata["current_stage"])


@app.get("/api/runs")
def list_runs():
    return {"items": run_store.list_runs()}


@app.get("/api/providers/config")
def get_providers_config():
    return {
        "prefilled_api_fields": get_prefilled_secret_fields(),
        "provider_tree": PIPELINE_SERVICE_METADATA["provider_tree"],
    }


@app.get("/api/runs/{run_id}")
def get_run(run_id: str):
    try:
        return run_store.load_metadata(run_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Run not found") from exc


@app.post("/api/runs/{run_id}/open")
def open_run_folder(run_id: str, target: str = "run"):
    run_dir = run_store.run_dir(run_id)
    if not run_dir.exists():
        raise HTTPException(status_code=404, detail="Run not found")
    targets = {
        "run": run_dir,
        "providers": run_dir / "providers",
        "data": run_dir / "data",
    }
    path = targets.get(target)
    if path is None:
        raise HTTPException(status_code=404, detail="Target folder not found")
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["open", str(path)], check=True)
    return {"ok": True, "path": str(path)}


@app.post("/api/runs/{run_id}/providers", response_model=StageResponse)
def run_providers(run_id: str, request: ProvidersRequest):
    return _stage_response(run_id, "providers", lambda: pipeline.run_providers(run_id, request))


@app.post("/api/runs/{run_id}/providers/load", response_model=StageResponse)
def load_providers(run_id: str, source_run_id: str):
    return _stage_response(run_id, "providers", lambda: pipeline.load_providers_from_run(run_id, source_run_id))


@app.post("/api/runs/{run_id}/data", response_model=StageResponse)
def run_data(run_id: str, request: DataRequest):
    return _stage_response(run_id, "data", lambda: pipeline.run_data(run_id, request))


@app.post("/api/runs/{run_id}/regime", response_model=StageResponse)
def run_regime(run_id: str, request: RegimeRequest):
    return _stage_response(run_id, "regime", lambda: pipeline.run_regime(run_id, request))


@app.post("/api/runs/{run_id}/policy", response_model=StageResponse)
def run_policy(run_id: str, request: PolicyRequest):
    return _stage_response(run_id, "policy", lambda: pipeline.run_policy(run_id, request))


@app.post("/api/runs/{run_id}/backtest", response_model=StageResponse)
def run_backtest(run_id: str, request: BacktestRequest):
    return _stage_response(run_id, "backtest", lambda: pipeline.run_backtest(run_id, request))


@app.get("/api/runs/{run_id}/stages/{stage}")
def get_stage(run_id: str, stage: str):
    if stage not in {"providers", "data", "regime", "policy", "backtest"}:
        raise HTTPException(status_code=404, detail="Stage not found")
    return pipeline.get_stage_payload(run_id, stage)


@app.get("/api/runs/{run_id}/artifacts/{stage}/{name}")
def get_artifact(run_id: str, stage: str, name: str):
    stage_dir = run_store.stage_dir(run_id, stage)
    csv_path = stage_dir / f"{name}.csv"
    json_path = stage_dir / f"{name}.json"
    if csv_path.exists():
        frame = read_frame(csv_path)
        # Apply forward fill for display artifacts so that sparse-frequency data
        # (e.g. quarterly GDP, monthly macro in daily-index frames) shows as a
        # step function rather than gaps or zeros in the frontend charts.
        # Skip returns/panel data that legitimately contains NaN.
        _FLOW_ARTIFACTS = {"asset_returns", "asset_panel"}
        if name not in _FLOW_ARTIFACTS:
            numeric_cols = frame.select_dtypes(include="number").columns
            # Replace exact 0.0 only for known sparse indicators that never truly equal 0
            # (all non-price, non-spread macro series). Price/spread columns are left as-is.
            _PRICE_LIKE = {"USDCNY", "CNYUSD", "term_spread", "trade_balance"}
            fill_zero_cols = [c for c in numeric_cols if c not in _PRICE_LIKE]
            frame[fill_zero_cols] = frame[fill_zero_cols].replace(0.0, float("nan"))
            # Resample to a regular monthly index if the frame has a datetime index
            # so that gaps between quarterly releases are filled
            if isinstance(frame.index, pd.DatetimeIndex):
                frame = frame.resample("ME").last()
            frame[numeric_cols] = frame[numeric_cols].ffill()
        preview_frame = frame.reset_index()
        return {
            "name": name,
            "rows": _json_safe(preview_frame.to_dict(orient="records")),
            "columns": list(preview_frame.columns),
        }
    if json_path.exists():
        return {"name": name, "payload": read_json(json_path)}
    raise HTTPException(status_code=404, detail="Artifact not found")


def _stage_response(run_id: str, stage: str, action) -> StageResponse:
    try:
        summary = action()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return StageResponse(run_id=run_id, stage=stage, status="success", summary=summary)


def _json_safe(value):
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    if hasattr(value, "isoformat"):
        try:
            return value.isoformat()
        except TypeError:
            pass
    if value is None:
        return None
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    if pd.isna(value):
        return None
    return value
