#!/usr/bin/env node
"use strict";
// Read-only public chain fixture. Writes only public account state to the ignored test fixtures directory.
const fs = require("node:fs"),
  path = require("node:path");
const { Connection, PublicKey } = require("@solana/web3.js");
const sdk = require("@raydium-io/raydium-sdk-v2"),
  spl = require("@solana/spl-token");
const { LAUNCHLAB, CPMM, LOADER } = require("../client/index.cjs");
async function main() {
  const connection = new Connection(
    process.env.FUSION_RPC_URL || "https://api.mainnet-beta.solana.com",
    "finalized",
  );
  const out = path.join(__dirname, "../test/fixtures");
  fs.mkdirSync(out, { recursive: true });
  const keys = [
    new PublicKey("3gJPDjVbPMM5pSDbWJfmx28QMtp8vaJeUkfneZ25jsdU"),
    new PublicKey("D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2"),
    spl.NATIVE_MINT,
  ];
  for (let i = 0; i < 3; i++)
    keys.push(
      sdk.getPdaLaunchpadConfigId(LAUNCHLAB, spl.NATIVE_MINT, 0, i).publicKey,
    );
  const global = keys[3];
  keys.push(
    sdk.getPdaPlatformAllowConfig(LAUNCHLAB, keys[0], global).publicKey,
    sdk.getPdaPlatformCurveRule(LAUNCHLAB, keys[0], global).publicKey,
  );
  keys.push(sdk.CREATE_CPMM_POOL_FEE_ACC);
  const result = await connection.getMultipleAccountsInfoAndContext(keys);
  const accounts = result.value
    .map((a, i) =>
      a
        ? {
            address: keys[i].toBase58(),
            owner: a.owner.toBase58(),
            lamports: a.lamports,
            executable: a.executable,
            data: a.data.toString("base64"),
          }
        : null,
    )
    .filter(Boolean);
  fs.writeFileSync(
    path.join(out, "accounts.json"),
    JSON.stringify({ slot: result.context.slot, accounts }, null, 2) + "\n",
  );
  for (const [name, id] of [
    ["launchlab", LAUNCHLAB],
    ["cpmm", CPMM],
  ]) {
    const program = await connection.getAccountInfo(id);
    if (!program?.owner.equals(LOADER) || program.data.readUInt32LE(0) !== 2)
      throw new Error("Unexpected loader");
    const programData = new PublicKey(program.data.subarray(4, 36)),
      a = await connection.getAccountInfo(programData);
    if (!a?.owner.equals(LOADER) || a.data.readUInt32LE(0) !== 3)
      throw new Error("Unexpected program data");
    fs.writeFileSync(path.join(out, name + ".so"), a.data.subarray(45));
    console.log(name, id.toBase58(), a.data.length - 45, "bytes");
  }
  console.log(
    "Read-only fixture slot",
    result.context.slot,
    "accounts",
    accounts.length,
    "transactionsSent",
    0,
  );
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
