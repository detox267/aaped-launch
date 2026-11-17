#!/usr/bin/env node
"use strict";

// Run from /root/aaped-api. Reads public balances and the running API's RPC
// configuration; builds unsigned OG MOONZ transactions and ONLY simulates them.
// No signer imports, transaction submission, environment writes or restarts.
const { createHash } = require("node:crypto");
const MAINNET = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const MINT = "DfUWVvq1NDip9EQT9RreVDTQL3kArLJkwq7e9LXZEfkh";
const PROGRAM = "DBc9SEQghiJUj52YPqTKk8R4CMRgagBxi2LU1yBbeMpk";
const WALLET = "5zDozijrnBsdQ4CgDddJhBFDrmuoSya8C2EG15sZEFt6";
const METHODS = new Set(["getGenesisHash", "getBalance", "simulateTransaction"]);
const need = (condition, code) => { if (!condition) throw new Error(code); };

function provider(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    if (host === "alchemy.com" || host.endsWith(".alchemy.com")) return "Alchemy";
    if (host === "helius-rpc.com" || host.endsWith(".helius-rpc.com")) return "Helius";
    return "Other";
  } catch { return "Unconfigured"; }
}

function runtimeConfig({ cwd, fs, execFileSync, parse }) {
  const path = require("node:path");
  const processes = JSON.parse(execFileSync("pm2", ["jlist"], {
    encoding: "utf8", timeout: 15000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  }));
  const matches = processes.filter(p => p.name === "aaped-api");
  need(matches.length === 1, "api_process_not_unique");
  const p = matches[0], pm = p.pm2_env || {};
  need(pm.status === "online" && Number.isSafeInteger(p.pid) && p.pid > 0, "api_process_not_online");
  need(fs.realpathSync(pm.pm_cwd) === cwd && fs.realpathSync(pm.pm_exec_path) === path.join(cwd, "server.js"), "unexpected_api_process");
  const filePath = path.join(cwd, ".env");
  const saved = parse(fs.readFileSync(filePath));
  const initial = Object.fromEntries(fs.readFileSync(`/proc/${p.pid}/environ`, "utf8")
    .split("\0").filter(s => s.includes("=")).map(s => [s.slice(0, s.indexOf("=")), s.slice(s.indexOf("=") + 1)]));
  const env = { ...saved, ...initial };
  need(env.RPC_URL && new URL(env.RPC_URL).protocol === "https:", "https_rpc_missing");
  const inherited = typeof initial.RPC_URL === "string" && initial.RPC_URL.length > 0;
  // If dotenv was the source and the file changed after startup, the current
  // file alone cannot prove which URL that process loaded.
  const runtimeConfirmed = inherited || (Number.isFinite(pm.pm_uptime)
    && fs.statSync(filePath).mtimeMs <= pm.pm_uptime);
  return { rpcUrl: env.RPC_URL, report: {
    provider: provider(env.RPC_URL),
    source: inherited ? "running_process_environment" : "env_file",
    runningProcessRpcConfirmed: runtimeConfirmed,
    savedRpcMatches: saved.RPC_URL === env.RPC_URL,
    fusionRpcMatches: (env.LAUNCHLAB_RPC_URL || env.RPC_URL) === env.RPC_URL,
    apiOnline: true,
  } };
}

function errorCode(error) {
  if (typeof error === "string" && /^[A-Za-z][A-Za-z0-9_]{0,90}$/.test(error)) return error;
  const ix = error?.InstructionError;
  if (Array.isArray(ix) && Number.isSafeInteger(ix[0])) {
    const reason = ix[1];
    return { instruction: ix[0], error: Number.isSafeInteger(reason?.Custom)
      ? { custom: reason.Custom } : errorCode(reason) };
  }
  return "unclassified_error";
}

