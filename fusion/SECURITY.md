# Moonz Fusion security policy

Report vulnerabilities privately using [GitHub security advisories](https://github.com/detox267/aaped-launch/security/advisories/new).
Include the source commit, instruction/account inputs, expected behavior and a reproducible local test. Do not include private keys or exploit live funds.

This is a new, un-deployed implementation undergoing review. No independent audit is claimed. The embedded security.txt identifies this policy and the public source repository. Source verification proves a deployed binary matches a public commit; it does not prove correctness.

## Authority and trust boundaries

- The deployment remains upgradeable. The loader upgrade authority can replace program logic. Initialization verifies that authority's signature, and no instruction revokes or changes it. Application admin rotation is a separate two-step process.
- The admin can pause operations and rotate the operator. The fee recipient, platform and CPMM config are fixed by initialization in v1.
- The operator chooses swap amounts/minimum output and publishes holder snapshot roots. Holder ownership, USD pricing, the $30 threshold, exclusions and tier timing remain backend responsibilities. A compromised operator can publish a dishonest allocation or bad price; Merkle proofs do **not** establish those external facts. The program enforces the root, budget, recipient, route and replay boundaries.
- Each token has a separate launch PDA and canonical vaults. Tax withdrawal uses one program-derived platform authority but always validates the mint and this token's destination vault. There is no general arbitrary CPI or arbitrary admin withdrawal instruction.
- Conversion proceeds and explicit quote donations are split cumulatively: 25% platform, 75% holders, with rounding dust assigned to holders. Expired unclaimed amounts return to the same token's net holder budget without another split.
- Payment roots support up to 1,024 unique on-curve recipients and expire after 1 hour–30 days. The backend must persist the complete snapshot/proofs before submission, reconcile finalized chain state, and use sequential rounds for larger snapshots. Missing/frozen/nonstandard recipient accounts fail atomically and can be retried before expiry or rolled into a later round.
- Quote mints with transfer-fee, transfer-hook or other unsupported mint extensions are rejected. Ordinary quote issuer freeze authority is supported (e.g. USDC); issuer freezing can prevent payments.
- Solana and Raydium runtime behavior, Raydium upgrades and quote issuers remain external dependencies. Re-run real-program fixtures and verification after changes.
- The RPC collector's US$30 sale floor is separate from the US$30 holder-eligibility policy. The former values fresh slippage-protected paired output before the platform split; neither USD policy is enforced by an on-chain oracle. The collector trusts finalized RPC data and Jupiter's price-observation block/time. It does not authorize website launches or construct holder snapshot roots.
- The canary runner requires a verified matching binary, retained expected upgrade authority, current config/operator/fee/platform bindings and operator-funded gas. Its explicit mint list limits this first runner to a small canary. A changed program binary or pause blocks new sends while existing signatures can still be reconciled. Stored signed transactions are sensitive operational state: preserve their SQLite journal and single-process lock, and resolve ambiguous history using archival RPC. Do not share a price API allowance with another process unless its request pacing is coordinated.

The OG immutable Moonz program is outside this implementation. Do not deploy Fusion over its address. Do not use `--final` or set the upgrade authority to `None`.
