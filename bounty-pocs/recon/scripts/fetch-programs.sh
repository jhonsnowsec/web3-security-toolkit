#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
scripts_dir="$repo_root/bounty-pocs/recon/scripts"
in="$repo_root/bounty-pocs/recon/targets.enriched.json"
out="$repo_root/bounty-pocs/recon/programs.json"

# garante que o Python ache _common_json.py
export PYTHONPATH="$scripts_dir:${PYTHONPATH:-}"

python3 - <<'PY' "$in" "$out"
import sys, time, datetime
from _common_json import load_json, dump_json

data = load_json(sys.argv[1], {"targets": []})

for t in data.get("targets", []):
    t.setdefault("bounty", {
        "platform": "Immunefi",
        "range_usd": "variable",
        "url": t.get("bounty_url", "") or ""
    })

# adiciona stats extras
stats = data.get("stats", {})
stats["programs_count"] = len(data.get("targets", []))
data["stats"] = stats

now = int(time.time())
data["programs_updated_at"] = now
data["programs_updated_at_iso"] = datetime.datetime.fromtimestamp(now, datetime.UTC).isoformat().replace("+00:00", "Z")

dump_json(sys.argv[2], data)
print(f"[ok] wrote {sys.argv[2]}")
PY

jq . "$out" >/dev/null
echo "[ok] validated $out"
