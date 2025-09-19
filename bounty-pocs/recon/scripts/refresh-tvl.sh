#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
scripts_dir="$repo_root/bounty-pocs/recon/scripts"
targets_file="$repo_root/bounty-pocs/recon/targets.yml"
out="$repo_root/bounty-pocs/recon/targets.enriched.json"

# garante que o Python ache _common_json.py
export PYTHONPATH="$scripts_dir:${PYTHONPATH:-}"

python3 - <<'PY' "$targets_file" "$out"
import sys, time, datetime, yaml
from _common_json import to_float_safe, to_jsonable

with open(sys.argv[1], "r", encoding="utf-8") as f:
    data = yaml.safe_load(f) or []

# Normaliza TVL e define prioridade
for t in data:
    tvl = to_float_safe(t.get("tvl_usd", 0))
    t["tvl_usd"] = tvl
    t["priority"] = "HIGH" if tvl >= 1e8 else ("MEDIUM" if tvl >= 1e7 else "LOW")

# Calcula métricas globais
total_tvl = sum(x.get("tvl_usd", 0) for x in data)
stats = {
    "count_targets": len(data),
    "count_high_priority": sum(1 for x in data if x["priority"] == "HIGH"),
    "count_medium_priority": sum(1 for x in data if x["priority"] == "MEDIUM"),
    "count_low_priority": sum(1 for x in data if x["priority"] == "LOW"),
    "total_tvl_usd": total_tvl,
}

now = int(time.time())
payload = {
    "generated_at": now,
    "generated_at_iso": datetime.datetime.fromtimestamp(now, datetime.UTC).isoformat().replace("+00:00", "Z"),
    "stats": stats,
    "targets": to_jsonable(data),
}

import json
with open(sys.argv[2], "w", encoding="utf-8") as w:
    json.dump(payload, w, indent=2, allow_nan=False, ensure_ascii=False)

print(f"[ok] wrote {sys.argv[2]}")
PY

jq . "$out" >/dev/null
echo "[ok] validated $out"
