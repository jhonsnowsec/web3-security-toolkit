#!/usr/bin/env python3
# Lê automation/kpi.log (JSONL) e sumariza contagem por target/dia
import json, collections, pathlib
log = pathlib.Path(__file__).parent / "kpi.log"
counts = collections.Counter()
if log.exists():
    for line in log.read_text().splitlines():
        try:
            e = json.loads(line)
            counts[e.get("target","unknown")] += 1
        except Exception:
            pass
print(json.dumps(counts.most_common(), indent=2))
