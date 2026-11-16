"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { diagnose, safeFailure, ADMIN, OPERATOR, MAINNET } = require("../ops/check-vps-signers.cjs");
const key = value => ({ toBase58: () => value });
function fixture() {
  let sends = 0, localReads = 0;
  const cfg = { admin: key(ADMIN), cluster: "mainnet-beta", rpcUrl: "https://rpc.invalid/?api-key=PRIVATE_RPC",
    rewards: { wallet: key(OPERATOR), enabled: false, live: false }, requestedEnabled: false,
    prices: { apiKey: "PRIVATE_PRICE" }, pairSetup: { keyFile: "/private/PRIVATE_PATH.json" } };
  const rpc = { getGenesisHash: async () => MAINNET, getBalance: async k => k.toBase58() === ADMIN ? 1997881218 : 0,
    sendRawTransaction: async () => { sends++; throw new Error("Must never send"); } };
  const deps = { Keypair: {}, Connection: function () { return rpc; }, parse: () => ({}), readConfig: () => cfg,
    publicKeyFile: () => { localReads++; return { present: true, ownerOnly: true, matches: true, unused: "PRIVATE_KEY" }; } };
  const run = options => diagnose({ load: () => deps, readEnv: () => "PRIVATE_ENV", ...options });
  return { cfg, rpc, deps, run, get sends() { return sends; }, get localReads() { return localReads; } };
}
function noSecrets(report) { assert(!/PRIVATE|rpc\.invalid|\/private\//.test(JSON.stringify(report))); }

test("diagnostic reports signer matches and public balances without secret fields or sends", async () => {
  const f = fixture(), report = await f.run();
  assert.equal(report.diagnosticVersion, 2); assert.equal(report.summary.checksPassed, true);
  assert.equal(report.checks.admin_balance.lamports, 1997881218); assert.equal(report.checks.operator_balance.lamports, 0);
  assert.equal(f.localReads, 2); assert.equal(f.sends, 0); noSecrets(report);
});
test("RPC outage preserves local signer results and identifies the failed RPC step", async () => {
  const f = fixture(); f.rpc.getGenesisHash = async () => { throw Object.assign(new Error("PRIVATE_RPC"), { httpStatus: 403 }); };
  const report = await f.run();
  assert.equal(report.summary.localSignersMatch, true); assert.equal(report.summary.checksPassed, false);
  assert.deepEqual(report.checks.rpc_genesis, { status: "failed", category: "rpc_access_denied", httpStatus: 403 });
  assert.equal(report.checks.admin_balance.status, "skipped"); noSecrets(report);
});
test("individual balance failure does not suppress the other wallet or local signer results", async () => {
  const f = fixture(); f.rpc.getBalance = async k => { if (k.toBase58() === ADMIN) throw Object.assign(new Error("429: PRIVATE"), { status: 429 }); return 0; };
  const report = await f.run();
  assert.equal(report.checks.admin_balance.category, "rpc_rate_limited");
  assert.equal(report.checks.operator_balance.lamports, 0); assert.equal(report.summary.localSignersMatch, true); noSecrets(report);
});
test("missing admin path or wrong signer is explicit, without reporting a balance check as deployment readiness", async () => {
  const f = fixture(); f.cfg.pairSetup.keyFile = "";
  let report = await f.run(); assert.equal(report.checks.admin_signer.category, "key_path_not_configured");
  assert.equal(report.summary.checksPassed, false); assert.equal(report.checks.admin_balance.status, "passed");
  f.cfg.pairSetup.keyFile = "/private/PRIVATE_PATH.json";
  f.deps.publicKeyFile = () => ({ present: true, ownerOnly: true, matches: false });
  report = await f.run(); assert.equal(report.checks.admin_signer.matches, false); noSecrets(report);
});
test("configuration or network mismatch cannot silently fall back to another RPC", async () => {
  const f = fixture(); let networkCalls = 0;
  f.rpc.getGenesisHash = async () => { networkCalls++; return "another-network"; };
  f.cfg.admin = key(OPERATOR);
  let report = await f.run(); assert.equal(report.checks.configuration_identities.adminMatches, false); assert.equal(networkCalls, 0);
  f.cfg.admin = key(ADMIN); report = await f.run();
  assert.equal(report.checks.rpc_genesis.category, "network_mismatch"); assert.equal(report.checks.operator_balance.status, "skipped");
});
test("module, file and config failures are stage-labelled and scrubbed", async () => {
  const f = fixture();
  const cases = [
    ["load_backend_modules", { load: () => { throw Object.assign(new Error("PRIVATE_PATH"), { code: "MODULE_NOT_FOUND" }); } }],
    ["read_env_file", { readEnv: () => { throw Object.assign(new Error("PRIVATE_ENV"), { code: "EACCES" }); } }],
  ];
  for (const [name, overrides] of cases) { const report = await f.run(overrides); assert.equal(report.checks[name].status, "failed"); noSecrets(report); }
  f.deps.readConfig = () => { throw new Error("PRIVATE_CONFIG_VALUE"); };
  const report = await f.run(); assert.equal(report.checks.parse_configuration.status, "failed"); noSecrets(report);
  assert.deepEqual(safeFailure({ code: "PRIVATE_CODE", name: "PRIVATE_NAME", stack: "PRIVATE_STACK", message: "PRIVATE_MESSAGE" }), { category: "operation_failed" });
  assert.equal(safeFailure({ cause: { code: "ETIMEDOUT", name: "TimeoutError" } }).category, "timeout");
});
