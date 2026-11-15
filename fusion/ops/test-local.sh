#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(cargo-build-sbf --version)
if [[ "$version" != *"solana-cargo-build-sbf 2.3.13"* || "$version" != *"platform-tools v1.48"* ]]; then
  echo 'Use Agave 2.3.13 / platform-tools v1.48 for the pinned test build.' >&2
  exit 1
fi
cargo +1.89.0 fmt --check
cargo +1.89.0 clippy --all-targets --locked -- -D warnings
cargo +1.89.0 test --locked
cargo-build-sbf -- --locked
npm ci --ignore-scripts --no-audit --no-fund
npm test
node ops/fetch-raydium-fixture.cjs
npm run test:svm
node ops/budget.cjs
