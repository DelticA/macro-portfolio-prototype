from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from .artifacts import ensure_dir, read_json, write_json


RUN_STAGE_ORDER = ["providers", "data", "regime", "policy", "backtest"]


@dataclass
class RunStore:
    root: Path

    def __post_init__(self) -> None:
        ensure_dir(self.root)

    def create_run(self, label: str | None = None) -> str:
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        run_id = f"{stamp}_{uuid4().hex[:4]}"
        run_dir = self.run_dir(run_id)
        ensure_dir(run_dir)
        ensure_dir(run_dir / "logs")
        metadata = {
            "run_id": run_id,
            "label": label or "Macro Portfolio Lab Run",
            "created_at": datetime.now().isoformat(),
            "status": "created",
            "current_stage": None,
            "stages": {stage: {"status": "pending"} for stage in RUN_STAGE_ORDER},
        }
        write_json(metadata, run_dir / "run.json")
        return run_id

    def run_dir(self, run_id: str) -> Path:
        return self.root / run_id

    def load_metadata(self, run_id: str) -> dict[str, Any]:
        return read_json(self.run_dir(run_id) / "run.json")

    def save_metadata(self, run_id: str, metadata: dict[str, Any]) -> None:
        write_json(metadata, self.run_dir(run_id) / "run.json")

    def mark_stage(self, run_id: str, stage: str, status: str, extra: dict[str, Any] | None = None) -> dict[str, Any]:
        metadata = self.load_metadata(run_id)
        metadata["current_stage"] = stage
        metadata["status"] = "running" if status == "running" else metadata["status"]
        metadata["stages"][stage] = {"status": status, **(extra or {})}
        if all(metadata["stages"][name]["status"] == "success" for name in RUN_STAGE_ORDER):
            metadata["status"] = "success"
        elif status == "failed":
            metadata["status"] = "failed"
        self.save_metadata(run_id, metadata)
        return metadata

    def log(self, run_id: str, stage: str, message: str) -> None:
        log_path = self.run_dir(run_id) / "logs" / f"{stage}.log"
        ensure_dir(log_path.parent)
        with log_path.open("a", encoding="utf-8") as handle:
            handle.write(f"{datetime.now().isoformat()} {message}\n")

    def stage_dir(self, run_id: str, stage: str) -> Path:
        return ensure_dir(self.run_dir(run_id) / stage)

    def list_runs(self) -> list[dict[str, Any]]:
        runs = []
        for path in sorted(self.root.glob("*/run.json"), reverse=True):
            runs.append(read_json(path))
        return runs
