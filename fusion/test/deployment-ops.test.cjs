const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { PublicKey, Keypair } = require("@solana/web3.js");
const { PINS, budget, checkBinary, checkDeployed, checkResume, activeBufferDeployment, rpcProvider, deploymentArgs, readSigner, safeError, runCli, writeNew } = require("../ops/deploy-inactive-vps.cjs");
const rents = [833120, 1238366840, 1238326200, 1676400];
function fixture() {
  const owner = new PublicKey(PINS.loader), programKey = new PublicKey(PINS.program);
  const dataAddress = PublicKey.findProgramAddressSync([programKey.toBuffer()], owner)[0];
  const binary = Buffer.from([1, 2, 3, 4]);
  const data = Buffer.alloc(36); data.writeUInt32LE(2); dataAddress.toBuffer().copy(data, 4);
  const pd = Buffer.alloc(45 + binary.length); pd.writeUInt32LE(3); pd.writeBigUInt64LE(123n, 4);
  pd[12] = 1; new PublicKey(PINS.admin).toBuffer().copy(pd, 13); binary.copy(pd, 45);
  return { program: { owner, executable: true, data }, programData: { owner, data: pd }, binary, PublicKey };
}
test("deployment budget includes full temporary buffer and a separate 0.5 SOL reserve", () => {
  const b = budget(rents, 3000011000);
  assert.equal(b.minimumBalanceForThisPlanSol, 2.97920256);
  assert.equal(b.persistentRentIncludingConfigSol, 1.24087636);
  assert.throws(() => budget(rents, 2979202559), /insufficient/);
  assert.throws(() => budget([-1, ...rents.slice(1)], 3000011000), /invalid_rpc/);
  assert.throws(() => budget(Array(4).fill(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER), /invalid_rpc/);
});
test("deployment arguments pin payer, retained authority, persistent recovery key and exact capacity", () => {
  const a = deploymentArgs({ binaryPath: "/reviewed.so", rpcUrl: "https://rpc.invalid/private", adminFile: "/admin.json", programFile: "/program.json", bufferFile: "/buffer.json" });
  const value = name => a[a.indexOf(name) + 1];
  for (const name of ["--keypair", "--fee-payer", "--upgrade-authority"]) assert.equal(value(name), "/admin.json");
  assert.equal(value("--max-len"), "243600");
  assert.equal(value("--buffer"), "/buffer.json");
  assert.equal(value("--program-id"), "/program.json");
  assert.equal(value("--max-sign-attempts"), "5");
  assert.equal(value("--with-compute-unit-price"), "10000");
  assert(a.includes("--use-rpc"));
  for (const flag of ["--final", "--skip-preflight", "--skip-feature-verify"]) assert(!a.includes(flag));
});
test("reviewed resume counts existing buffer rent once and bounds the new retry/fee settings", () => {
  const b = budget(rents, 1761236999, 1238366841);
  assert.equal(b.existingBufferRentCreditSol, 1.2383262);
  assert.equal(b.minimumBalanceForThisPlanSol, 1.74087636);
  assert.throws(() => budget(rents, 1740876359, 1238366841), /insufficient/);
  const a = deploymentArgs({ binaryPath: "/reviewed.so", rpcUrl: "https://rpc.invalid", adminFile: "/admin.json", programFile: "/program.json", bufferFile: "/buffer.json", resume: true });
  const value = name => a[a.indexOf(name) + 1];
  assert.equal(value("--buffer"), "/buffer.json");
  assert.equal(value("--program-id"), "/program.json");
  assert.equal(value("--upgrade-authority"), "/admin.json");
  assert.equal(value("--max-sign-attempts"), "20");
  assert.equal(value("--with-compute-unit-price"), "50000");
  assert(!a.includes("--final"));
});
test("recovery rejects substituted records, wrong buffer control and unexpected nonzero bytes", () => {
  const binary = Buffer.from([9, 8, 0, 6]);
  const data = Buffer.alloc(41); data.writeUInt32LE(1); data[4] = 1;
  new PublicKey(PINS.admin).toBuffer().copy(data, 5); data[37] = 9;
  const base = { buffer: { owner: new PublicKey(PINS.loader), executable: false, data },
    attempt: { programId: PINS.program, deploymentBuffer: PINS.buffer, upgradeAuthority: PINS.admin,
      releaseCommit: PINS.commit, binarySha256: PINS.sha256, capacityBytes: PINS.bytes,
      configWillBeInitialized: false, activationAllowed: false }, binary, PublicKey };
  assert.equal(checkResume(base).remainingDifferentBytes, 2);
  for (const change of [
    f => { f.attempt.programId = PINS.admin; },
    f => { f.attempt.binarySha256 = "0".repeat(64); },
    f => { f.buffer.owner = Keypair.generate().publicKey; },
    f => { f.buffer.data[4] = 0; },
    f => { f.buffer.data[5] ^= 1; },
    f => { f.buffer.data[38] = 7; },
    f => { f.buffer.executable = true; },
  ]) {
    const f = { ...base, attempt: { ...base.attempt }, buffer: { ...base.buffer, data: Buffer.from(data) } };
    change(f); assert.throws(() => checkResume(f));
  }
});
test("active original CLI blocks another upload without printing its RPC credentials", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-process-check-"));
  try {
    fs.mkdirSync(path.join(dir, "123"));
    fs.writeFileSync(path.join(dir, "123/cmdline"), ["/usr/local/bin/solana", "program", "deploy", "--buffer", "/saved-buffer.json", "--url", "https://rpc.invalid/SECRET", ""].join("\0"));
    assert.equal(activeBufferDeployment("/saved-buffer.json", dir), true);
    assert.equal(activeBufferDeployment("/other-buffer.json", dir), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("provider diagnostics reveal only a known provider label, never the endpoint or key", () => {
  assert.equal(rpcProvider("https://mainnet.helius-rpc.com/?api-key=SECRET"), "Helius");
  assert.equal(rpcProvider("https://rpc.helius.xyz/?api-key=SECRET"), "Helius");
  assert.equal(rpcProvider("https://api.mainnet-beta.solana.com"), "Solana public RPC");
  assert.equal(rpcProvider("https://helius-rpc.com.untrusted.invalid/SECRET"), "other_or_proxy");
  assert.equal(rpcProvider("https://user:SECRET@private.invalid/SECRET"), "other_or_proxy");
});
test("a successful CLI exit alone cannot establish deployment identity or upgrade authority", () => {
  assert.equal(checkDeployed(fixture()).upgradeAuthority, PINS.admin);
  for (const change of [
    f => { f.program.executable = false; },
    f => { f.program.owner = Keypair.generate().publicKey; },
    f => { f.program.data[4] ^= 1; },
    f => { f.programData.data[12] = 0; },
    f => { f.programData.data[13] ^= 1; },
    f => { f.programData.data[45] ^= 1; },
    f => { f.programData.data = Buffer.concat([f.programData.data, Buffer.from([1])]); },
  ]) { const f = fixture(); change(f); assert.throws(() => checkDeployed(f)); }
  assert.throws(() => checkBinary(Buffer.from("Moonz Fusion")), /release_binary_mismatch/);
});
test("signer checks reject another identity, permissive files and symlinks without emitting their contents", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-deploy-signers-"));
  try {
    const key = Keypair.generate(), file = path.join(dir, "key.json");
    fs.writeFileSync(file, JSON.stringify([...key.secretKey]), { mode: 0o600 });
    assert(readSigner(file, key.publicKey.toBase58(), Keypair).equals(key.publicKey));
    assert.throws(() => readSigner(file, PINS.admin, Keypair), /signer_identity/);
    const link = path.join(dir, "link.json"); fs.symlinkSync(file, link);
    assert.throws(() => readSigner(link, key.publicKey.toBase58(), Keypair), /permissions/);
    fs.chmodSync(file, 0o644);
    assert.throws(() => readSigner(file, key.publicKey.toBase58(), Keypair), /permissions/);
    assert.equal(safeError(new Error("https://rpc.invalid/SECRET private key contents")), "operation_failed");
    assert.equal(safeError({ code: "SECRET" }), "operation_failed");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("the durable attempt record cannot be replaced by a second deployment invocation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-deploy-journal-"));
  try {
    const file = path.join(dir, "attempt.json"); writeNew(file, "first attempt");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.throws(() => writeNew(file, "second attempt"), /EEXIST/);
    assert.equal(fs.readFileSync(file, "utf8"), "first attempt");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("CLI output and errors go to the private log while only the exit code is returned", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-deploy-log-"));
  try {
    const log = path.join(dir, "private.log"), fd = fs.openSync(log, "wx", 0o600);
    try {
      const result = await runCli(["-e", "console.log('PRIVATE RPC OUTPUT');console.error('PRIVATE ERROR');process.exitCode=7"], fd, process.execPath);
      assert.equal(result.exitCode, 7);
      assert(!JSON.stringify(result).includes("PRIVATE"));
      assert.match(fs.readFileSync(log, "utf8"), /PRIVATE RPC OUTPUT/);
      assert.match(fs.readFileSync(log, "utf8"), /PRIVATE ERROR/);
    } finally { fs.closeSync(fd); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
