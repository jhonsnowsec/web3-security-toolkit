#!/usr/bin/env bash
set -euo pipefail
: "${RPC_URL:?export RPC_URL}"
: "${BLOCK:?export BLOCK}"

forge test --fork-url "$RPC_URL" --fork-block-number "$BLOCK" -vvvv
