# MOONZ holder rewards

This is a source change for the **new, undeployed Fusion program**. It is not a mainnet activation. The original immutable Moonz program is called for purchases but remains unchanged. Fusion keeps its upgrade authority and embedded security.txt. Build verification must be repeated for this new artifact before integration.

## Money flow

Every five minutes the existing collector harvests each launch's fixed 3% transfer tax. It sells only when a fresh, slippage-protected quote reaches US$30 before the split. Smaller amounts accumulate in that CA's base vault.

Actual paired proceeds are credited once: 25% to the platform's paired budget, 75% to that CA's paired holder budget. At the reviewed holder payout tier, the latter buys MOONZ. Actual MOONZ received becomes that CA's MOONZ holder budget. MOONZ is not split a second time. The immutable OG market charges its ordinary 1.25% trading fee; any bridge also incurs its route's execution costs.

The platform share remains in the original paired asset. A MOONZ-paired launch can transfer its net holder amount directly to its MOONZ rewards vault. Missing recipient MOONZ ATAs and rounding dust leave an unallocated balance; unpaid reserved allocations roll over after expiry.

## Accounts and compatibility

Config remains version 1 (202 bytes). Launch remains 393 bytes, but newly created launches have `version=2`. Existing version-1 records and their paired payout ABI remain readable. Version-2 launches cannot use legacy `OpenRound`, `Pay` or `CloseRound`. There is no implicit migration of a legacy record with active paired obligations.

Each version-2 launch initializes `['rewards', launchPDA]`, a 257-byte account. It owns canonical SPL ATAs for MOONZ and any required swap escrow. Its fields are version, launch address, then eight u64 values (`available`, `credited`, `paid`, `quoteSpent`, `round`, `remaining`, `deadline`, `leaves`), root32, bitmap128. Only `quoteSpent` uses paired units; all other monetary fields use raw six-decimal MOONZ. MOONZ obligations are `available + remaining`.

Paired conservation is now `credited = holderAvailable + platformAvailable + paidPlatform + rewards.quoteSpent` for version 2. MOONZ conservation is `rewards.credited = available + remaining + paid`. Unsolicited pre-funding is not silently credited as another distribution.

New append-only instruction tags:

| Tag | Instruction | Purpose |
| --- | --- | --- |
| 12 | InitializeRewards | Operator-funded per-CA state and MOONZ ATA |
| 13 | BuyMoonz | Atomic paired-holder debit and actual MOONZ credit |
| 14 | OpenMoonzRound | Reserve MOONZ against a reviewed Merkle root |
| 15 | PayMoonz | Exact MOONZ payout with bitmap replay protection |
| 16 | CloseMoonzRound | Return expired unpaid MOONZ to the same CA |

Use `client/rewards.cjs` for all new builders, decoding and proofs. Merkle leaves bind the **rewards PDA**, so a legacy launch-domain proof or another CA's proof cannot authorize payment. State/program IDs and canonical vaults are checked on chain.

## Market pricing and routing

`worker/moonz-market.cjs` reads finalized canonical state, mint and reserves. It supports the original SOL bonding curve plus SOL/USDC AMM phases. Curve price uses the program's virtual reserves, not treasury balance alone. Its executable buy quote reproduces the immutable 125-bps fee and ceiling-division output, applies slippage and bounds price impact. A purchase spanning curve graduation is held for a smaller budget or a new quote after migration. Stale RPC block times, unavailable liquidity and unsupported market states are rejected.

A reserve/curve price is a display estimate, not guaranteed liquidation value. Dollar valuation also requires a fresh SOL/USDC USD observation. The existing five-minute sale worker does not infer MOONZ's price merely from collections and does not fabricate chart candles.

`worker/reward-plan.cjs` is a **read-only backend integration module**. It returns initialization/purchase instructions and statuses; it cannot sign or broadcast. The backend supplies its reviewed net tier (at least $500, then its existing progression) and independently reviewed eligible holder snapshot. `planRound` allocates exact MOONZ pro rata, retaining skipped-ATA allocations and dust. The caller must verify ATA existence and eligibility at the recorded snapshot; a boolean supplied to this helper is not an on-chain proof of eligibility.

The planner supports a pair matching MOONZ's current market quote, or MOONZ itself. Other paired assets return `bridge_review_required`. The on-chain/client bridge boundary is implemented, but live Jupiter quote fetching, address lookup tables, actual route replay and durable bridge receipts require integration tests before that path can be enabled. Do not route through an operator-owned wallet to bypass this hold.

## Activation work still required

The current signed-journal runner remains **collection and first-sale only**. MOONZ purchase and holder/platform payout submissions must be wired to the backend's durable prepare-before-send journal, finalized receipts, tier progression and reviewed holder snapshots. This release does not automatically enable those operations. Persist exact signed bytes before submission, never re-sign an ambiguous transaction, revalidate quotes after simulation, and credit only finalized raw vault movements. ATA initialization rent comes from the operator's SOL and must be included in its debit/reserve checks.

The live backend, launch website binding, new program deployment, public source verification and capped canary remain prerequisites. Source tests are not an independent audit or proof of mainnet readiness. Keep the release draft and live flags disabled until those concrete integration checks pass.
