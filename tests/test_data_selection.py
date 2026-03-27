from __future__ import annotations

import pandas as pd
import pytest

from macro_portfolio.engine.artifacts import read_frame, read_json, write_frame, write_json
from macro_portfolio.engine.run_store import RunStore
from macro_portfolio.engine.schemas import DataSelectionRequest, RegimeRequest
from macro_portfolio.services.pipeline import PipelineService


def _features_frame() -> pd.DataFrame:
    index = pd.date_range("2020-01-31", periods=6, freq="ME")
    return pd.DataFrame(
        {
            "us_ip_z": [-1.0, -0.8, -0.6, 0.2, 0.4, 0.6],
            "us_cpi_z": [-0.7, -0.5, -0.3, 0.3, 0.5, 0.7],
            "cn_pmi_z": [-0.9, -0.7, -0.4, 0.1, 0.3, 0.5],
            "cn_ppi_z": [-0.8, -0.6, -0.2, 0.2, 0.4, 0.6],
            "global_SPY_z": [-0.2, -0.1, 0.0, 0.2, 0.4, 0.6],
        },
        index=index,
    )


def _asset_returns_frame() -> pd.DataFrame:
    index = pd.date_range("2020-01-31", periods=6, freq="ME")
    return pd.DataFrame(
        {
            "SPY": [0.01, 0.02, -0.01, 0.03, 0.02, 0.01],
            "TLT": [0.00, 0.01, 0.02, -0.01, 0.00, 0.01],
        },
        index=index,
    )


def _asset_panel_frame() -> pd.DataFrame:
    dates = pd.date_range("2020-01-31", periods=6, freq="ME")
    rows = []
    for date in dates:
        rows.append({"date": date, "asset": "SPY", "return_1m": 0.01, "region": "US"})
        rows.append({"date": date, "asset": "TLT", "return_1m": 0.00, "region": "US"})
    return pd.DataFrame(rows)


def _setup_data_stage(tmp_path):
    run_store = RunStore(tmp_path / "runs")
    run_id = run_store.create_run("selection-test")
    stage_dir = run_store.stage_dir(run_id, "data")
    providers_dir = run_store.stage_dir(run_id, "providers")
    features = _features_frame()
    asset_returns = _asset_returns_frame()
    asset_panel = _asset_panel_frame()
    write_frame(features, stage_dir / "features.csv")
    write_frame(asset_returns, stage_dir / "asset_returns.csv")
    write_frame(asset_panel, stage_dir / "asset_panel.csv")
    write_frame(
        pd.DataFrame({"cpi": [100, 101, 102, 103, 104, 105]}, index=features.index),
        providers_dir / "us_macro.csv",
    )
    write_frame(
        pd.DataFrame({"pmi": [50, 51, 49, 52, 53, 54], "ppi": [98, 99, 100, 101, 102, 103]}, index=features.index),
        providers_dir / "cn_macro.csv",
    )
    write_frame(
        pd.DataFrame({"SPY": [280, 285, 275, 290, 300, 305]}, index=features.index),
        providers_dir / "global_prices.csv",
    )
    write_frame(pd.DataFrame(index=features.index), providers_dir / "cn_assets.csv")
    write_json(
        {
            "selection": {"available_range": {"start": str(features.index.min()), "end": str(features.index.max())}},
            "series_catalog": {
                "us_macro::ip": {"id": "us_macro::ip", "feature_prefix": "us_ip_", "mappable_to_regime": True},
                "us_macro::cpi": {"id": "us_macro::cpi", "feature_prefix": "us_cpi_", "mappable_to_regime": True},
                "cn_macro::pmi": {"id": "cn_macro::pmi", "feature_prefix": "cn_pmi_", "mappable_to_regime": True},
                "cn_macro::ppi": {"id": "cn_macro::ppi", "feature_prefix": "cn_ppi_", "mappable_to_regime": True},
                "global_prices::SPY": {"id": "global_prices::SPY", "feature_prefix": "global_SPY_", "mappable_to_regime": True},
            },
        },
        stage_dir / "summary.json",
    )
    run_store.mark_stage(run_id, "providers", "success", {"summary": {}})
    run_store.mark_stage(run_id, "data", "success", {"summary": {}})
    return PipelineService(run_store), run_id


