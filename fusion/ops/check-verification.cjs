#!/usr/bin/env node
"use strict";
const fs = require("node:fs"),
  crypto = require("node:crypto");
const { Connection, PublicKey } = require("@solana/web3.js");
const { LOADER, addresses, decodeConfig } = require("../client/index.cjs");
const OG = "DBc9SEQghiJUj52YPqTKk8R4CMRgagBxi2LU1yBbeMpk";
const need = (ok, message) => {
  if (!ok) throw new Error(message);
};
function hash(bytes) {
  let end = bytes.length;
  while (end && bytes[end - 1] === 0) end--;
  return crypto
    .createHash("sha256")
    .update(bytes.subarray(0, end))
    .digest("hex");
}
function check({
  programId,
  expectedAuthority,
  expectedCommit,
  binary,
  program,
  programData,
  verification,
}) {
  need(programId !== OG, "Refusing the OG program");
  need(
    /^[0-9a-f]{40}$/.test(expectedCommit),
    "A full release commit is required",
  );
  need(
    binary.subarray(0, 4).toString("hex") === "7f454c46" &&
      binary.includes(Buffer.from("Moonz Fusion")) &&
      binary.includes(Buffer.from("security/advisories/new")),
    "Wrong binary or missing security.txt",
  );
  const key = new PublicKey(programId),
    expectedData = addresses(key).programData;
  need(
    program?.executable &&
      program.owner.equals(LOADER) &&
      program.data.length === 36 &&
      program.data.readUInt32LE(0) === 2,
    "Not an upgradeable loader-v3 program",
  );
  need(
    new PublicKey(program.data.subarray(4, 36)).equals(expectedData),
    "ProgramData binding mismatch",
  );
  need(
    programData?.owner.equals(LOADER) &&
      programData.data.length >= 45 &&
      programData.data.readUInt32LE(0) === 3,
    "Invalid ProgramData",
  );
  need(
    programData.data[12] === 1 &&
      new PublicKey(programData.data.subarray(13, 45)).equals(
        new PublicKey(expectedAuthority),
      ),
    "Upgrade authority missing or changed",
  );
  const deployedHash = hash(programData.data.subarray(45)),
    localHash = hash(binary);
  need(deployedHash === localHash, "Deployed binary differs from this release");
  need(
    verification?.is_verified === true &&
      verification.is_frozen === false &&
      verification.is_closed === false,
    "Public verification is not current and upgradeable",
  );
  need(
    verification.commit === expectedCommit,
    "Verification belongs to a different commit",
  );
  need(
    verification.repo_url === "https://github.com/detox267/aaped-launch" ||
      verification.repo_url ===
        `https://github.com/detox267/aaped-launch/tree/${expectedCommit}`,
    "Wrong verified repository",
  );
  need(
    verification.on_chain_hash === deployedHash &&
      verification.executable_hash === localHash,
    "Verification hash differs from current chain",
  );
  return {
    verified: true,
    upgradeable: true,
    programId,
    upgradeAuthority: expectedAuthority,
    commit: expectedCommit,
    executableHash: localHash,
  };
}
async function main() {
  const [programId, expectedAuthority, expectedCommit, binaryPath] =
    process.argv.slice(2);
  need(
    binaryPath,
    "Usage: node ops/check-verification.cjs PROGRAM AUTHORITY COMMIT BINARY",
  );
  const key = new PublicKey(programId),
    a = addresses(key),
    rpc = new Connection(
      process.env.FUSION_RPC_URL || "https://api.mainnet-beta.solana.com",
      "finalized",
    );
  const [program, programData, config] = await rpc.getMultipleAccountsInfo([
    key,
    a.programData,
    a.config,
  ]);
  need(!config || config.owner.equals(key), "Unexpected config owner");
  const response = await fetch(
    `https://verify.osec.io/status/${key.toBase58()}`,
    { signal: AbortSignal.timeout(15000) },
  );
  need(response.ok, "Verification service unavailable");
  const result = check({
    programId,
    expectedAuthority,
    expectedCommit,
    binary: fs.readFileSync(binaryPath),
    program,
    programData,
    verification: await response.json(),
  });
  console.log(
    JSON.stringify(
      {
        readOnly: true,
        transactionsSent: 0,
        ...result,
        config: config
          ? { ...decodeConfig(config.data), address: a.config.toBase58() }
          : null,
        activationAllowed: false,
        note: "Verification gate only. Platform authority, quote registration, backend adapter and a canary still require validation before enabling launches/rewards.",
      },
      null,
      2,
    ),
  );
}
if (require.main === module)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
module.exports = { check, hash };
