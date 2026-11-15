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
const RESUME = Object.freeze({ microLamportsPerCu: 50000, maxSignAttempts: 20,
  originalLog: "deployment-1794736155952.log", record: "deployment-resume-1.json" });
const VERIFY = Object.freeze({
  executable: "/usr/local/bin/solana-verify",
  executableSha256: "b9d5ccce9634dc14269cab3e7a58649bc141b3306e7735a94478c936341f211f",
  program: "verifycLy8mB96wd9wqq3WDXQwM4oU6r42Th37Db9fC",
  repository: "https://github.com/detox267/aaped-launch",
  args: ["--mount-path", "fusion", "--library-name", "moonz_fusion", "--arch", "v0"],
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
function rpcProvider(url) {
  const host = new URL(url).hostname.toLowerCase();
  if (["helius-rpc.com", "helius.xyz"].some(domain => host === domain || host.endsWith(`.${domain}`))) return "Helius";
  if (["alchemy.com", "alchemyapi.io"].some(domain => host === domain || host.endsWith(`.${domain}`))) return "Alchemy";
  if (["api.mainnet-beta.solana.com", "api.mainnet.solana.com"].includes(host)) return "Solana public RPC";
  return "other_or_proxy";
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
function budget(rents, balance, existingBufferLamports = 0) {
  need(rents.length === 4 && [...rents, balance, existingBufferLamports].every(n => Number.isSafeInteger(n) && n >= 0), "invalid_rpc_amount");
  const persistent = rents[0] + rents[1] + rents[3];
  const peak = persistent + rents[2], credit = Math.min(existingBufferLamports, rents[2]);
  const required = peak - credit + PINS.reserveLamports;
  need(Number.isSafeInteger(required), "invalid_rpc_amount");
  need(balance >= required, "insufficient_deployer_balance");
  return { adminBalanceSol: balance / 1e9, persistentRentIncludingConfigSol: persistent / 1e9,
    conservativeTemporaryRentPeakSol: peak / 1e9, extraReserveSol: PINS.reserveLamports / 1e9,
    existingBufferRentCreditSol: credit / 1e9,
    minimumBalanceForThisPlanSol: required / 1e9 };
}
function checkResume({ buffer, attempt, binary, PublicKey }) {
  need(attempt?.programId === PINS.program && attempt.deploymentBuffer === PINS.buffer
    && attempt.upgradeAuthority === PINS.admin && attempt.releaseCommit === PINS.commit
    && attempt.binarySha256 === PINS.sha256 && attempt.capacityBytes === PINS.bytes
    && attempt.configWillBeInitialized === false && attempt.activationAllowed === false,
  "original_attempt_identity_mismatch");
  need(buffer && !buffer.executable && buffer.owner.equals(new PublicKey(PINS.loader))
    && buffer.data.length === 37 + binary.length && buffer.data.readUInt32LE(0) === 1,
  "recovery_buffer_mismatch");
  need(buffer.data[4] === 1 && new PublicKey(buffer.data.subarray(5, 37)).toBase58() === PINS.admin,
    "recovery_buffer_authority_mismatch");
  let remainingDifferentBytes = 0;
  for (let i = 0; i < binary.length; i++) {
    const actual = buffer.data[37 + i];
    need(actual === 0 || actual === binary[i], "unexpected_buffer_contents");
    if (actual !== binary[i]) remainingDifferentBytes++;
  }
  return { remainingDifferentBytes, bufferMatchesBinary: remainingDifferentBytes === 0,
    bufferSha256: crypto.createHash("sha256").update(buffer.data).digest("hex") };
}
function activeBufferDeployment(bufferFile, procRoot = "/proc") {
  return fs.readdirSync(procRoot).filter(p => /^[0-9]+$/.test(p)).some(p => {
    let args;
    try { args = fs.readFileSync(path.join(procRoot, p, "cmdline"), "utf8").split("\0"); }
    catch (e) { if (e.code === "ENOENT" || e.code === "ESRCH") return false; throw e; }
    return path.basename(args[0] || "") === "solana" && args.includes("program") && args.includes("deploy")
      && (args.includes(bufferFile) || args.includes(PINS.buffer) || args.includes(PINS.program));
  });
}
function deploymentArgs({ binaryPath, rpcUrl, adminFile, programFile, bufferFile, resume = false }) {
  const policy = resume ? RESUME : PINS;
  return ["program", "deploy", binaryPath, "--url", rpcUrl,
    "--keypair", adminFile, "--fee-payer", adminFile, "--upgrade-authority", adminFile,
    "--program-id", programFile, "--buffer", bufferFile, "--max-len", String(PINS.bytes),
    "--with-compute-unit-price", String(policy.microLamportsPerCu),
    "--max-sign-attempts", String(policy.maxSignAttempts), "--use-rpc",
    "--commitment", "confirmed", "--output", "json-compact"];
}
function writeNew(filename, text) {
  const fd = fs.openSync(filename, "wx", 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const parent = fs.openSync(path.dirname(filename), "r");
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}
async function runCli(args, fd, command = "solana", progress = "Deployment upload is still running; recovery keys are saved.") {
  return new Promise(resolve => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", fd, fd] });
    const timer = setInterval(() => console.log(progress), 30000);
    child.once("error", () => { clearInterval(timer); resolve({ exitCode: null, spawnFailed: true }); });
    child.once("close", (code, signal) => { clearInterval(timer); resolve({ exitCode: code, signal }); });
  });
}
function verificationArgs({ rpcUrl, adminFile, configFile }) {
  const common = ["--config", configFile, "--url", rpcUrl];
  return {
    upload: [...common, "verify-from-repo", VERIFY.repository, "--program-id", PINS.program,
      "--commit-hash", PINS.commit, ...VERIFY.args, "--keypair", adminFile,
      "--compute-unit-price", "50000", "--skip-prompt"],
    remote: [...common, "remote", "submit-job", "--program-id", PINS.program, "--uploader", PINS.admin],
  };
}
function verificationAddress(PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("otter_verify"), new PublicKey(PINS.admin).toBuffer(),
    new PublicKey(PINS.program).toBuffer()], new PublicKey(VERIFY.program));
}
function checkVerificationMetadata({ account, PublicKey, deploymentSlot }) {
  need(account && !account.executable && account.owner.equals(new PublicKey(VERIFY.program)), "verification_metadata_missing_or_wrong_owner");
  // solana-verify v0.5.2 OtterBuildParams: discriminator8, address, signer,
  // version, git_url, commit, Vec<String> args, deployed_slot, bump.
  const data = account.data; let offset = 8;
  const take = size => { need(Number.isSafeInteger(size) && size >= 0 && offset + size <= data.length, "malformed_verification_metadata");
    const result = data.subarray(offset, offset + size); offset += size; return result; };
  const string = () => { const size = take(4).readUInt32LE(); need(size <= 4096, "malformed_verification_metadata"); return take(size).toString("utf8"); };
  const program = new PublicKey(take(32)).toBase58(), signer = new PublicKey(take(32)).toBase58();
  const version = string(), repository = string(), commit = string();
  const count = take(4).readUInt32LE(); need(count <= 32, "malformed_verification_metadata");
  const args = Array.from({ length: count }, string);
  const slot = take(8).readBigUInt64LE().toString(), bump = take(1)[0];
  need(program === PINS.program && signer === PINS.admin && version === "0.5.2"
    && repository === VERIFY.repository && commit === PINS.commit
    && JSON.stringify(args) === JSON.stringify(VERIFY.args)
    && slot === String(deploymentSlot) && bump === verificationAddress(PublicKey)[1]
    && offset === data.length, "verification_metadata_release_mismatch");
  return { metadataPda: verificationAddress(PublicKey)[0].toBase58(), metadataRecorded: true,
    repository, releaseCommit: commit, deploymentSlot: slot };
}
function normalizedHash(binary) {
  let end = binary.length; while (end && binary[end - 1] === 0) end--;
  return crypto.createHash("sha256").update(binary.subarray(0, end)).digest("hex");
}
function publicVerificationMatches(status, binary) {
  const hash = normalizedHash(binary);
  return status?.is_verified === true && status.is_frozen === false && status.is_closed === false
    && status.commit === PINS.commit
    && [VERIFY.repository, `${VERIFY.repository}/tree/${PINS.commit}`].includes(status.repo_url)
    && status.on_chain_hash === hash && status.executable_hash === hash;
}
async function publicVerificationStatus() {
  try {
    const response = await fetch(`https://verify.osec.io/status/${PINS.program}`, { signal: AbortSignal.timeout(15000) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}
async function verifyPublicSource({ rpc, cfg, privateDir, binary, adminFile, PublicKey }) {
  const a = derive(PublicKey), [metadataPda] = verificationAddress(PublicKey);
  async function state() {
    const result = await rpc.getMultipleAccountsInfoAndContext([a.program, a.programData, a.config, metadataPda], "finalized");
    return { chain: checkDeployed({ program: result.value[0], programData: result.value[1], binary, PublicKey }),
      metadata: result.value[3], configInitialized: !!result.value[2], finalizedSlot: result.context.slot };
  }
  stage = "verification_preflight";
  let current = await state();
  const priorStatus = await publicVerificationStatus();
  if (publicVerificationMatches(priorStatus, binary)) {
    const metadata = checkVerificationMetadata({ account: current.metadata, PublicKey, deploymentSlot: current.chain.deploymentSlot });
    console.log(JSON.stringify({ readOnly: true, transactionsSent: 0, status: "public_source_verified", ...current.chain,
      ...metadata, rpcProvider: providerLabel, publicSourceVerificationConfirmed: true,
      configInitialized: current.configInitialized, activationAllowed: false }, null, 2)); return;
  }
  const verifier = fs.readFileSync(VERIFY.executable);
  need(crypto.createHash("sha256").update(verifier).digest("hex") === VERIFY.executableSha256, "verifier_executable_mismatch");
  const attemptFile = path.join(privateDir, "verification-upload-attempt.json");
  if (!current.metadata) {
    need(!fs.existsSync(attemptFile), "previous_verification_upload_requires_reconciliation");
    need(await rpc.getBalance(new PublicKey(PINS.admin), "finalized") >= 100000000, "verification_fee_reserve_low");
  } else checkVerificationMetadata({ account: current.metadata, PublicKey, deploymentSlot: current.chain.deploymentSlot });
  // The verifier loads CLI config even when --keypair is explicit. Isolate it
  // from the VPS default signer; never change the server's global CLI config.
  const configFile = path.join(privateDir, `verification-cli-${crypto.randomUUID()}.json`);
  writeNew(configFile, JSON.stringify({ json_rpc_url: cfg.rpcUrl, websocket_url: "", keypair_path: adminFile,
    address_labels: {}, commitment: "finalized" }));
  const args = verificationArgs({ rpcUrl: cfg.rpcUrl, adminFile, configFile });
  const logFile = path.join(privateDir, `verification-${Date.now()}.log`);
  const fd = fs.openSync(logFile, "wx", 0o600);
  try {
    console.log(JSON.stringify({ status: "verification_preflight_passed", rpcProvider: providerLabel,
      programId: PINS.program, upgradeAuthority: PINS.admin, repository: VERIFY.repository,
      releaseCommit: PINS.commit, binarySha256: PINS.sha256, activationAllowed: false }, null, 2));
    if (!current.metadata) {
      stage = "rebuild_and_upload_verification_metadata";
      writeNew(attemptFile, JSON.stringify({ ...current.chain, repository: VERIFY.repository,
        startedAt: new Date().toISOString() }, null, 2));
      console.log("Rebuilding the pinned public source and recording verification metadata. This uses transaction fees and metadata rent.");
      const result = await runCli(args.upload, fd, VERIFY.executable, "Source rebuild and metadata verification are still running.");
      fs.fsyncSync(fd);
      for (let i = 0; i < 7; i++) {
        current = await state();
        if (current.metadata) break;
        if (i < 6) await new Promise(resolve => setTimeout(resolve, 5000));
      }
      if (!current.metadata) {
        console.log(JSON.stringify({ status: "verification_metadata_needs_reconciliation", cliExitCode: result.exitCode,
          publicSourceVerificationConfirmed: false, privateLog: logFile, activationAllowed: false }, null, 2));
        process.exitCode = 1; return;
      }
    }
    stage = "finalized_verification_metadata_check";
    let metadata = checkVerificationMetadata({ account: current.metadata, PublicKey, deploymentSlot: current.chain.deploymentSlot });
    console.log(JSON.stringify({ status: "verification_metadata_confirmed", ...metadata, activationAllowed: false }, null, 2));
    stage = "remote_public_verification";
    console.log("Submitting the public verification job; the service will rebuild the pinned source independently.");
    const remote = await runCli(args.remote, fd, VERIFY.executable, "Public verification is still running; launches and rewards remain disabled.");
    fs.fsyncSync(fd);
    current = await state();
    metadata = checkVerificationMetadata({ account: current.metadata, PublicKey, deploymentSlot: current.chain.deploymentSlot });
    let status = await publicVerificationStatus();
    for (let i = 0; i < 3 && !publicVerificationMatches(status, binary); i++) {
      await new Promise(resolve => setTimeout(resolve, 5000)); status = await publicVerificationStatus();
    }
    // Re-read the live bytes after polling so stale public verification cannot
    // conceal a changed binary or revoked/rotated upgrade authority.
    current = await state();
    metadata = checkVerificationMetadata({ account: current.metadata, PublicKey, deploymentSlot: current.chain.deploymentSlot });
    const verified = publicVerificationMatches(status, binary);
    const match = fs.readFileSync(logFile, "utf8").match(/Verification request sent with request id:\s*([0-9a-f]{8}-[0-9a-f-]{27,})\b/i);
    const report = { status: verified ? "public_source_verified" : "public_verification_not_confirmed", ...current.chain,
      ...metadata, rpcProvider: providerLabel, publicSourceVerificationConfirmed: verified,
      executableHash: normalizedHash(binary), finalizedSlot: current.finalizedSlot,
      configInitialized: current.configInitialized, remoteCliExitCode: remote.exitCode,
      ...(match ? { verificationJobId: match[1] } : {}), activationAllowed: false,
      ...(!verified ? { privateLog: logFile } : {}) };
    writeNew(path.join(privateDir, `verification-report-${Date.now()}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (!verified) process.exitCode = 1;
  } finally { fs.closeSync(fd); fs.unlinkSync(configFile); }
}
let stage = "arguments", providerLabel = null;
async function main(argv = process.argv.slice(2)) {
  const resume = argv[0] === "--resume";
  const verify = argv[0] === "--verify";
  const live = argv[0] === "--deploy" || resume || verify;
  const buildDir = live ? argv[1] : argv[0];
  need(argv.length === (live ? 2 : 1) && typeof buildDir === "string" && path.isAbsolute(buildDir), "usage_node_helper_optional_deploy_resume_or_verify_absolute_fusion_directory");
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
  providerLabel = rpcProvider(cfg.rpcUrl);
  if (resume) need(providerLabel !== "Solana public RPC", "resume_requires_configured_provider_rpc");
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
    if (verify) { await verifyPublicSource({ rpc, cfg, privateDir, binary, adminFile, PublicKey }); return; }
    console.log(JSON.stringify({ readOnly: true, transactionsSent: 0, status: "already_deployed_matches_release", ...result,
      configPresent: !!oldConfig, publicSourceVerificationConfirmed: false, activationAllowed: false }, null, 2));
    return;
  }
  need(!verify, "program_not_deployed");
  need(!oldData && !oldConfig, "existing_accounts_require_deployment_recovery_review");
  let recovery = null;
  const recordFile = resume ? path.join(privateDir, RESUME.record) : attemptFile;
  if (resume) {
    stage = "reconcile_original_upload";
    need(!fs.existsSync(recordFile), "resume_already_attempted_requires_reconciliation");
    need(!activeBufferDeployment(bufferFile), "original_deployment_process_still_running");
    privatePath(attemptFile);
    const attempt = JSON.parse(fs.readFileSync(attemptFile, "utf8"));
    recovery = checkResume({ buffer: oldBuffer, attempt, binary, PublicKey });
    const originalLog = path.join(privateDir, RESUME.originalLog);
    privatePath(originalLog);
    const log = fs.readFileSync(originalLog, "utf8");
    need(/max(?:imum)? retries exceeded/i.test(log)
      && !/insufficient (?:funds|lamports)|authority mismatch|program failed verification|failed to verify program|simulation failed/i.test(log),
    "original_failure_needs_different_recovery");
    const recent = await rpc.getSignaturesForAddress(buffer, { limit: 1 }, "confirmed");
    need(recent.length === 1 && recent[0].confirmationStatus === "finalized", "buffer_history_not_finalized");
    const confirmed = await rpc.getMultipleAccountsInfoAndContext([program, a.programData, a.config, buffer],
      { commitment: "confirmed", minContextSlot: before.context.slot });
    need(!confirmed.value[0] && !confirmed.value[1] && !confirmed.value[2]
      && !confirmed.value[3]?.executable && confirmed.value[3]?.owner.equals(oldBuffer.owner)
      && confirmed.value[3]?.data.equals(oldBuffer.data)
      && confirmed.value[3]?.lamports === oldBuffer.lamports, "deployment_state_changed_recheck_before_resume");
    recovery.lastFinalizedBufferSignature = recent[0].signature;
    recovery.reconciledFinalizedSlot = before.context.slot;
    recovery.reconciledConfirmedSlot = confirmed.context.slot;
  } else {
    need(!oldBuffer, "existing_accounts_require_deployment_recovery_review");
    need(!fs.existsSync(attemptFile), "previous_attempt_requires_reconciliation");
  }
  need(adminAccount && !adminAccount.executable && adminAccount.owner.equals(new PublicKey("11111111111111111111111111111111"))
    && adminAccount.data.length === 0, "unexpected_deployer_account");
  const rents = await Promise.all([36, 45 + PINS.bytes, 37 + PINS.bytes, 202].map(n => rpc.getMinimumBalanceForRentExemption(n)));
  const plan = { programId: PINS.program, deploymentBuffer: PINS.buffer, upgradeAuthority: PINS.admin,
    rpcProvider: providerLabel,
    releaseCommit: PINS.commit, binarySha256: PINS.sha256, capacityBytes: PINS.bytes,
    ...budget(rents, adminAccount.lamports, resume ? oldBuffer.lamports : 0),
    microLamportsPerCu: resume ? RESUME.microLamportsPerCu : PINS.microLamportsPerCu,
    maxSignAttempts: resume ? RESUME.maxSignAttempts : PINS.maxSignAttempts,
    resumeExistingBuffer: resume, ...(recovery ? { recovery } : {}),
    configWillBeInitialized: false, activationAllowed: false };
  stage = "cli_flags";
  const help = execFileSync("solana", ["program", "deploy", "--help"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const args = deploymentArgs({ binaryPath, rpcUrl: cfg.rpcUrl, adminFile, programFile, bufferFile, resume });
  for (const arg of args.filter(s => s.startsWith("--"))) need(help.includes(arg), "required_cli_option_unavailable");
  console.log(JSON.stringify({ readOnly: !live, transactionsSent: 0, status: "preflight_passed", ...plan }, null, 2));
  if (!live) return;
  stage = "record_deployment_attempt";
  checkBinary(fs.readFileSync(binaryPath));
  // Retain the original record. A reviewed resume has its own exclusive record;
  // it cannot be repeated or silently incremented after another uncertain exit.
  writeNew(recordFile, JSON.stringify({ ...plan, startedAt: new Date().toISOString() }, null, 2));
  const logFile = path.join(privateDir, `deployment${resume ? "-resume" : ""}-${Date.now()}.log`);
  const fd = fs.openSync(logFile, "wx", 0o600);
  let cli;
  try {
    stage = "deployment_upload";
    console.log(resume ? "Resuming the existing mainnet buffer. Launches and rewards remain disabled."
      : "Starting mainnet program deployment. Launches and rewards remain disabled.");
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
  console.log(JSON.stringify({ status: "stopped", stage, error: safeError(e), rpcProvider: providerLabel, activationAllowed: false,
    note: "If upload started, transactions may have landed. Preserve the keys, buffer and attempt record; share this report for reconciliation." }, null, 2));
  process.exitCode = 1;
});
module.exports = { PINS, RESUME, VERIFY, checkBinary, checkDeployed, checkResume, activeBufferDeployment, rpcProvider,
  budget, deploymentArgs, readSigner, safeError, runCli, writeNew, verificationArgs, verificationAddress,
  checkVerificationMetadata, normalizedHash, publicVerificationMatches };
