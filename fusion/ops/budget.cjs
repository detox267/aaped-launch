#!/usr/bin/env node
"use strict";
const fs = require("node:fs"),
  crypto = require("node:crypto"),
  path = require("node:path");
const { Connection } = require("@solana/web3.js");
async function main() {
  const binary = fs.readFileSync(
    process.argv[2] || path.join(__dirname, "../target/deploy/moonz_fusion.so"),
  );
  if (
    binary.subarray(0, 4).toString("hex") !== "7f454c46" ||
    !binary.includes(Buffer.from("Moonz Fusion"))
  )
    throw new Error("Invalid Fusion ELF");
  const capacity =
    process.argv[3] === undefined ? binary.length : Number(process.argv[3]);
  if (
    !Number.isSafeInteger(capacity) ||
    capacity < binary.length ||
    capacity > 10 * 1024 * 1024
  )
    throw new Error("Invalid program capacity");
  const rpc = new Connection(
    process.env.FUSION_RPC_URL || "https://api.mainnet-beta.solana.com",
    "finalized",
  );
  const lengths = {
    program: 36,
    programData: 45 + capacity,
    temporaryBuffer: 37 + binary.length,
    config: 202,
  };
  const rent = Object.fromEntries(
    await Promise.all(
      Object.entries(lengths).map(async ([k, v]) => [
        k,
        await rpc.getMinimumBalanceForRentExemption(v),
      ]),
    ),
  );
  const persistent = rent.program + rent.programData + rent.config;
  console.log(
    JSON.stringify(
      {
        readOnly: true,
        transactionsSent: 0,
        binaryBytes: binary.length,
        programCapacityBytes: capacity,
        sha256: crypto.createHash("sha256").update(binary).digest("hex"),
        rentLamports: rent,
        persistentRentSol: persistent / 1e9,
        conservativeRentPeakSol: (persistent + rent.temporaryBuffer) / 1e9,
        excludes: [
          "deployment and verification transaction fees",
          "verification metadata account rent",
          "operator operating balance",
          "per-launch accounts funded by launch payer",
        ],
        note: "Rent only, not a transfer instruction. Re-run against the final Docker-built binary. Upgrade authority is retained at either capacity; a later larger build may require paid account extension.",
      },
      null,
      2,
    ),
  );
}
main().catch(() => {
  console.error(
    "Budget failed. Check the binary, capacity and RPC configuration.",
  );
  process.exitCode = 1;
});
