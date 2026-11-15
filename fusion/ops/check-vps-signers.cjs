#!/usr/bin/env node
"use strict";
// Read-only companion to the existing backend readiness report. No sends, env
// changes, key creation/import, database writes, PM2 actions or secrets in output.
const fs = require("node:fs"), path = require("node:path"), { createRequire } = require("node:module");
const ADMIN = "5zDozijrnBsdQ4CgDddJhBFDrmuoSya8C2EG15sZEFt6";
const OPERATOR = "CtnPVM3vrBZik3HxMZAvhjQpmSYz5HZUAqXvn6az9GQ";
const MAINNET = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const SAFE_CODES = new Set(["ENOENT", "EACCES", "EPERM", "ENOTDIR", "MODULE_NOT_FOUND", "ERR_REQUIRE_ESM",
  "ERR_INVALID_ARG_TYPE", "ERR_INVALID_ARG_VALUE", "ERR_INVALID_URL", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED",
  "ECONNRESET", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT"]);

function safeFailure(error) {
  const result = { category: "operation_failed" };
  // Only emit allowlisted codes/statuses. Raw messages, stack traces, URLs,
  // paths, response bodies and arbitrary error.name/code values may hold keys.
  for (let current = error, i = 0; current && i < 3; current = current.cause, i++) {
    if (SAFE_CODES.has(current.code)) result.code = current.code;
    if (["TimeoutError", "AbortError"].includes(current.name)) result.category = "timeout";
    const status = current.httpStatus || current.status || current.statusCode;
    if (Number.isInteger(status) && status >= 400 && status <= 599) result.httpStatus = status;
    if ([-32601, -32602, -32603, -32005].includes(current.code)) result.rpcCode = current.code;
    // web3.js represents some HTTP failures only in a prefixed message. Extract
    // the status number, never any of the response text following it.
    const prefix = typeof current.message === "string" && current.message.match(/^(401|403|429|5\d\d):/);
    if (prefix) result.httpStatus = Number(prefix[1]);
  }
  if ([401, 403].includes(result.httpStatus)) result.category = "rpc_access_denied";
  else if (result.httpStatus === 429) result.category = "rpc_rate_limited";
  else if (result.rpcCode === -32601) result.category = "rpc_method_unavailable";
  return result;
}
function loadDependencies(apiDir) {
  const fromApi = createRequire(path.join(apiDir, "package.json"));
  const { Keypair, Connection } = fromApi("@solana/web3.js");
  const { parse } = fromApi("dotenv"), { readConfig } = fromApi("./launchlab/config");
  const { publicKeyFile } = fromApi("./launchlab/ops/check-readiness.cjs");
  return { Keypair, Connection, parse, readConfig, publicKeyFile };
}
async function diagnose({ apiDir = "/root/aaped-api", load = loadDependencies,
  readEnv = filename => fs.readFileSync(filename, "utf8") } = {}) {
  const report = { diagnosticVersion: 2, configurationSource: "env_file", readOnly: true, transactionsSent: 0, settingsChanged: false,
    checks: {}, summary: { localSignersMatch: false, configuredRpcIsMainnet: false, checksPassed: false } };
  async function step(name, fn) {
    try { const value = await fn(); report.checks[name] = { status: "passed" }; return { value }; }
    catch (error) { report.checks[name] = { status: "failed", ...safeFailure(error) }; return null; }
  }
  const loaded = await step("load_backend_modules", () => load(path.resolve(apiDir)));
  if (!loaded) return report;
  const { Keypair, Connection, parse, readConfig, publicKeyFile } = loaded.value;
  const file = await step("read_env_file", () => readEnv(path.join(path.resolve(apiDir), ".env")));
  if (!file) return report;
  const configured = await step("parse_configuration", () => readConfig(parse(file.value)));
  if (!configured) return report;
  const cfg = configured.value;
  const identity = await step("configuration_identities", () => ({ admin: cfg.admin?.toBase58() || null,
    operator: cfg.rewards?.wallet?.toBase58() || null, mainnetSelected: cfg.cluster === "mainnet-beta" }));
  if (!identity) return report;
  const { admin, operator, mainnetSelected } = identity.value;
  const identityMatches = admin === ADMIN && operator === OPERATOR && mainnetSelected;
  report.checks.configuration_identities = { status: identityMatches ? "passed" : "failed",
    adminMatches: admin === ADMIN, operatorMatches: operator === OPERATOR, mainnetSelected };
  report.configuration = { rpcConfigured: typeof cfg.rpcUrl === "string" && !!cfg.rpcUrl.trim(),
    adminKeyPathConfigured: typeof cfg.pairSetup?.keyFile === "string" && !!cfg.pairSetup.keyFile,
    priceKeyConfigured: !!cfg.prices?.apiKey, launchEnabled: cfg.requestedEnabled === true,
    rewardsEnabled: cfg.rewards?.enabled === true, rewardsLive: cfg.rewards?.live === true };
  // Read LOCAL key identity first. A provider outage must not hide these results.
  for (const [role, expected, filename] of [["admin", ADMIN, cfg.pairSetup?.keyFile],
    ["operator", OPERATOR, "/root/.config/moonz/reward-collector.json"]]) {
    if (typeof filename !== "string" || !filename) {
      report.checks[`${role}_signer`] = { status: "failed", category: "key_path_not_configured" }; continue;
    }
    const checked = await step(`${role}_signer`, () => publicKeyFile(filename, expected, Keypair));
    if (!checked) continue;
    const flags = { present: checked.value?.present === true, ownerOnly: checked.value?.ownerOnly === true, matches: checked.value?.matches === true };
    report.checks[`${role}_signer`] = { status: Object.values(flags).every(Boolean) ? "passed" : "failed", ...flags };
  }
  report.summary.localSignersMatch = ["admin_signer", "operator_signer"].every(k => report.checks[k].status === "passed");
  if (!identityMatches) return report;
  const created = await step("create_rpc_client", () => {
    if (!report.configuration.rpcConfigured) throw Object.assign(new Error(), { code: "ERR_INVALID_URL" });
    return new Connection(cfg.rpcUrl, { commitment: "finalized", disableRetryOnRateLimit: true,
      fetch: async (url, init) => {
        const response = await fetch(url, { ...init, signal: AbortSignal.timeout(12000) });
        if (!response.ok) throw Object.assign(new Error(), { httpStatus: response.status });
        return response;
      } });
  });
  if (!created) return report;
  const rpc = created.value;
  const genesis = await step("rpc_genesis", () => rpc.getGenesisHash());
  if (!genesis || genesis.value !== MAINNET) {
    if (genesis) report.checks.rpc_genesis = { status: "failed", category: "network_mismatch" };
    for (const role of ["admin", "operator"]) report.checks[`${role}_balance`] = { status: "skipped", reason: "configured_mainnet_not_confirmed" };
    return report;
  }
  report.summary.configuredRpcIsMainnet = true;
  await Promise.all([["admin", cfg.admin, ADMIN], ["operator", cfg.rewards.wallet, OPERATOR]].map(async ([role, key, address]) => {
    const balance = await step(`${role}_balance`, async () => {
      const value = await rpc.getBalance(key, "finalized");
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(); return value;
    });
    if (balance) report.checks[`${role}_balance`] = { status: "passed", address, lamports: balance.value };
  }));
  report.summary.checksPassed = Object.values(report.checks).every(check => check.status === "passed");
  return report;
}
async function main() {
  const report = await diagnose({ apiDir: process.argv[2] || "/root/aaped-api" });
  console.log(JSON.stringify(report, null, 2));
  if (!report.summary.checksPassed) process.exitCode = 1;
}
if (require.main === module) main().catch(() => {
  console.log(JSON.stringify({ diagnosticVersion: 2, readOnly: true, transactionsSent: 0,
    checks: { diagnostic_internal: { status: "failed", category: "unexpected_diagnostic_failure" } } }, null, 2));
  process.exitCode = 1;
});
module.exports = { diagnose, safeFailure, ADMIN, OPERATOR, MAINNET };
