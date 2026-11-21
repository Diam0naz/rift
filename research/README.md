# Research: replaying real bridge failures

Scripts that rebuild real incidents from public chain history and apply Rift's trip rule to them.
They read only public RPCs (no third-party data), so anyone can re-run them.

| Script | What it does |
|---|---|
| `nomad-replay.mjs` | The two-condition trip on the 2022 Nomad exploit: USDC outflow from Nomad's escrow on Ethereum + Nomad-bridged USDC's price on Moonbeam. Writes `nomad-replay.json`. |
| `nomad-outflow.mjs` | The outflow condition alone, for every token in Nomad's escrow. Writes `nomad-outflow.json`. |
| `moonbeam-pools.mjs` | How the Moonbeam pool was found: the busiest counterparties of Nomad-bridged USDC around the exploit. |

```bash
node research/nomad-replay.mjs   # ~10 min: public RPCs limit log queries to small block ranges
```

RPCs used: `eth.drpc.org` (Ethereum, archive; 100-block log ranges on the free plan) and
`moonbeam.api.onfinality.io/public` (Moonbeam, archive). They need `frontend/node_modules` (viem).
