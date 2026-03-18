from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from ..engine.run_store import RunStore
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


@app.post("/api/runs/{run_id}/providers", response_model=StageResponse)
def run_providers(run_id: str, request: ProvidersRequest):
    return _stage_response(run_id, "providers", lambda: pipeline.run_providers(run_id, request))


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
