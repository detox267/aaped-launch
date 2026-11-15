#!/usr/bin/env node
"use strict";
const fs = require("node:fs"), path = require("node:path");
const { Collector, CollectorStore } = require("./collector.cjs");
const { RpcAdapter } = require("./rpc-adapter.cjs");
const { need, pk, raw, privateFile, loadSigner } = require("./common.cjs");

function configFile(filename) {
  const cfg = JSON.parse(privateFile(filename));
  need(cfg.version === 1 && typeof cfg.live === "boolean", "Invalid worker config version/live flag");
  for (const key of ["programId", "upgradeAuthority", "admin", "operator", "feeWallet", "platform", "cpConfig"]) cfg[key] = pk(cfg[key]).toBase58();
  need(cfg.programId !== "DBc9SEQghiJUj52YPqTKk8R4CMRgagBxi2LU1yBbeMpk", "Refusing OG program");
  need(/^[a-f0-9]{40}$/.test(cfg.releaseCommit), "Full reviewed release commit required");
  const rpc = new URL(cfg.rpcUrl); need(rpc.protocol === "https:", "An HTTPS mainnet RPC is required");
  for (const key of ["binaryPath", "keyFile", "journalFile"]) need(typeof cfg[key] === "string" && path.isAbsolute(cfg[key]), `Absolute ${key} required`);
  need(raw(cfg.maxSwapRaw) > 0n && raw(cfg.minSolLamports) >= 1_000_000n, "Invalid swap cap or operator reserve");
  for (const [key, min, max] of [["slippageBps", 1, 500], ["priorityMicroLamports", 0, 100000], ["maxFeeLamports", 5000, 200000]])
    need(Number.isSafeInteger(cfg[key]) && cfg[key] >= min && cfg[key] <= max, `Invalid ${key}`);
  need(Array.isArray(cfg.canaryMints) && cfg.canaryMints.length <= 10, "Use an explicit list of at most ten canary mints");
  cfg.canaryMints = [...new Set(cfg.canaryMints.map(m => pk(m).toBase58()))];
  need(typeof cfg.priceApiKey === "string" && cfg.priceApiKey.trim(), "Dedicated price API key missing");
  return cfg;
}
function lockHeld(filename) {
  // run.sh holds descriptor 9 through exec; it is released by the OS on exit.
  const opened = fs.fstatSync(9), actual = fs.lstatSync(filename);
  need(actual.isFile() && !(actual.mode & 0o077) && actual.uid === process.getuid()
    && opened.dev === actual.dev && opened.ino === actual.ino, "Launch this worker through worker/run.sh");
}
async function main() {
  const [file, mode = "--check"] = process.argv.slice(2);
  need(file && ["--check", "--run"].includes(mode), "Usage: node worker/run.cjs /absolute/private-config.json --check");
  const cfg = configFile(path.resolve(file)), running = mode === "--run";
  if (running) {
    need(cfg.live && cfg.canaryMints.length, "Canary is disabled or has no allowed mint");
    lockHeld(cfg.journalFile + ".lock");
  }
  // Read-only check never opens a signer or creates a journal.
  const signer = running ? loadSigner(cfg.keyFile, cfg.operator) : null;
  const adapter = new RpcAdapter({ ...cfg, live: running && cfg.live }, { signer });
  await adapter.ready();
  const discovered = await adapter.discover();
  need(cfg.canaryMints.every(mint => discovered.includes(mint)), "A canary mint is not a deployed Fusion launch");
  for (const mint of cfg.canaryMints) await adapter.inspect(mint);
  if (!running) {
    console.log(JSON.stringify({ readOnly: true, transactionsSent: 0, programId: cfg.programId, sourceVerified: true,
      upgradeAuthority: cfg.upgradeAuthority, operator: cfg.operator, discoveredLaunches: discovered.length,
      canaryMints: cfg.canaryMints, fullPlatformActivationReady: false,
      note: "Collection/sales only. Website launch and holder/platform payout integration still require release review." }, null, 2));
    return;
  }
  process.umask(0o077);
  const directory = fs.lstatSync(path.dirname(cfg.journalFile));
  need(directory.isDirectory() && !(directory.mode & 0o077) && directory.uid === process.getuid(), "Use an owner-only journal directory");
  if (fs.existsSync(cfg.journalFile)) privateFileSizeCheck(cfg.journalFile);
  const store = new CollectorStore(cfg.journalFile, cfg.programId);
  const worker = new Collector({ store, adapter, maxSwapRaw: cfg.maxSwapRaw, enabled: true });
  cfg.canaryMints.forEach(mint => worker.register(mint));
  // Do not strand earlier pending operations by silently removing their mint.
  need(store.all().every(state => cfg.canaryMints.includes(state.mint) || !state.pending), "An excluded CA still has a pending transaction");
  store.db.exec("CREATE TABLE IF NOT EXISTS collector_health(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)");
  let stopping = false;
  const stop = () => { stopping = true; worker.enabled = false; adapter.stopping = true; };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try {
    while (!stopping) {
      for (let i = 0; i < cfg.canaryMints.length && !stopping; i += 4)
        await Promise.all(cfg.canaryMints.slice(i, i + 4).map(mint => worker.tick(mint)));
      store.db.prepare("INSERT INTO collector_health VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
        .run(JSON.stringify({ at: Date.now(), programId: cfg.programId, active: true,
          review: store.all().filter(s => s.phase === "review").map(s => s.mint) }));
      if (!stopping) await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } finally {
    store.close(); signer.secretKey.fill(0);
  }
}
function privateFileSizeCheck(filename) {
  const stat = fs.lstatSync(filename);
  need(stat.isFile() && !(stat.mode & 0o077) && stat.uid === process.getuid(), "Journal ownership/permissions invalid");
}
if (require.main === module) main().catch(() => {
  // Config/key parse and network errors can contain private data. Log no payload.
  console.error("Fusion collector could not start. Check the private config, verification, pause state, identities, reserve and canary bindings locally. Nothing was automatically enabled.");
  process.exitCode = 1;
});
module.exports = { configFile, lockHeld };
