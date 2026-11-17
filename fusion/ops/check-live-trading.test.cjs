"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRequire } = require("node:module");
const { createHash } = require("node:crypto");
const deps = createRequire(path.resolve(process.env.MOONZ_API_ROOT || process.cwd(), "package.json"));
const web3 = deps("@solana/web3.js");
const { checkTrades, validateTransaction, runtimeConfig, errorCode, MAINNET, MINT, PROGRAM, WALLET } = require("./check-live-trading.cjs");
const rpcUrl = "https://solana-mainnet.g.alchemy.com/v2/test-secret";

function built(side) {
  const payer = new web3.PublicKey(WALLET);
  const [launch] = web3.PublicKey.findProgramAddressSync([Buffer.from("launch_state"), new web3.PublicKey(MINT).toBuffer()], new web3.PublicKey(PROGRAM));
  const args = Buffer.alloc(16); args.writeBigUInt64LE(1000000n); args.writeBigUInt64LE(1n, 8);
  const tx = new web3.Transaction({ feePayer: payer, recentBlockhash: web3.SystemProgram.programId.toBase58() });
  tx.add(new web3.TransactionInstruction({ programId: new web3.PublicKey(PROGRAM),
    keys: [{ pubkey: payer, isSigner: true, isWritable: true }, { pubkey: launch, isSigner: false, isWritable: true }],
    data: Buffer.concat([createHash("sha256").update(`global:${side}`).digest().subarray(0,8), args]),
  }));
  return { ok: true, mint: MINT, side, quoteAsset: "SOL", tx: tx.serialize({ requireAllSignatures: false }).toString("base64") };
}
const response = body => ({ ok: true, status: 200, headers: { get: () => "https://moonz.fun" }, json: async () => body });
function mockRequests(transform = x => x) {
  const calls = [];
  const fetchFn = async (url, options) => {
    const request = JSON.parse(options.body); calls.push({ url, options, request });
    if (url.includes("/buy-tx")) return response(built("buy"));
    if (url.includes("/sell-tx")) return response(built("sell"));
    if (request.method === "getGenesisHash") return response({ result: MAINNET });
    if (request.method === "getBalance") return response({ result: { context: { slot: 123 }, value: 250000000 } });
    assert.equal(request.method, "simulateTransaction");
    return response({ result: transform({ context: { slot: 124 }, value: { err: null,
      logs: [`Program ${PROGRAM} success`], unitsConsumed: 42000 } }) });
  };
  return { fetchFn, calls };
}

test("both unsigned trade directions use the configured RPC without sending a transaction", async () => {
  const fake = mockRequests();
  const report = await checkTrades({ rpcUrl, web3, fetchFn: fake.fetchFn });
  assert.equal(report.bothSimulationsPassed, true);
  assert.equal(fake.calls.length, 6);
  for (const call of fake.calls.filter(c => c.request.method)) {
    assert.equal(call.url, rpcUrl);
    assert.ok(["getGenesisHash", "getBalance", "simulateTransaction"].includes(call.request.method));
    assert.equal(call.options.redirect, "error");
  }
  for (const call of fake.calls.filter(c => c.request.method === "simulateTransaction")) {
    assert.equal(call.request.params[1].sigVerify, false);
    assert.equal(call.request.params[1].replaceRecentBlockhash, false);
    assert.equal(call.request.params[1].minContextSlot, 123);
  }
  assert.equal(JSON.stringify(report).includes("test-secret"), false);
});
test("wrong direction, payer and mint are rejected before simulation", () => {
  assert.throws(() => validateTransaction(built("sell"), "buy", WALLET, web3));
  assert.throws(() => validateTransaction(built("buy"), "buy", PROGRAM, web3));
  assert.throws(() => validateTransaction({ ...built("buy"), mint: PROGRAM }, "buy", WALLET, web3));
});
test("a simulation failure or missing program execution cannot be reported as passing", async () => {
  for (const alter of [r => ({ ...r, value: { ...r.value, err: { InstructionError: [3, { Custom: 1 }] } } }),
    r => ({ ...r, value: { ...r.value, logs: [] } }), r => ({ ...r, context: { slot: 122 } })]) {
    const fake = mockRequests(alter);
    assert.equal((await checkTrades({ rpcUrl, web3, fetchFn: fake.fetchFn })).bothSimulationsPassed, false);
  }
});
test("provider exceptions and error payloads cannot expose credentials", async () => {
  const fake = mockRequests();
  const fetchFn = (url, options) => url.includes("sell-tx") ? Promise.reject(new Error(rpcUrl)) : fake.fetchFn(url, options);
  const report = await checkTrades({ rpcUrl, web3, fetchFn });
  assert.equal(report.buy.status, "simulation_passed");
  assert.equal(report.sell.status, "check_failed");
  assert.equal(JSON.stringify(report).includes("test-secret"), false);
  assert.equal(errorCode({ InstructionError: [1, rpcUrl] }).error, "unclassified_error");
});
test("a wrong network prevents both API builds", async () => {
  let calls = 0;
  await assert.rejects(checkTrades({ rpcUrl, web3, fetchFn: async () => { calls++; return response({ result: "devnet" }); } }), /rpc_not_mainnet/);
  assert.equal(calls, 1);
});
function configFixture(inherited, modified) {
  return runtimeConfig({ cwd: "/root/aaped-api",
    execFileSync: () => JSON.stringify([{ name: "aaped-api", pid: 12, pm2_env: { status: "online", pm_cwd: "/root/aaped-api",
      pm_exec_path: "/root/aaped-api/server.js", pm_uptime: 1000 } }]),
    parse: () => ({ RPC_URL: rpcUrl, LAUNCHLAB_RPC_URL: rpcUrl }),
    fs: { realpathSync: x => x, statSync: () => ({ mtimeMs: modified }),
      readFileSync: p => p.startsWith("/proc/") ? inherited : "private-file-content" },
  });
}
test("running process overrides are selected and mismatches reported without printing URLs", () => {
  const config = configFixture("RPC_URL=https://mainnet.helius-rpc.com/?api-key=test-secret\0", 2000);
  assert.equal(config.report.provider, "Helius");
  assert.equal(config.report.runningProcessRpcConfirmed, true);
  assert.equal(config.report.savedRpcMatches, false);
  assert.equal(config.report.fusionRpcMatches, false);
  assert.equal(JSON.stringify(config.report).includes("test-secret"), false);
});
test("an env file changed after process startup is not proof of the running RPC", () => {
  assert.equal(configFixture("", 2000).report.runningProcessRpcConfirmed, false);
  assert.equal(configFixture("", 500).report.runningProcessRpcConfirmed, true);
});
