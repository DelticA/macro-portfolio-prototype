from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pandas as pd


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_frame(frame: pd.DataFrame, path: Path) -> str:
    ensure_dir(path.parent)
    index_label = frame.index.name or ("date" if not isinstance(frame.index, pd.RangeIndex) else None)
    frame.to_csv(path, index_label=index_label)
    return str(path)


def read_frame(path: Path, index_col: str | int | None = 0) -> pd.DataFrame:
    frame = pd.read_csv(path, index_col=index_col)
    if index_col is not None:
        try:
            frame.index = pd.to_datetime(frame.index)
        except (ValueError, TypeError):
            pass
    return frame


def write_json(payload: dict[str, Any], path: Path) -> str:
    ensure_dir(path.parent)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return str(path)


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))
