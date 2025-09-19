#!/usr/bin/env python3
import sys, json
data = json.load(sys.stdin)  # [{"amount": 123.45, "price_usd": 2800.0}, ...]
total = sum(float(x["amount"]) * float(x["price_usd"]) for x in data)
print(f"{total:.2f}")
