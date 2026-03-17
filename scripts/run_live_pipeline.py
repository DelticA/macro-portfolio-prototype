from __future__ import annotations

import argparse

from macro_portfolio.live import LivePipelineConfig, run_live_pipeline


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fetch live research data and optionally run the macro portfolio backtest.")
    parser.add_argument("--start-date", required=True)
    parser.add_argument("--end-date", required=True)
    parser.add_argument("--csi300-code", default="510300.SH")
    parser.add_argument("--star50-code", default="588000.SH")
    parser.add_argument("--cgb-code", default="511010.SH")
    parser.add_argument("--output-dir", default="data/live_run")
    parser.add_argument("--fred-api-key")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    config = LivePipelineConfig(
        start_date=args.start_date,
        end_date=args.end_date,
        csi300_code=args.csi300_code,
        star50_code=args.star50_code,
        cgb_code=args.cgb_code,
        output_dir=args.output_dir,
        fred_api_key=args.fred_api_key,
    )
    outputs = run_live_pipeline(config)
    for name, path in outputs.items():
        print(f"{name}: {path}")


if __name__ == "__main__":
    main()
