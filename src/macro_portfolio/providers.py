from __future__ import annotations

import json
import os
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from datetime import date, datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pandas as pd


DEFAULT_FRED_SERIES = {
    "US": {
        "ip": "INDPRO",
        "payroll": "PAYEMS",
        "unemployment": "UNRATE",
        "cpi": "CPIAUCSL",
        "core_cpi": "CPILFESL",
        "m2": "M2SL",
        "fed_funds": "FEDFUNDS",
        "yield_10y": "GS10",
        "yield_2y": "GS2",
        "term_spread": "T10Y2Y",
        "breakeven_5y": "T5YIE",
    }
}

DEFAULT_FRED_FX_SERIES = {
    "USDCNY": "DEXCHUS",
}

DEFAULT_YAHOO_SYMBOLS = {
    "SPY": "SPY",
    "QQQ": "QQQ",
    "TLT": "TLT",
    "GLD": "GLD",
    "DBC": "DBC",
}

DEFAULT_STOOQ_SYMBOLS = {
    "SPY": "spy.us",
    "QQQ": "qqq.us",
    "TLT": "tlt.us",
    "GLD": "gld.us",
    "DBC": "dbc.us",
}


@dataclass
class FredClient:
    api_key: str | None = None
    base_url: str = "https://api.stlouisfed.org/fred/series/observations"

    def __post_init__(self) -> None:
        if self.api_key is None:
            self.api_key = _resolve_secret("FRED_API_KEY")

    def fetch_series(
        self,
        series_map: dict[str, str],
        start_date: str | None = None,
        end_date: str | None = None,
    ) -> pd.DataFrame:
        if not self.api_key:
            raise ValueError("FRED_API_KEY is required. Apply at https://fred.stlouisfed.org/docs/api/api_key.html")

        data = {}
        for alias, series_id in series_map.items():
            params = {
                "series_id": series_id,
                "file_type": "json",
                "api_key": self.api_key,
                "observation_start": start_date,
                "observation_end": end_date,
            }
            url = f"{self.base_url}?{urlencode({k: v for k, v in params.items() if v})}"
            request = Request(url)
            payload = _read_json(request)
            observations = payload.get("observations", [])
            series = pd.Series(
                {
                    pd.to_datetime(item["date"]): _coerce_float(item.get("value"))
                    for item in observations
                },
                name=alias,
                dtype=float,
            )
            data[alias] = series

        return pd.DataFrame(data).sort_index()


@dataclass
class YahooFinanceClient:
    base_url: str = "https://query1.finance.yahoo.com/v8/finance/chart"
    user_agent: str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36"

    def fetch_close_prices(
        self,
        symbol_map: dict[str, str],
        start_date: str | None = None,
        end_date: str | None = None,
        interval: str = "1mo",
    ) -> pd.DataFrame:
        if start_date is None:
            start_date = "2000-01-01"
        if end_date is None:
            end_date = date.today().isoformat()

        start_epoch = _to_epoch(start_date)
        end_epoch = _to_epoch(end_date)
        frames: dict[str, pd.Series] = {}
        for alias, symbol in symbol_map.items():
            params = urlencode(
                {
                    "period1": start_epoch,
                    "period2": end_epoch,
                    "interval": interval,
                    "includeAdjustedClose": "true",
                    "events": "div,splits",
                }
            )
            request = Request(
                f"{self.base_url}/{symbol}?{params}",
                headers={"User-Agent": self.user_agent, "Accept": "application/json"},
            )
            payload = _read_json(request)
            result = payload["chart"]["result"][0]
            timestamps = result.get("timestamp", [])
            quote = result["indicators"]["quote"][0]
            adjclose = result["indicators"].get("adjclose", [{}])[0].get("adjclose")
            closes = adjclose if adjclose is not None else quote["close"]
            frames[alias] = pd.Series(
                closes,
                index=pd.to_datetime(timestamps, unit="s", utc=True).tz_convert(None),
                name=alias,
                dtype=float,
            )

        prices = pd.DataFrame(frames).sort_index()
        return prices[~prices.index.duplicated(keep="last")]


