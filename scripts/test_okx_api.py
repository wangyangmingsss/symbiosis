#!/usr/bin/env python3
"""
Test OKX DEX API connectivity using project-level API key.
Tests both V6 DEX (Web3) endpoints and V5 CEX market endpoints.
OKX deprecated the V5 DEX API; the current version is V6.
"""

import hashlib
import hmac
import base64
import json
import requests
from datetime import datetime, timezone

# --- Credentials ---
API_KEY = "6f04abd9-0f79-4b13-8b27-715b72e942f5"
SECRET_KEY = "03475D89BF60D0A6222C7EE20505C2F4"
PASSPHRASE = "Baofu888888@"
PROJECT_ID = API_KEY

BASE_URL = "https://www.okx.com"


def make_signature(timestamp: str, method: str, request_path: str, body: str = "") -> str:
    """HMAC-SHA256 signature per OKX API v5 spec."""
    prehash = timestamp + method.upper() + request_path + body
    mac = hmac.new(SECRET_KEY.encode("utf-8"), prehash.encode("utf-8"), hashlib.sha256)
    return base64.b64encode(mac.digest()).decode("utf-8")


def auth_headers(method: str, request_path: str, body: str = "") -> dict:
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    sign = make_signature(timestamp, method, request_path, body)
    return {
        "OK-ACCESS-KEY": API_KEY,
        "OK-ACCESS-SIGN": sign,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": PASSPHRASE,
        "OK-ACCESS-PROJECT": PROJECT_ID,
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; OKXAPITest/1.0)",
        "Accept": "application/json",
    }


def get(path: str, params: dict = None) -> dict:
    """Authenticated GET request."""
    qs = ""
    if params:
        qs = "?" + "&".join(f"{k}={v}" for k, v in params.items())
    request_path = path + qs
    url = BASE_URL + request_path
    headers = auth_headers("GET", request_path)
    try:
        resp = requests.get(url, headers=headers, timeout=15)
        print(f"  HTTP Status: {resp.status_code}")
        if resp.status_code == 200:
            return resp.json()
        else:
            return {"error": f"HTTP {resp.status_code}", "body": resp.text[:500]}
    except Exception as e:
        return {"error": str(e)}


def test_endpoint(name: str, path: str, params: dict = None):
    print(f"\n{'='*60}")
    print(f"TEST: {name}")
    print(f"  Endpoint: {path}")
    if params:
        print(f"  Params: {params}")
    print("-" * 60)
    result = get(path, params)

    if "error" in result and isinstance(result.get("error"), str):
        print(f"  FAILED: {result['error']}")
        if "body" in result:
            print(f"  Response: {result['body'][:500]}")
        return False

    code = result.get("code", "?")
    msg = result.get("msg", "")
    print(f"  API code: {code}")
    if msg:
        print(f"  Message: {msg}")

    if str(code) == "0":
        data = result.get("data", [])
        if isinstance(data, list):
            print(f"  Data items: {len(data)}")
            if data:
                first = data[0]
                if isinstance(first, dict):
                    print(f"  First item keys: {list(first.keys())}")
                    print(f"  First item: {json.dumps(first, indent=2)[:300]}")
                else:
                    print(f"  First item: {str(first)[:200]}")
        else:
            print(f"  Data: {json.dumps(data, indent=2)[:400]}")
        print("  RESULT: SUCCESS")
        return True
    else:
        print(f"  Full response: {json.dumps(result, indent=2)[:500]}")
        print("  RESULT: FAILED")
        return False


if __name__ == "__main__":
    print("OKX DEX API Connectivity Test")
    print("=" * 60)

    results = {}

    # ---- V6 DEX Aggregator Endpoints (current) ----

    # Test 1: Supported chains (V6)
    results["supported_chains_v6"] = test_endpoint(
        "Supported Chains (V6)",
        "/api/v6/dex/aggregator/supported/chain",
    )

    # Test 2: All tokens on X Layer (V6)
    results["all_tokens_v6"] = test_endpoint(
        "All Tokens on X Layer (V6)",
        "/api/v6/dex/aggregator/all-tokens",
        {"chainIndex": "196"},
    )

    # Test 3: Quote OKB -> USDT on X Layer (V6)
    results["quote_v6"] = test_endpoint(
        "DEX Quote: OKB -> USDT (V6)",
        "/api/v6/dex/aggregator/quote",
        {
            "chainIndex": "196",
            "amount": "1000000000000000000",
            "fromTokenAddress": "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
            "toTokenAddress": "0x1E4a5963aBFD975d8c9021ce480b42188849D41d",
        },
    )

    # Test 4: Swap data (V6 - builds tx data, doesn't execute)
    results["swap_v6"] = test_endpoint(
        "DEX Swap Data: OKB -> USDT (V6)",
        "/api/v6/dex/aggregator/swap",
        {
            "chainIndex": "196",
            "amount": "1000000000000000000",
            "fromTokenAddress": "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
            "toTokenAddress": "0x1E4a5963aBFD975d8c9021ce480b42188849D41d",
            "slippagePercent": "0.01",
            "userWalletAddress": "0x0000000000000000000000000000000000000001",
        },
    )

    # ---- V5 CEX Market Endpoint (still active) ----

    # Test 5: Market ticker (V5 CEX - still working)
    results["ticker_v5"] = test_endpoint(
        "Market Ticker: OKB-USDT (V5 CEX)",
        "/api/v5/market/ticker",
        {"instId": "OKB-USDT"},
    )

    # Summary
    print(f"\n\n{'='*60}")
    print("SUMMARY")
    print("=" * 60)
    for name, ok in results.items():
        status = "PASS" if ok else "FAIL"
        print(f"  [{status}] {name}")

    passed = sum(1 for v in results.values() if v)
    total = len(results)
    print(f"\n  {passed}/{total} endpoints passed")
