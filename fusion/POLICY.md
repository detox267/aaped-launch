# Fusion policy vault extension

This is an upgrade candidate, not an activation receipt. Keep the existing upgrade authority. Existing instruction tags 0–17 and the Config, Launch and Rewards account layouts are unchanged.

Each version-2 launch may create a separate PDA at `["policy", launchPda]`, with canonical base, paired-token and MOONZ ATAs. The 113-byte state tracks purchased/burned base tokens, holder quote spent, reserved/spent/released platform prize funds, MOONZ prizes paid and an operation sequence.

| Tag | Instruction | Source and destination |
| --- | --- | --- |
| 18 | InitializePolicy | Operator pays state/ATA rent from verified platform operating funds |
| 19 | Buyback | This launch's holder quote pot → pinned Raydium pool → policy base vault |
| 20 | BurnBuyback | Recorded net bought inventory → Token-2022 burn |
| 21 | ReserveCreatorPrize | This launch's platform pot → policy quote vault |
| 22 | PayCreatorPrizeMoonz | Reserved platform funds → canonical MOONZ → original creator's existing ATA |
| 23 | ReleaseCreatorPrize | Unused reserve → the same launch's platform pot, without another split |

The client in `client/policy.cjs` rebuilds the exact instructions. Buybacks reject other programs, foreign authority signers, changed input/output amounts, foreign pool/vault accounts, expired deadlines and insufficient output. Creator prizes bind the original on-curve creator; recipient ATA creation is an explicit separate platform expense, never a silent debit from the holder pot.

The backend enforces five-minute collection slots, the conservative $30 sale floor, tier/challenge deadlines and fresh external-trade candle signals. The program cannot establish USD value, off-chain holder eligibility or challenge qualification; its operator trust boundary is explicit in `SECURITY.md`.

Tests use actual Raydium LaunchLab/CPMM, the immutable OG MOONZ program and Token-2022 in LiteSVM. They cover budget isolation, wrong recipients/accounts/operators, pause/deadline/slippage failure, net received tax tokens, donation preservation, exact burns, MOONZ-direct prizes and returning unused platform reserves. Run `npm test`, `npm run test:svm`, `cargo test --locked` and Clippy. Build the pinned candidate with `solana-verify` before deployment and repeat independent public verification after the upgrade.
