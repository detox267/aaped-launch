#!/usr/bin/env node
"use strict";
// Deliberately pins the already-tested program release, independently of this
// operational helper's commit. No initialization, activation or wallet transfers.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { createRequire } = require("node:module");
const { spawn, execFileSync } = require("node:child_process");
const PINS = Object.freeze({
  commit: "58ee233a0f5505f7cc62a976dea282c67c553eca",
  sha256: "622fe99af353faaf5c0ac06347b433bcc32f0d8dac20f01c246b546c544840a6",
  bytes: 243600,
  program: "CVzSF4nNHwu12giZUo9WZYGBw5VAbmgFN11ywVXizfmo",
  buffer: "7spbodSrFFD9a67Sf5ej4UTkTcfhQzschwVfTxCR7wZF",
  admin: "5zDozijrnBsdQ4CgDddJhBFDrmuoSya8C2EG15sZEFt6",
  operator: "CtnPVM3vrBZik3HxMZAvhjQpmSYz5HZUAqXvn6az9GQ",
  genesis: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  loader: "BPFLoaderUpgradeab1e11111111111111111111111",
  reserveLamports: 500000000,
  microLamportsPerCu: 10000,
  maxSignAttempts: 5,
});
const OWN_ERROR = Symbol("publicError");
function need(ok, code) {
  if (!ok) { const e = new Error(code); e[OWN_ERROR] = code; throw e; }
}
function safeError(e) {
  const code = e?.[OWN_ERROR];
  if (code) return code;
  return ["ENOENT", "EACCES", "EPERM", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND"].includes(e?.code)
    ? e.code : "operation_failed";
}
function privatePath(filename, directory = false) {
  const s = fs.lstatSync(filename);
  need((directory ? s.isDirectory() : s.isFile()) && s.uid === process.getuid()
    && (s.mode & 0o077) === 0, "unsafe_file_permissions_or_owner");
}
function readSigner(filename, expected, Keypair) {
  need(typeof filename === "string" && path.isAbsolute(filename), "signer_path_missing");
  privatePath(filename);
  const bytes = JSON.parse(fs.readFileSync(filename, "utf8"));
  need(Array.isArray(bytes) && bytes.length === 64 && bytes.every(n => Number.isInteger(n) && n >= 0 && n <= 255), "invalid_signer_file");
  const key = Keypair.fromSecretKey(Uint8Array.from(bytes));
  need(key.publicKey.toBase58() === expected, "signer_identity_mismatch");
  return key.publicKey;
}
function checkBinary(bytes) {
  need(bytes.length === PINS.bytes && crypto.createHash("sha256").update(bytes).digest("hex") === PINS.sha256,
    "release_binary_mismatch");
  need(bytes.includes(Buffer.from("=======BEGIN SECURITY.TXT V1=======\0"))
    && bytes.includes(Buffer.from("name\0Moonz Fusion\0")), "embedded_security_text_missing");
}
function derive(PublicKey) {
  const program = new PublicKey(PINS.program), loader = new PublicKey(PINS.loader);
  return { program, loader,
    programData: PublicKey.findProgramAddressSync([program.toBuffer()], loader)[0],
    config: PublicKey.findProgramAddressSync([Buffer.from("config")], program)[0] };
}
function checkDeployed({ program, programData, binary, PublicKey }) {
  const a = derive(PublicKey);
  need(program?.executable && program.owner.equals(a.loader) && program.data.length === 36
    && program.data.readUInt32LE(0) === 2 && new PublicKey(program.data.subarray(4)).equals(a.programData),
  "unexpected_program_account");
  need(programData?.owner.equals(a.loader) && programData.data.length >= 45 + binary.length
    && programData.data.readUInt32LE(0) === 3, "unexpected_program_data");
  need(programData.data[12] === 1 && new PublicKey(programData.data.subarray(13, 45)).toBase58() === PINS.admin,
    "upgrade_authority_mismatch");
  need(programData.data.subarray(45, 45 + binary.length).equals(binary)
    && programData.data.subarray(45 + binary.length).every(n => n === 0), "deployed_binary_mismatch");
  return { programId: PINS.program, programData: a.programData.toBase58(),
    upgradeAuthority: PINS.admin, upgradeable: true,
    deploymentSlot: programData.data.readBigUInt64LE(4).toString(),
    binarySha256: PINS.sha256, releaseCommit: PINS.commit };
}
function budget(rents, balance) {
  need(rents.length === 4 && [...rents, balance].every(n => Number.isSafeInteger(n) && n >= 0), "invalid_rpc_amount");
  const persistent = rents[0] + rents[1] + rents[3];
  const peak = persistent + rents[2], required = peak + PINS.reserveLamports;
  need(Number.isSafeInteger(required), "invalid_rpc_amount");
  need(balance >= required, "insufficient_deployer_balance");
  return { adminBalanceSol: balance / 1e9, persistentRentIncludingConfigSol: persistent / 1e9,
    conservativeTemporaryRentPeakSol: peak / 1e9, extraReserveSol: PINS.reserveLamports / 1e9,
    minimumBalanceForThisPlanSol: required / 1e9 };
}
function deploymentArgs({ binaryPath, rpcUrl, adminFile, programFile, bufferFile }) {
  return ["program", "deploy", binaryPath, "--url", rpcUrl,
    "--keypair", adminFile, "--fee-payer", adminFile, "--upgrade-authority", adminFile,
    "--program-id", programFile, "--buffer", bufferFile, "--max-len", String(PINS.bytes),
    "--with-compute-unit-price", String(PINS.microLamportsPerCu),
    "--max-sign-attempts", String(PINS.maxSignAttempts), "--use-rpc",
    "--commitment", "confirmed", "--output", "json-compact"];
}
function writeNew(filename, text) {
  const fd = fs.openSync(filename, "wx", 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const parent = fs.openSync(path.dirname(filename), "r");
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}
async function runCli(args, fd, command = "solana") {
  return new Promise(resolve => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", fd, fd] });
    const timer = setInterval(() => console.log("Deployment upload is still running; recovery keys are saved."), 30000);
    child.once("error", () => { clearInterval(timer); resolve({ exitCode: null, spawnFailed: true }); });
    child.once("close", (code, signal) => { clearInterval(timer); resolve({ exitCode: code, signal }); });
  });
}
let stage = "arguments";
async function main(argv = process.argv.slice(2)) {
  const live = argv[0] === "--deploy";
  const buildDir = live ? argv[1] : argv[0];
  need(argv.length === (live ? 2 : 1) && typeof buildDir === "string" && path.isAbsolute(buildDir), "usage_node_helper_optional_deploy_absolute_fusion_directory");
  need(process.getuid() === 0, "run_on_vps_as_root");
  const apiDir = "/root/aaped-api", privateDir = "/root/.config/moonz-fusion";
  const programFile = path.join(privateDir, "program-id.json"), bufferFile = path.join(privateDir, "deployment-buffer.json");
  const attemptFile = path.join(privateDir, "deployment-attempt.json");
  stage = "release_binary";
  const binaryPath = path.join(fs.realpathSync(buildDir), "target/deploy/moonz_fusion.so");
  const binary = fs.readFileSync(binaryPath);
  checkBinary(binary);
  const head = execFileSync("git", ["-C", buildDir, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  need(head === PINS.commit, "release_checkout_mismatch");
  stage = "backend_configuration";
  const fromApi = createRequire(path.join(apiDir, "package.json"));
  const { Connection, Keypair, PublicKey } = fromApi("@solana/web3.js");
  const { parse } = fromApi("dotenv");
  const cfg = fromApi("./launchlab/config").readConfig(parse(fs.readFileSync(path.join(apiDir, ".env"), "utf8")));
  need(cfg.cluster === "mainnet-beta" && cfg.admin?.toBase58() === PINS.admin
    && cfg.rewards?.wallet?.toBase58() === PINS.operator, "configuration_identity_mismatch");
  need(!cfg.requestedEnabled && !cfg.rewards.enabled && !cfg.rewards.live, "backend_live_flags_must_remain_disabled");
  stage = "local_signers";
  privatePath(privateDir, true);
  need(typeof cfg.pairSetup?.keyFile === "string" && cfg.pairSetup.keyFile.length > 0, "signer_path_missing");
  const adminFile = path.resolve(apiDir, cfg.pairSetup.keyFile);
  const admin = readSigner(adminFile, PINS.admin, Keypair);
  const program = readSigner(programFile, PINS.program, Keypair);
  const buffer = readSigner(bufferFile, PINS.buffer, Keypair);
  readSigner("/root/.config/moonz/reward-collector.json", PINS.operator, Keypair);
  stage = "mainnet_preflight";
  const rpc = new Connection(cfg.rpcUrl, { commitment: "finalized", disableRetryOnRateLimit: true,
    fetch: async (url, init) => {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
      need(response.ok, "rpc_http_failure"); return response;
    } });
  need(await rpc.getGenesisHash() === PINS.genesis, "rpc_network_mismatch");
  const a = derive(PublicKey);
  const before = await rpc.getMultipleAccountsInfoAndContext([program, a.programData, a.config, buffer, admin], "finalized");
  const [oldProgram, oldData, oldConfig, oldBuffer, adminAccount] = before.value;
  if (oldProgram) {
    const result = checkDeployed({ program: oldProgram, programData: oldData, binary, PublicKey });
    console.log(JSON.stringify({ readOnly: true, transactionsSent: 0, status: "already_deployed_matches_release", ...result,
      configPresent: !!oldConfig, publicSourceVerificationConfirmed: false, activationAllowed: false }, null, 2));
    return;
  }
  need(!oldData && !oldConfig && !oldBuffer, "existing_accounts_require_deployment_recovery_review");
  need(!fs.existsSync(attemptFile), "previous_attempt_requires_reconciliation");
  need(adminAccount && !adminAccount.executable && adminAccount.owner.equals(new PublicKey("11111111111111111111111111111111"))
    && adminAccount.data.length === 0, "unexpected_deployer_account");
  const rents = await Promise.all([36, 45 + PINS.bytes, 37 + PINS.bytes, 202].map(n => rpc.getMinimumBalanceForRentExemption(n)));
  const plan = { programId: PINS.program, deploymentBuffer: PINS.buffer, upgradeAuthority: PINS.admin,
    releaseCommit: PINS.commit, binarySha256: PINS.sha256, capacityBytes: PINS.bytes,
    ...budget(rents, adminAccount.lamports), microLamportsPerCu: PINS.microLamportsPerCu, maxSignAttempts: PINS.maxSignAttempts,
    configWillBeInitialized: false, activationAllowed: false };
  stage = "cli_flags";
  const help = execFileSync("solana", ["program", "deploy", "--help"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const args = deploymentArgs({ binaryPath, rpcUrl: cfg.rpcUrl, adminFile, programFile, bufferFile });
  for (const arg of args.filter(s => s.startsWith("--"))) need(help.includes(arg), "required_cli_option_unavailable");
  console.log(JSON.stringify({ readOnly: !live, transactionsSent: 0, status: "preflight_passed", ...plan }, null, 2));
  if (!live) return;
  stage = "record_deployment_attempt";
  checkBinary(fs.readFileSync(binaryPath));
  // O_EXCL + fsync prevents a second invocation from starting another attempt,
  // even after SSH loss. An uncertain attempt must be reconciled, not re-signed.
  writeNew(attemptFile, JSON.stringify({ ...plan, startedAt: new Date().toISOString() }, null, 2));
  const logFile = path.join(privateDir, `deployment-${Date.now()}.log`);
  const fd = fs.openSync(logFile, "wx", 0o600);
  let cli;
  try {
    stage = "deployment_upload";
    console.log("Starting mainnet program deployment. Launches and rewards remain disabled.");
    cli = await runCli(args, fd);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  stage = "finalized_binary_and_authority_check";
  for (let attempt = 0; attempt < 7; attempt++) {
    const result = await rpc.getMultipleAccountsInfoAndContext([program, a.programData, a.config, buffer, admin], "finalized");
    if (result.value[0]) {
      const verified = checkDeployed({ program: result.value[0], programData: result.value[1], binary, PublicKey });
      need(!result.value[2], "unexpected_config_initialized");
      const receipt = { status: "deployed_binary_and_authority_confirmed", ...verified,
        finalizedSlot: result.context.slot, configInitialized: false,
        bufferClosed: result.value[3] === null, adminBalanceSol: (result.value[4]?.lamports || 0) / 1e9,
        publicSourceVerificationConfirmed: false, activationAllowed: false };
      writeNew(path.join(privateDir, "deployment-receipt.json"), JSON.stringify(receipt, null, 2));
      console.log(JSON.stringify(receipt, null, 2));
      return;
    }
    if (attempt < 6) await new Promise(resolve => setTimeout(resolve, 5000));
  }
  console.log(JSON.stringify({ status: "deployment_needs_reconciliation", transactionsMayHaveBeenSent: true,
    programId: PINS.program, deploymentBuffer: PINS.buffer, cliExitCode: cli.exitCode,
    privateLog: logFile, activationAllowed: false,
    note: "Keep the original keys, buffer and attempt record. Share this report, not the raw private log. Do not start another deployment." }, null, 2));
  process.exitCode = 1;
}
if (require.main === module) main().catch(e => {
  console.log(JSON.stringify({ status: "stopped", stage, error: safeError(e), activationAllowed: false,
    note: "If upload started, transactions may have landed. Preserve the keys, buffer and attempt record; share this report for reconciliation." }, null, 2));
  process.exitCode = 1;
});
module.exports = { PINS, checkBinary, checkDeployed, budget, deploymentArgs, readSigner, safeError, runCli, writeNew };
