"""Validate supplied keys with a small generation, then save only successes.

Usage: python3 scripts/configure-gemini-keys.py /path/to/keys.csv
Never prints keys, CSV contents, or raw provider error messages.
"""
import concurrent.futures
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.request

source = Path(sys.argv[1])
keys = list(dict.fromkeys(re.findall(r"AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])", source.read_text())))
if not keys:
    raise SystemExit("No Gemini candidate keys found; configuration unchanged.")
base = "https://generativelanguage.googleapis.com/v1beta/"

def request(key, route, body=None):
    req = urllib.request.Request(base + route, data=json.dumps(body).encode() if body is not None else None,
        headers={"x-goog-api-key": key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=40) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        try:
            payload = json.load(error)
            reasons = [item.get("reason", "") for item in payload.get("error", {}).get("details", [])]
            if "leaked" in payload.get("error", {}).get("message", "").lower():
                reasons.append("KEY_REPORTED_LEAKED")
        except Exception:
            reasons = []
        return error.code, {"reasons": reasons}
    except Exception as error:
        return 0, {"networkErrorType": type(getattr(error, "reason", error)).__name__}

preferred = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.8-flash", "gemini-2.5-flash-lite"]
model = sys.argv[2] if len(sys.argv) > 2 else None
discovery_checks = []
for key in ([] if model else keys):
    status, data = request(key, "models?pageSize=1000")
    discovery_checks.append({"httpStatus": status, "networkErrorType": data.get("networkErrorType"), "reasons": data.get("reasons", [])})
    if status != 200:
        continue
    available = {item.get("name", "").removeprefix("models/") for item in data.get("models", []) if "generateContent" in item.get("supportedGenerationMethods", [])}
    model = next((item for item in preferred if item in available), None)
    if model:
        break
if not model:
    model = preferred[0]
    print("Model listing was unavailable; testing documented model directly instead.", flush=True)
print(f"Testing {len(keys)} unique candidate keys with {model}; only verified generations enter the pool.", flush=True)
body = {
    "contents": [{"role": "user", "parts": [{"text": 'Return {"ok":true} only.'}]}],
    "generationConfig": {"maxOutputTokens": 128, "responseMimeType": "application/json",
        "responseJsonSchema": {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"]}},
}

def probe(item):
    index, key = item
    status, data = request(key, f"models/{model}:generateContent", body)
    passed = False
    if status == 200:
        try:
            candidate = data["candidates"][0]
            text = "".join(part.get("text", "") for part in candidate["content"]["parts"] if not part.get("thought"))
            passed = candidate.get("finishReason") == "STOP" and json.loads(text) == {"ok": True}
        except Exception:
            pass
    reasons = data.get("reasons", [])
    category = "working" if passed else ("reported_leaked" if "KEY_REPORTED_LEAKED" in reasons else "project_suspended" if "CONSUMER_SUSPENDED" in reasons else {400: "invalid_or_restricted", 401: "unauthorized", 403: "forbidden_or_disabled", 404: "model_unavailable", 429: "quota_or_rate_limited"}.get(status, "generation_failed" if status else "network_failed"))
    return {"index": index + 1, "fingerprint": hashlib.sha256(key.encode()).hexdigest()[:10], "status": category, "httpStatus": status, "passed": passed}, key

results = []
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    for result, key in pool.map(probe, enumerate(keys)):
        results.append((result, key))
        print(f"Candidate {result['index']:02d}: {result['status']} (HTTP {result['httpStatus']})", flush=True)

working = [key for result, key in results if result["passed"]]
Path("data").mkdir(exist_ok=True)
report = {"checkedAt": datetime.now(timezone.utc).isoformat(), "model": model, "tested": len(keys), "working": len(working), "checks": [result for result, _ in results]}
Path("data/gemini-key-verification.json").write_text(json.dumps(report, indent=2) + "\n")
if not working:
    raise SystemExit("No keys completed a generation. Existing environment preserved; safe report: data/gemini-key-verification.json")

env = Path(".env")
updates = {"GEMINI_API_KEYS": ",".join(working), "GEMINI_MODEL": model, "GEMINI_CLASSIFICATION_MODEL": model}
lines = env.read_text().splitlines() if env.exists() else []
out, seen = [], set()
for line in lines:
    field = line.partition("=")[0].strip()
    if field in updates:
        if field not in seen:
            out.append(field + "=" + updates[field])
            seen.add(field)
    elif not field.startswith("ANTHROPIC_") and field != "GEMINI_API_KEY":
        out.append(line)
for field, value in updates.items():
    if field not in seen:
        out.append(field + "=" + value)
env.write_text("\n".join(out) + "\n")
os.chmod(env, 0o600)
print(f"Saved {len(working)} verified Gemini keys to .env (0600); keys were not printed.", flush=True)
