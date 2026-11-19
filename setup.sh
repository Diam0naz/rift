#!/usr/bin/env bash
# One-time setup: git repo + Foundry dependencies as submodules.
set -euo pipefail

if [ ! -d .git ]; then
  git init -b main
fi

forge install foundry-rs/forge-std
forge install OpenZeppelin/openzeppelin-contracts
forge install Reactive-Network/reactive-lib-omni

forge build
forge test