class OpenBBClient:
    def __init__(self) -> None:
        try:
            from openbb import obb  # type: ignore
        except ImportError as exc:
            raise ImportError("OpenBB is not installed. Install it with `pip install openbb` if you want this adapter.") from exc
        self.obb = obb

    def fetch_fred_series(
        self,
        series_map: dict[str, str],
        start_date: str | None = None,
        end_date: str | None = None,
    ) -> pd.DataFrame:
        frames = {}
        for alias, symbol in series_map.items():
            df = self.obb.economy.fred_series(
                symbol=symbol,
                start_date=start_date,
                end_date=end_date,
                provider="fred",
            ).to_df()
            value_column = "value" if "value" in df.columns else df.columns[-1]
            frames[alias] = df.set_index("date")[value_column].rename(alias)
        return pd.DataFrame(frames).sort_index()


@dataclass
class StooqClient:
    base_url: str = "https://stooq.com/q/d/l/"
    user_agent: str = "Mozilla/5.0"

    def fetch_close_prices(self, symbol_map: dict[str, str], interval: str = "m") -> pd.DataFrame:
        frames = {}
        for alias, symbol in symbol_map.items():
            params = urlencode({"s": symbol, "i": interval})
            request = Request(f"{self.base_url}?{params}", headers={"User-Agent": self.user_agent})
            with urlopen(request) as response:  # noqa: S310
                csv_text = response.read().decode("utf-8")
            frame = pd.read_csv(pd.io.common.StringIO(csv_text))
            frame["Date"] = pd.to_datetime(frame["Date"])
            frames[alias] = frame.set_index("Date")["Close"].rename(alias).astype(float)
        return pd.DataFrame(frames).sort_index()


@dataclass
class BinanceClient:
    base_url: str = "https://api.binance.com/api/v3/klines"

    def fetch_btc_prices(self, start_date: str, end_date: str) -> pd.Series:
        params = urlencode(
            {
                "symbol": "BTCUSDT",
                "interval": "1M",
                "startTime": _to_epoch(start_date) * 1000,
                "endTime": _to_epoch(end_date) * 1000,
                "limit": 1000,
            }
        )
        payload = _read_json_array(f"{self.base_url}?{params}")
        series = pd.Series(
            {
                pd.to_datetime(item[0], unit="ms"): float(item[4])
                for item in payload
            },
            name="BTC",
            dtype=float,
        )
        return series.sort_index().resample("ME").last()


class AkshareClient:
    def __init__(self) -> None:
        try:
            import akshare as ak  # type: ignore
        except ImportError as exc:
            raise ImportError("akshare is not installed. Install it with `python3 -m pip install akshare`.") from exc
        self.ak = ak

    def fetch_cn_assets(
        self,
        csi300_code: str,
        star50_code: str,
        cgb_code: str,
        start_date: str,
        end_date: str,
    ) -> pd.DataFrame:
        with _disabled_proxy_env():
            csi300 = self.ak.fund_etf_hist_sina(symbol=_normalize_sina_fund_code(csi300_code))
            star50 = self.ak.fund_etf_hist_sina(symbol=_normalize_sina_fund_code(star50_code))
            cgb = self.ak.fund_etf_hist_sina(symbol=_normalize_sina_fund_code(cgb_code))
        return pd.concat(
            [
                _akshare_close_series(csi300, "CSI300"),
                _akshare_close_series(star50, "STAR50"),
                _akshare_close_series(cgb, "CGB"),
            ],
            axis=1,
        ).sort_index().loc[pd.Timestamp(start_date) : pd.Timestamp(end_date)]

    def fetch_cn_macro(self) -> pd.DataFrame:
        with _disabled_proxy_env():
            series_map = {
                "pmi": self.ak.macro_china_pmi_yearly(),
                "cpi": self.ak.macro_china_cpi_yearly(),
                "ppi": self.ak.macro_china_ppi_yearly(),
                "m2": self.ak.macro_china_m2_yearly(),
                "industrial": self.ak.macro_china_industrial_production_yoy(),
                "gdp": self.ak.macro_china_gdp_yearly(),
            }
        frames = [_akshare_macro_series(frame, alias) for alias, frame in series_map.items()]
        return pd.concat(frames, axis=1).sort_index()

    def fetch_price_history(
        self,
        symbol_map: dict[str, str],
        start_date: str | None = None,
        end_date: str | None = None,
        asset_class: str = "equity",
    ) -> pd.DataFrame:
        frames = {}
        command = {
            "equity": self.obb.equity.price.historical,
            "crypto": self.obb.crypto.price.historical,
            "currency": self.obb.currency.price.historical,
            "index": self.obb.index.price.historical,
        }[asset_class]
        for alias, symbol in symbol_map.items():
            df = command(symbol=symbol, start_date=start_date, end_date=end_date, provider="yfinance").to_df()
            close_column = "adj_close" if "adj_close" in df.columns else "close"
            frames[alias] = df.set_index("date")[close_column].rename(alias)
        return pd.DataFrame(frames).sort_index()


