#!/usr/bin/env bash
set -euo pipefail

NET=${1:-optimism}
BLOCK=${BLOCK:-"latest"}
PORT=${PORT:-8545}

set -a
source .env
set +a

case "$NET" in
  optimism) RPC=$RPC_OPTIMISM; CHAIN_ID=10 ;;
  mainnet)  RPC=$RPC_MAINNET;  CHAIN_ID=1  ;;
  arbitrum) RPC=$RPC_ARBITRUM; CHAIN_ID=42161 ;;
  *) echo "unknown net: $NET"; exit 1 ;;
esac

echo "Forking $NET @ block $BLOCK on port :$PORT (chain-id=$CHAIN_ID)"
anvil --fork-url "$RPC" --fork-block-number $BLOCK --port $PORT --chain-id $CHAIN_ID --silent