def test_apply_data_selection_persists_selected_artifacts_and_summary(tmp_path):
    service, run_id = _setup_data_stage(tmp_path)

    summary = service.apply_data_selection(
        run_id,
        DataSelectionRequest(
            start_date="2020-02-29",
            end_date="2020-04-30",
            display_series_ids=["us_macro::cpi", "global_prices::SPY"],
        ),
    )

    assert summary["selection"]["applied_range"] == {"start": "2020-02-29 00:00:00", "end": "2020-04-30 00:00:00"}
    assert summary["selection"]["applied_display_series_ids"] == ["us_macro::cpi", "global_prices::SPY"]
    assert summary["selection"]["applied_unmapped_series_ids"] == []
    assert set(summary["selection"]["applied_feature_columns"]) == {"us_cpi_z", "global_SPY_z"}
    assert summary["selection"]["selected_rows"] == {"selected_series": 3, "features": 3, "asset_returns": 3, "asset_panel": 6}
    assert summary["selection"]["coverage"]["selected_series_count"] == 2
    assert summary["selection"]["coverage"]["raw_missing_ratio"] == 0.0

    selected_features = read_frame(service.run_store.stage_dir(run_id, "data") / "selected_features.csv")
    assert list(selected_features.columns) == ["us_cpi_z", "global_SPY_z"]

    selected_series = read_frame(service.run_store.stage_dir(run_id, "data") / "selected_series.csv")
    assert list(selected_series.columns) == ["us_macro::cpi", "global_prices::SPY"]

    selected_returns = read_frame(service.run_store.stage_dir(run_id, "data") / "selected_asset_returns.csv")
    assert list(selected_returns.index.strftime("%Y-%m-%d")) == ["2020-02-29", "2020-03-31", "2020-04-30"]

    selection_json = read_json(service.run_store.stage_dir(run_id, "data") / "selection.json")
    assert selection_json["start"] == "2020-02-29 00:00:00"
    assert selection_json["end"] == "2020-04-30 00:00:00"
    assert selection_json["display_series_ids"] == ["us_macro::cpi", "global_prices::SPY"]
    assert selection_json["unmapped_series_ids"] == []
    assert selection_json["feature_columns"] == ["us_cpi_z", "global_SPY_z"]
    assert selection_json["raw_missing_ratio"] == 0.0


def test_run_regime_uses_selected_features_window(tmp_path):
    service, run_id = _setup_data_stage(tmp_path)
    service.apply_data_selection(
        run_id,
        DataSelectionRequest(
            start_date="2020-03-31",
            end_date="2020-05-31",
            display_series_ids=["us_macro::cpi", "cn_macro::pmi"],
        ),
    )

    summary = service.run_regime(run_id, RegimeRequest(model_name="rule_based", smoothing_window=1))

    regime = read_frame(service.run_store.stage_dir(run_id, "regime") / "regime.csv")
    assert list(regime.index.strftime("%Y-%m-%d")) == ["2020-03-31", "2020-04-30", "2020-05-31"]
    assert summary["selection"]["start"] == "2020-03-31 00:00:00"
    assert summary["selection"]["end"] == "2020-05-31 00:00:00"
    assert set(summary["selection"]["feature_columns"]) == {"us_cpi_z", "cn_pmi_z"}


def test_apply_data_selection_rejects_out_of_range_window(tmp_path):
    service, run_id = _setup_data_stage(tmp_path)

    with pytest.raises(ValueError, match="Selection must stay within processed range"):
        service.apply_data_selection(
            run_id,
            DataSelectionRequest(start_date="2019-12-31", end_date="2020-04-30"),
        )


def test_apply_data_selection_rejects_display_only_series_for_regime(tmp_path):
    service, run_id = _setup_data_stage(tmp_path)

    with pytest.raises(ValueError, match="Unknown data series selected"):
        service.apply_data_selection(
            run_id,
            DataSelectionRequest(
                start_date="2020-02-29",
                end_date="2020-04-30",
                display_series_ids=["missing::SERIES"],
            ),
        )
