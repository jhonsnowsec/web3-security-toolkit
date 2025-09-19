#!/usr/bin/env python3
# Entrada: stdin com {"assets_usd":X,"liabilities_usd":Y,"loss_usd":Z}
import sys, json
m = json.load(sys.stdin)
assets = float(m["assets_usd"]) - float(m.get("loss_usd", 0))
liab = float(m["liabilities_usd"])
deficit = liab - assets
status = "INSOLVENT" if deficit > 0 else "SOLVENT"
print(json.dumps({"assets_after_loss_usd": assets, "liabilities_usd": liab, "deficit_usd": max(deficit,0.0), "status": status}, indent=2))
