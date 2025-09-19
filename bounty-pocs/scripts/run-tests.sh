#!/usr/bin/env bash
set -euo pipefail

# Config
RPC_URL=${RPC_URL:-"http://127.0.0.1:8545"}
REQUIRED_CHAIN_HEX=${REQUIRED_CHAIN_HEX:-"0xa"} # 10 (Optimism)
EXTRA_ARGS=${EXTRA_ARGS:-""}                   # ex: "--ffi" ou outras flags do forge
VERBOSE=${VERBOSE:-"-vvvv"}                    # nível de log do forge

echo "[preflight] Verificando RPC em ${RPC_URL}..."
CID_HEX=$(cast rpc eth_chainId --rpc-url "$RPC_URL" 2>/dev/null | tr -d '"')
if [ -z "$CID_HEX" ]; then
  echo "[ERRO] eth_chainId falhou em ${RPC_URL}." >&2
  exit 1
fi
if [ "$CID_HEX" != "$REQUIRED_CHAIN_HEX" ]; then
  echo "[ERRO] chain-id inesperado: ${CID_HEX} (esperado ${REQUIRED_CHAIN_HEX})." >&2
  exit 1
fi

# Opcional: valida bloco se BLOCK estiver definido
if [ "${BLOCK:-}" != "" ]; then
  BN=$(cast block-number --rpc-url "$RPC_URL" 2>/dev/null || true)
  if [ "$BN" != "$BLOCK" ]; then
    echo "[AVISO] block-number atual=${BN} difere do esperado=${BLOCK}." >&2
  fi
fi

export ETH_RPC_URL="$RPC_URL"
echo "[ok] chain-id=$CID_HEX. Rodando testes..."
exec forge test ${VERBOSE} --fork-url "$RPC_URL" ${EXTRA_ARGS}
