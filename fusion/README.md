# Moonz Fusion PDA program

Standalone native Solana program and CommonJS client for per-token launch/reward vaults. The program ID is supplied by the runtime, so the build contains no embedded deployment key. This directory is a separate Cargo workspace; it does not modify the OG program.

**Status: local implementation; not deployed, not publicly verified, not connected to the live backend.** Keep launches/rewards disabled until the release checks below pass. Public source verification and upgradeability are both required.

## Implemented behavior

- Launch through Raydium LaunchLab's Token-2022 instruction: 1B supply, 650M curve sale, 6 decimals, no vesting, CPMM migration, fixed 3% transfer tax with `u64::MAX` cap. User pays launch account rent; the mint signs initialization. The program enforces zero extra platform/creator trading fee and full LP burn in the platform configuration.
- Per-CA state `['launch', baseMint]`, base/paired-asset ATAs owned by that PDA, shared collection authority `['tax-authority']`, global config `['config']`.
- Collect withheld tax from the mint or at most 16 same-mint accounts. Convert through fixed Raydium LaunchLab/CPMM entrypoints, bound to this CA's source/destination and pair. Check exact input debit and minimum paired-asset receipt after CPI. Swaps have a maximum input and a deadline no more than five minutes ahead.
- Credit actual received quote units once. Maintain distinct net holder/platform budgets and reserve an active holder distribution. Anyone can relay a valid payment; the operator commits the snapshot. Native SOL is unwrapped in a temporary PDA without using holder money for rent or gas. Token payouts require an existing, unfrozen canonical ATA. Platform payments go only to the configured fee wallet.
- Reject duplicate/index/round/CA/recipient/amount proof substitution, over-budget claims and cross-vault sources. Expired unpaid holder amounts roll over. Admin pause/operator rotation and two-step application-admin rotation retain loader upgrade authority.

The client exports instruction builders, PDA derivations, state decoders and domain-separated Merkle trees. Integers are BigInt/decimal strings. See `test/svm/flow.test.cjs` for launch/collection/conversion/payout examples and `SECURITY.md` for trust boundaries.

## Local validation

Prerequisites: Node 20+, Rust 1.89.0 (fmt/clippy), Agave **2.3.13**, platform-tools **v1.48**. Cargo/npm lockfiles are committed. Some transitive dependencies are deliberately pinned in Cargo.lock for the SBF compiler; do not blindly refresh it.

```bash
bash ops/test-local.sh
```

The fixture fetcher performs only finalized public RPC reads. It downloads deployed Raydium ELF programs and public config accounts into an ignored directory. LiteSVM tests execute the actual Fusion SBF binary and real Raydium/SPL programs. In the local fixture only, the platform tax authority is changed to Fusion and quote restrictions are relaxed to exercise a SOL launch. The live platform's allow/curve rules still need registration checks. The CPMM test creates a real CPMM pool locally; it does not exercise Raydium's privileged graduation service. No tests submit mainnet transactions.

The current backend at `0b8606ba8a959f95dcbddb6a4612e16b648f8154` remains unchanged. Its 235 tests passed in the recovery review. Its shared-signer worker is **not** a drop-in PDA worker. Tier/eligibility decisions can remain off chain, but journal/receipt reconciliation must use these instruction builders and on-chain net budgets. Do not apply another 25% split. Existing buyback/burn and creator-prize features need explicit adapters or subsequent program instructions; this v1 exposes holder payouts and payments to the configured fee wallet only.

## Verified, upgradeable release

The review workflow uses checksum-pinned `solana-verify 0.5.2`, builds in Docker, and runs the SBF tests against that artifact. It has read-only repository permissions and cannot deploy or activate anything. Its artifact becomes a release candidate only after that workflow passes; it is not on-chain verification.

1. Review and pin the public commit. Build it using `solana-verify` with Docker; the workspace metadata selects Agave 2.3.13. From this directory:
   ```bash
   solana-verify build . --library-name moonz_fusion -- --locked
   ```
   The Docker output is the release artifact. Re-run all SBF tests against it. A locally compiled ELF is a development artifact until reproduced by this workflow.
2. Run `node ops/budget.cjs target/deploy/moonz_fusion.so` against that artifact. The JSON separates permanent rent from conservative temporary-buffer rent. Optional second argument sets program capacity in bytes. Transaction fees, verification metadata and operator working balance are separate. Create the deployment keypair only on the VPS, outside Git, after the amount and authority are reviewed. Never share it.
3. Deploy the reviewed Docker artifact to a **new** program address with an explicit retained upgrade authority. Record program ID, deployment transaction, binary hash, capacity, public commit and authority. Do not use the OG address or `--final`. This repository deliberately has no automatic mainnet deployment/activation script.
4. Verify the deployed artifact against the public commit (the upload requires the upgrade authority):
   ```bash
   solana-verify verify-from-repo -u "$FUSION_RPC_URL" \
     --program-id "$FUSION_PROGRAM_ID" \
     --commit-hash "$FUSION_RELEASE_COMMIT" \
     --mount-path fusion --library-name moonz_fusion \
     --keypair "$FUSION_UPGRADE_KEYPAIR" \
     https://github.com/detox267/aaped-launch -- --locked
   solana-verify remote submit-job --program-id "$FUSION_PROGRAM_ID" \
     --uploader "$FUSION_UPGRADE_AUTHORITY"
   node ops/check-verification.cjs "$FUSION_PROGRAM_ID" \
     "$FUSION_UPGRADE_AUTHORITY" "$FUSION_RELEASE_COMMIT" target/deploy/moonz_fusion.so
   ```
5. Initialize config **paused** through the retained upgrade authority. Review the exact operator, Moonz fee wallet, platform, CPMM config and maximum swap amount. Verify the platform's tax authority now points to this program's `tax-authority` PDA and the quote allow/curve rules are correct. Existing platform configuration currently points at the old collector wallet; do not change it before program verification.
6. Complete the backend adapter/reconciliation review and run a capped canary including actual graduation. Enable only after its final receipts, fee split, missing-ATA behavior and restart recovery reconcile. Keep the old worker disabled for PDA tokens. Rebuild and reverify every subsequent program upgrade before resuming activity.

Primary references: [Solana verified builds](https://solana.com/docs/programs/verified-builds), [security.txt format](https://github.com/neodyme-labs/solana-security-txt), Raydium SDK `0.2.74-alpha` (locked).
