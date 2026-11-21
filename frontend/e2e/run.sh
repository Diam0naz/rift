#!/usr/bin/env bash
# End-to-end test of the Trade panel against a local anvil fork of Unichain Sepolia.
#
#   1. Forks Unichain Sepolia (chain id 1301) on :8545.
#   2. On the fork only: impersonates the market owner to reset the demo, and the Reactive callback
#      proxy to deliver a fresh mark, so the market accepts new risk.
#   3. Builds the frontend in E2E mode (mock "Test wallet" = anvil's unlocked account #0) and serves :3001.
#   4. Drives faucet, buy cover, a deliberate revert, deposit/withdraw, open/close perp in headless Chrome.
#
# Needs: foundry (anvil, cast), google-chrome, node 22+, pnpm. Nothing touches the real testnet.
set -euo pipefail
cd "$(dirname "$0")/.."

RPC=http://127.0.0.1:8545
FORK_URL=${FORK_URL:-https://sepolia.unichain.org}
MARKET=0x45c96DC6c9f5C5A8CFe0Ac8B88DCD7F49b16Bcb0
OWNER=0xD04927546678d4255bA0D4c6C2E4D7289baa4B5D
PROXY=0x775c9B990ADe401060B78D0e98684eEf8d2466C1
REACTIVE=0xAD0983eBF145C8f8184bf219E795aC63fEE58B78
TEST_ACCOUNT=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 # anvil account #0
OUT=${E2E_OUT:-$(mktemp -d)}

cleanup() {
  [[ -n "${NEXT_PID:-}" ]] && kill "$NEXT_PID" 2>/dev/null || true
  [[ -n "${ANVIL_PID:-}" ]] && kill "$ANVIL_PID" 2>/dev/null || true
}
trap cleanup EXIT

anvil --fork-url "$FORK_URL" --chain-id 1301 --port 8545 --silent &
ANVIL_PID=$!
timeout 60 bash -c "until cast chain-id --rpc-url $RPC >/dev/null 2>&1; do sleep 1; done"

cast rpc anvil_impersonateAccount "$OWNER" --rpc-url "$RPC" >/dev/null
if [[ "$(cast call "$MARKET" 'tripped()(bool)' --rpc-url "$RPC")" == "true" ]]; then
  cast send "$MARKET" 'resetDemo()' --from "$OWNER" --unlocked --rpc-url "$RPC" >/dev/null
fi
cast rpc anvil_setBalance "$PROXY" 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null
cast rpc anvil_impersonateAccount "$PROXY" --rpc-url "$RPC" >/dev/null
NOW=$(cast block latest -f timestamp --rpc-url "$RPC")
cast send "$MARKET" 'updateMark(address,int256,uint256,uint256,uint256)' "$REACTIVE" 120 "$NOW" 84532 0 \
  --from "$PROXY" --unlocked --rpc-url "$RPC" >/dev/null
echo "fork ready: tripped=$(cast call "$MARKET" 'tripped()(bool)' --rpc-url "$RPC")"

export NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_E2E=1 NEXT_PUBLIC_E2E_ACCOUNT=$TEST_ACCOUNT NEXT_PUBLIC_UNICHAIN_SEPOLIA_RPC=$RPC
pnpm build >/dev/null
pnpm start -p 3001 >/dev/null 2>&1 &
NEXT_PID=$!
timeout 60 bash -c 'until curl -sf http://localhost:3001 >/dev/null; do sleep 1; done'

node e2e/trade.mjs http://localhost:3001/app "$OUT"
echo "screenshots in $OUT"
echo "note: this build is E2E-only; run 'pnpm build' again before serving the real dashboard."