@dataclass
class ResearchDataLoader:
    fred: FredClient | None = None
    yahoo: YahooFinanceClient | None = None
    openbb: OpenBBClient | None = None
    stooq: StooqClient | None = None
    binance: BinanceClient | None = None
    akshare: AkshareClient | None = None

    def load_default_us_macro(self, start_date: str, end_date: str | None = None) -> dict[str, pd.DataFrame]:
        client = self.openbb if self.openbb is not None else self.fred or FredClient()
        if isinstance(client, OpenBBClient):
            us = client.fetch_fred_series(DEFAULT_FRED_SERIES["US"], start_date=start_date, end_date=end_date)
        else:
            us = client.fetch_series(DEFAULT_FRED_SERIES["US"], start_date=start_date, end_date=end_date)
        return {"US": us}

    def load_default_market_prices(self, start_date: str, end_date: str | None = None) -> pd.DataFrame:
        if end_date is None:
            end_date = date.today().isoformat()
        client = self.openbb if self.openbb is not None else self.yahoo or YahooFinanceClient()
        if isinstance(client, OpenBBClient):
            prices = client.fetch_price_history(DEFAULT_YAHOO_SYMBOLS, start_date=start_date, end_date=end_date, asset_class="equity")
            fx = self.fred or FredClient()
            fx_frame = fx.fetch_series(DEFAULT_FRED_FX_SERIES, start_date=start_date, end_date=end_date)
            prices = prices.join(fx_frame, how="outer")
        else:
            stooq = self.stooq or StooqClient()
            prices = stooq.fetch_close_prices(DEFAULT_STOOQ_SYMBOLS)
            btc = (self.binance or BinanceClient()).fetch_btc_prices(start_date=start_date, end_date=end_date)
            fx = (self.fred or FredClient()).fetch_series(DEFAULT_FRED_FX_SERIES, start_date=start_date, end_date=end_date)
            prices = prices.join(btc, how="outer").join(fx, how="outer")
            prices = prices.loc[prices.index >= pd.Timestamp(start_date)]
            prices = prices.loc[prices.index <= pd.Timestamp(end_date)]
            return prices.resample("ME").last()
        if "USDCNY" not in prices.columns:
            fx = (self.fred or FredClient()).fetch_series(DEFAULT_FRED_FX_SERIES, start_date=start_date, end_date=end_date)
            prices = prices.join(fx, how="outer")
        if "BTC" not in prices.columns:
            prices = client.fetch_close_prices(DEFAULT_YAHOO_SYMBOLS, start_date=start_date, end_date=end_date)
        return prices.rename(columns={"USDCNY": "USDCNY"}).resample("ME").last()

    def load_cn_assets(
        self,
        csi300_code: str,
        star50_code: str,
        cgb_code: str,
        start_date: str,
        end_date: str,
    ) -> pd.DataFrame:
        client = self.akshare or AkshareClient()
        return client.fetch_cn_assets(csi300_code, star50_code, cgb_code, start_date, end_date)

    def load_default_cn_macro(self) -> dict[str, pd.DataFrame]:
        client = self.akshare or AkshareClient()
        return {"CN": client.fetch_cn_macro()}


