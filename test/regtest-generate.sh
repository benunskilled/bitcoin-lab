#!/usr/bin/env bash
# Mines one regtest block via the dev bitcoind, so you can watch
# relay-profiler pick it up over ZMQ in real time:
#   docker compose -f docker-compose.dev.yml logs -f relay-profiler
set -euo pipefail

BCLI="docker compose -f docker-compose.dev.yml exec -T bitcoind bitcoin-cli -regtest -rpcuser=bitcoinlab -rpcpassword=bitcoinlab"

ADDR=$($BCLI getnewaddress 2>/dev/null || true)
if [ -z "$ADDR" ]; then
  ADDR=$($BCLI -named createwallet wallet_name=dev >/dev/null 2>&1; $BCLI getnewaddress)
fi

$BCLI generatetoaddress 1 "$ADDR"
