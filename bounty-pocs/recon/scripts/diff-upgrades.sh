#!/usr/bin/env bash
set -euo pipefail
# Esqueleto: registrar implementação atual de um proxy (slot EIP-1967) e comparar depois
ADDR="${1:-0x0000000000000000000000000000000000000000}"
RPC="${RPC_URL:-http://127.0.0.1:8545}"

slot=$((0x360894A13BA1A3210667C828492DB98DCA3E2076CC3735A920A3CA505D382BBC))
impl=$(cast storage "$ADDR" $slot --rpc-url "$RPC" | sed 's/^0x0\+//; s/^0x//')
echo "impl_raw=0x$impl"