async function jsonRequest(fetchFn, url, body) {
  const response = await fetchFn(url, { method: "POST", redirect: "error",
    headers: { "content-type": "application/json", Origin: "https://moonz.fun" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  need(response.ok, `http_${response.status}`);
  return { body: await response.json(), cors: response.headers.get("access-control-allow-origin") };
}

function validateTransaction(built, side, wallet, web3) {
  need(built?.ok === true && built.mint === MINT && built.side === side && built.quoteAsset === "SOL", "unexpected_build_response");
  need(typeof built.tx === "string" && built.tx.length < 8192, "invalid_transaction");
  const tx = web3.Transaction.from(Buffer.from(built.tx, "base64"));
  need(tx.feePayer?.toBase58() === wallet, "fee_payer_mismatch");
  need(tx.signatures.length === 1 && tx.signatures.every(s => s.signature === null), "unexpected_signatures");
  const instructions = tx.instructions.filter(ix => ix.programId.toBase58() === PROGRAM);
  need(instructions.length === 1, "unexpected_moonz_instructions");
  const ix = instructions[0];
  const discriminator = createHash("sha256").update(`global:${side}`).digest().subarray(0, 8);
  need(ix.data.length === 24 && ix.data.subarray(0, 8).equals(discriminator), "wrong_trade_direction");
  need(ix.data.readBigUInt64LE(8) === 1000000n, "unexpected_trade_amount");
  const [launch] = web3.PublicKey.findProgramAddressSync([
    Buffer.from("launch_state"), new web3.PublicKey(MINT).toBuffer(),
  ], new web3.PublicKey(PROGRAM));
  need(ix.keys[0]?.pubkey.toBase58() === wallet && ix.keys[0]?.isSigner
    && ix.keys[1]?.pubkey.equals(launch), "trade_account_mismatch");
  return built.tx;
}

async function checkTrades({ rpcUrl, fetchFn = fetch, web3, wallet = WALLET }) {
  new web3.PublicKey(wallet);
  let id = 0;
  const rpc = async (method, params = []) => {
    need(METHODS.has(method), "rpc_method_not_read_only");
    const { body } = await jsonRequest(fetchFn, rpcUrl, { jsonrpc: "2.0", id: ++id, method, params });
    need(!body.error, `rpc_${Number.isSafeInteger(body.error?.code) ? body.error.code : "failed"}`);
    need(Object.hasOwn(body, "result"), "invalid_rpc_response");
    return body.result;
  };
  need(await rpc("getGenesisHash") === MAINNET, "rpc_not_mainnet");
  const balance = await rpc("getBalance", [wallet, { commitment: "confirmed" }]);
  need(Number.isSafeInteger(balance?.value) && Number.isSafeInteger(balance?.context?.slot), "invalid_balance_response");
  const report = { mainnetConfirmed: true, wallet, balanceLamports: balance.value,
    scope: "OG MOONZ SOL pair", buy: null, sell: null };
  for (const side of ["buy", "sell"]) {
    let stage = "unsigned_transaction_build";
    try {
      const body = side === "buy"
        ? { buyer: wallet, solAmount: "0.001", slippageBps: 100, minTokensOutBase: "1000000" }
        : { seller: wallet, tokenAmount: "1", slippageBps: 100, minWsolOutLamports: "0" };
      const built = await jsonRequest(fetchFn, `https://api.moonz.fun/launch/${MINT}/${side}-tx`, body);
      stage = "validate_unsigned_transaction";
      const wire = validateTransaction(built.body, side, wallet, web3);
      stage = "simulate_original_blockhash";
      const result = await rpc("simulateTransaction", [wire, { encoding: "base64", commitment: "confirmed",
        sigVerify: false, replaceRecentBlockhash: false, minContextSlot: balance.context.slot }]);
      const executed = Array.isArray(result?.value?.logs) && result.value.logs.includes(`Program ${PROGRAM} success`);
      const passed = result?.value?.err === null && executed
        && Number.isSafeInteger(result?.context?.slot) && result.context.slot >= balance.context.slot;
      report[side] = { status: passed ? "simulation_passed" : "simulation_failed",
        apiBuildPassed: true, browserCorsAllowed: ["https://moonz.fun", "*"].includes(built.cors),
        originalBlockhashUsed: true, slot: result?.context?.slot ?? null,
        programExecuted: executed, unitsConsumed: result?.value?.unitsConsumed ?? null,
        error: result?.value?.err === null ? null : errorCode(result?.value?.err),
      };
    } catch (err) { report[side] = { status: "check_failed", stage, error: errorCode(err.message) }; }
  }
  report.bothSimulationsPassed = [report.buy, report.sell].every(r => r.status === "simulation_passed" && r.browserCorsAllowed);
  return report;
}

async function main() {
  const fs = require("node:fs"), path = require("node:path");
  const cwd = fs.realpathSync(process.cwd());
  const localRequire = require("node:module").createRequire(path.join(cwd, "package.json"));
  const report = { readOnly: true, transactionsSent: 0, signaturesCreated: 0,
    settingsChanged: false, servicesRestarted: false, walletSubmissionTested: false,
    frontendRpcProviderConfirmed: false, fusionTradingTested: false };
  let stage = "running_api_configuration";
  try {
    const config = runtimeConfig({ cwd, fs, execFileSync: require("node:child_process").execFileSync,
      parse: localRequire("dotenv").parse });
    report.configuration = config.report;
    stage = "mainnet_and_trade_simulations";
    report.trades = await checkTrades({ rpcUrl: config.rpcUrl, web3: localRequire("@solana/web3.js"), wallet: process.argv[2] || WALLET });
    report.status = report.trades.bothSimulationsPassed && config.report.runningProcessRpcConfirmed
      ? "api_buy_sell_simulations_passed" : "trading_checks_need_review";
  } catch (err) { report.status = "trading_checks_need_review"; report.failedStage = stage; report.error = errorCode(err.message); }
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "api_buy_sell_simulations_passed") process.exitCode = 1;
}

module.exports = { checkTrades, validateTransaction, runtimeConfig, errorCode, provider, MAINNET, MINT, PROGRAM, WALLET };
if (require.main === module) main().catch(() => {
  console.error(JSON.stringify({ status: "diagnostic_failed", transactionsSent: 0, settingsChanged: false }));
  process.exitCode = 1;
});