def _read_json(target: str | Request) -> dict[str, Any]:
    try:
        with urlopen(target) as response:  # noqa: S310
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"HTTP error {exc.code} for {getattr(target, 'full_url', target)}: {detail}") from exc


def _read_json_array(target: str | Request) -> list[Any]:
    try:
        with urlopen(target) as response:  # noqa: S310
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"HTTP error {exc.code} for {getattr(target, 'full_url', target)}: {detail}") from exc


def _to_epoch(value: str | date | datetime) -> int:
    if isinstance(value, str):
        dt_value = datetime.fromisoformat(value)
    elif isinstance(value, date) and not isinstance(value, datetime):
        dt_value = datetime.combine(value, datetime.min.time())
    else:
        dt_value = value
    if dt_value.tzinfo is None:
        dt_value = dt_value.replace(tzinfo=timezone.utc)
    return int(dt_value.timestamp())


def _coerce_float(value: Any) -> float | None:
    if value in {".", None, ""}:
        return None
    return float(value)


def _compact_date(value: str) -> str:
    return pd.Timestamp(value).strftime("%Y%m%d")


def _resolve_secret(name: str) -> str | None:
    env_value = os.getenv(name)
    if env_value:
        return env_value

    for filename in [".env.secrets", ".env"]:
        env_path = Path(filename)
        if not env_path.exists():
            continue
        for line in env_path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            if key.strip() == name:
                return value.strip().strip('"').strip("'")
    return None


@contextmanager
def _disabled_proxy_env():
    proxy_keys = ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "all_proxy"]
    snapshot = {key: os.environ.get(key) for key in proxy_keys}
    try:
        for key in proxy_keys:
            os.environ.pop(key, None)
        os.environ["NO_PROXY"] = "*"
        yield
    finally:
        for key in proxy_keys:
            original = snapshot[key]
            if original is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = original


def _normalize_cn_index_code(value: str) -> str:
    return value.split(".")[0]


def _normalize_cn_fund_code(value: str) -> str:
    return value.split(".")[0]


def _normalize_sina_fund_code(value: str) -> str:
    code, _, suffix = value.partition(".")
    if code.lower().startswith(("sh", "sz")):
        return code.lower()
    exchange = suffix.lower()
    if exchange in {"sh", "ss"}:
        return f"sh{code}"
    if exchange == "sz":
        return f"sz{code}"
    if code.startswith(("5", "6", "9")):
        return f"sh{code}"
    return f"sz{code}"


def _akshare_close_series(frame: pd.DataFrame, name: str) -> pd.Series:
    date_col = "日期" if "日期" in frame.columns else "date"
    close_col = "收盘" if "收盘" in frame.columns else "close"
    formatted = frame[[date_col, close_col]].copy()
    formatted[date_col] = pd.to_datetime(formatted[date_col])
    formatted[close_col] = pd.to_numeric(formatted[close_col], errors="coerce")
    return formatted.set_index(date_col)[close_col].rename(name)


def _akshare_macro_series(frame: pd.DataFrame, name: str) -> pd.Series:
    formatted = frame[["日期", "今值"]].copy()
    formatted["日期"] = pd.to_datetime(formatted["日期"]).dt.to_period("M").dt.to_timestamp("M")
    formatted["今值"] = pd.to_numeric(formatted["今值"], errors="coerce")
    series = formatted.dropna(subset=["日期"]).drop_duplicates(subset=["日期"], keep="last").set_index("日期")["今值"]
    return series.rename(name)
