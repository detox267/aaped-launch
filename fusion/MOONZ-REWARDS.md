# MOONZ holder rewards

This is the **new Fusion program, deployed on mainnet but inactive** at `CVzSF4nNHwu12giZUo9WZYGBw5VAbmgFN11ywVXizfmo`. Public source verification succeeded for release `58ee233a0f5505f7cc62a976dea282c67c553eca` on 2026-11-15; its config was initialized paused at slot `469712739`, and platform tax registration/backend integration are still pending. The original immutable Moonz program is called for purchases but remains unchanged. Fusion retains its upgrade authority and embedded security.txt. Keep launches and rewards disabled until integration and canary checks pass.

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
| 17 | FundDistributionFees | Fund operator SOL from the platform share only |

Use `client/rewards.cjs` for all new builders, decoding and proofs. Merkle leaves bind the **rewards PDA**, so a legacy launch-domain proof or another CA's proof cannot authorize payment. State/program IDs and canonical vaults are checked on chain.

## Market pricing and routing

`worker/moonz-market.cjs` reads finalized canonical state, mint and reserves. It supports the original SOL bonding curve plus SOL/USDC AMM phases. Curve price uses the program's virtual reserves, not treasury balance alone. Its executable buy quote reproduces the immutable 125-bps fee and ceiling-division output, applies slippage and bounds price impact. A purchase spanning curve graduation is held for a smaller budget or a new quote after migration. Stale RPC block times, unavailable liquidity and unsupported market states are rejected.

A reserve/curve price is a display estimate, not guaranteed liquidation value. Dollar valuation also requires a fresh SOL/USDC USD observation. The existing five-minute sale worker does not infer MOONZ's price merely from collections and does not fabricate chart candles.

`worker/reward-plan.cjs` is a **read-only backend integration module**. It returns initialization/purchase instructions and statuses; it cannot sign or broadcast. The backend supplies its reviewed net tier (at least $500, then its existing progression) and independently reviewed eligible holder snapshot. `planRound` allocates exact MOONZ pro rata, retaining skipped-ATA allocations and dust. The caller must verify ATA existence and eligibility at the recorded snapshot; a boolean supplied to this helper is not an on-chain proof of eligibility.

The planner supports a pair matching MOONZ's current market quote, or MOONZ itself. Other paired assets return `bridge_review_required`. The on-chain/client bridge boundary is implemented, but live Jupiter quote fetching, address lookup tables, actual route replay and durable bridge receipts require integration tests before that path can be enabled. Do not route through an operator-owned wallet to bypass this hold.

## Activation work still required

The current signed-journal runner remains **collection and first-sale only**. The new platform-funded distribution sender implements prepare-before-send journaling and finalized fee/payout receipts, but must still be called from the backend's tier progression and reviewed holder-snapshot flow. MOONZ purchase submissions and platform-profit withdrawals still need their release integration. This release does not automatically enable those operations. Persist exact signed bytes before submission, never re-sign an ambiguous transaction, revalidate quotes after simulation, and credit only finalized raw vault movements. ATA initialization rent comes from the operator's SOL and must be included in its debit/reserve checks.

The live backend, launch website binding, platform tax authority and capped canary remain prerequisites. Source tests are not an independent audit or proof of mainnet readiness. Keep the release draft and live flags disabled until those concrete integration checks pass.


## Distribution costs come out of the platform's 25%

Holder amounts are never reduced for the SOL network/priority fee used to distribute them. The fee payer is the platform operator. `FundDistributionFees` unwraps a bounded part of a SOL-paired CA's **platform_available**, credits SOL only to the configured operator, and increases `paid_platform`. It does not debit `holder_available`, the MOONZ reward balance, a round's remaining allocation, or any recipient wallet. Maximum top-up is 0.05 SOL; the operator balance after funding is bounded to 0.1 SOL. Paused, unauthorized, oversized and underfunded requests fail atomically.

`worker/distribution-fees.cjs` provides `DistributionFeeStore` and `PlatformDistributionSender` for the backend. It accepts only funding, opening a MOONZ round, exact MOONZ payouts and closing a round. The sender uses the existing verified `RpcAdapter`, an owner-only durable journal, a platform fee reservation before signing/broadcast, and exact finalized transaction receipts. `meta.fee` includes base and priority fees. Even a finalized failed send is a platform expense; it never reduces a holder's MOONZ allocation. An ambiguous or expired signature retains its reserved fee pending archival reconciliation. Never erase that journal or replace an ambiguous operation with a new signature.

The reserve is platform-wide; a verified SOL top-up from one CA's 25% can sponsor distributions for other CAs. Funding provenance and each expense's CA are recorded. This does not pool holder balances. Direct SOL deposits to the operator wallet are not automatically treated as collected platform revenue. Initial operator SOL is platform startup capital: the first funding transaction needs enough SOL to pay its fee and temporary account rent before reimbursement. Temporary rent is returned, not deducted from holders. The sender skips creation of holder ATAs; the existing missing-ATA rollover rule remains in force.

Only SOL-paired platform proceeds have an automatic on-chain funding instruction in this release. Other platform assets require separately reviewed conversion into SOL, or an already-funded shared platform reserve. If reserve or wallet balance is insufficient, distribution waits; there is no holder-funded fallback. The integration must replenish/reserve gas before sweeping platform profits. Funding the reserve is an allocation of platform funds, not a holder distribution or an additional revenue credit. Ordinary market trading fees in MOONZ conversion quotes are separate from these distribution network fees.
