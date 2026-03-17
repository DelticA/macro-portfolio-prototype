from __future__ import annotations

import json
from urllib.request import Request

import pandas as pd

from macro_portfolio.providers import BinanceClient, FredClient, StooqClient, YahooFinanceClient


class DummyResponse:
    def __init__(self, payload: dict) -> None:
        self.payload = payload

    def read(self) -> bytes:
        return json.dumps(self.payload).encode("utf-8")

    def __enter__(self) -> "DummyResponse":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None


def test_fred_client_parses_series(monkeypatch):
    def fake_urlopen(target):
        assert isinstance(target, Request)
        assert "api_key=demo" in target.full_url
        return DummyResponse(
            {
                "observations": [
                    {"date": "2024-01-31", "value": "1.2"},
                    {"date": "2024-02-29", "value": "1.5"},
                ]
            }
        )

    monkeypatch.setattr("macro_portfolio.providers.urlopen", fake_urlopen)
    client = FredClient(api_key="demo")
    data = client.fetch_series({"cpi": "CPIAUCSL"}, start_date="2024-01-01")
    assert list(data.columns) == ["cpi"]
    assert data.iloc[-1, 0] == 1.5


def test_yahoo_client_parses_close_history(monkeypatch):
    def fake_urlopen(target):
        return DummyResponse(
            {
                "chart": {
                    "result": [
                        {
                            "timestamp": [1706659200, 1709164800],
                            "indicators": {
                                "quote": [{"close": [100.0, 102.0]}],
                                "adjclose": [{"adjclose": [99.0, 101.0]}],
                            },
                        }
                    ]
                }
            }
        )

    monkeypatch.setattr("macro_portfolio.providers.urlopen", fake_urlopen)
    client = YahooFinanceClient()
    prices = client.fetch_close_prices({"SPY": "SPY"}, start_date="2024-01-01", end_date="2024-03-01")
    assert list(prices.columns) == ["SPY"]
    assert prices.iloc[0, 0] == 99.0


def test_stooq_client_parses_csv(monkeypatch):
    def fake_urlopen(target):
        return DummyResponse({})

    def fake_read_csv(buffer):
        return pd.DataFrame({"Date": ["2024-01-31", "2024-02-29"], "Close": [100.0, 101.0]})

    monkeypatch.setattr("macro_portfolio.providers.urlopen", fake_urlopen)
    monkeypatch.setattr("macro_portfolio.providers.pd.read_csv", fake_read_csv)
    client = StooqClient()
    frame = client.fetch_close_prices({"SPY": "spy.us"})
    assert frame.iloc[-1, 0] == 101.0


def test_binance_client_resamples_monthly(monkeypatch):
    def fake_urlopen(target):
        return DummyResponse(
            [
                [1706659200000, "42000", "44000", "41000", "43000", "0", 0, "0", 0, "0", "0", "0"],
                [1709164800000, "44000", "46000", "43000", "45000", "0", 0, "0", 0, "0", "0", "0"],
            ]
        )

    monkeypatch.setattr("macro_portfolio.providers.urlopen", fake_urlopen)
    client = BinanceClient()
    series = client.fetch_btc_prices("2024-01-01", "2024-02-29")
    assert series.iloc[-1] == 45000.0
