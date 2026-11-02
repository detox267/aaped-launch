#!/usr/bin/env node
"use strict";
// Read-only companion to the existing backend readiness report. No sends, env
// changes, key creation/import, database writes, PM2 actions or secrets in output.
const fs = require("node:fs"), path = require("node:path"), { createRequire } = require("node:module");
async function main() {
  const apiDir = process.argv[2] || "/root/aaped-api", fromApi = createRequire(path.join(apiDir, "package.json"));
  const { Keypair, Connection } = fromApi("@solana/web3.js");
  const env = fromApi("dotenv").parse(fs.readFileSync(path.join(apiDir, ".env")));
  const cfg = fromApi("./launchlab/config").readConfig(env);
  const { publicKeyFile } = fromApi("./launchlab/ops/check-readiness.cjs");
  const admin = cfg.admin?.toBase58(), operator = cfg.rewards.wallet?.toBase58();
  if (admin !== "5zDozijrnBsdQ4CgDddJhBFDrmuoSya8C2EG15sZEFt6" || operator !== "CtnPVM3vrBZik3HxMZAvhjQpmSYz5HZUAqXvn6az9GQ"
    || cfg.cluster !== "mainnet-beta") throw new Error();
  const rpc = new Connection(cfg.rpcUrl, { commitment: "finalized", disableRetryOnRateLimit: true });
  if (await rpc.getGenesisHash() !== "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d") throw new Error();
  console.log(JSON.stringify({ readOnly: true, transactionsSent: 0,
    admin: { address: admin, signer: publicKeyFile(cfg.pairSetup.keyFile, admin, Keypair), lamports: await rpc.getBalance(cfg.admin) },
    operator: { address: operator, signer: publicKeyFile("/root/.config/moonz/reward-collector.json", operator, Keypair), lamports: await rpc.getBalance(cfg.rewards.wallet) },
    priceKeyConfigured: !!cfg.prices.apiKey, launchEnabled: cfg.requestedEnabled,
    rewardsEnabled: cfg.rewards.enabled, rewardsLive: cfg.rewards.live }, null, 2));
}
if (require.main === module) main().catch(() => { console.error("Signer/balance check failed. No changes or transactions were made."); process.exitCode = 1; });
