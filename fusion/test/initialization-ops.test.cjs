const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const web3 = require("@solana/web3.js"), { PublicKey } = web3;
const c = require("../client/index.cjs");
const { PINS, INITIALIZE, initializeInstruction, checkInitializedConfig, checkInitializationPlatform,
  initializationBudget, signatureBase58, initializePausedConfig, normalizedHash, VERIFY,
  verificationAddress } = require("../ops/deploy-inactive-vps.cjs");
function config() {
  const data = Buffer.alloc(202); data[0] = 1;
  [PINS.admin, web3.SystemProgram.programId, PINS.operator, INITIALIZE.feeWallet, INITIALIZE.platform,
    INITIALIZE.cpConfig].forEach((key, i) => new PublicKey(key).toBuffer().copy(data, 1 + 32 * i));
  data.writeBigUInt64LE(1n, 193); data[201] = 1;
  return { owner: new PublicKey(PINS.program), executable: false, data };
}
function platform() {
  const data = Buffer.alloc(944), cp = Buffer.alloc(236);
  for (const [name, buffer] of [["PlatformConfig", data], ["AmmConfig", cp]])
    crypto.createHash("sha256").update(`account:${name}`).digest().subarray(0, 8).copy(buffer);
  new PublicKey(INITIALIZE.feeWallet).toBuffer().copy(data, 16);
  new PublicKey(INITIALIZE.cpConfig).toBuffer().copy(data, 688);
  new PublicKey(PINS.operator).toBuffer().copy(data, 728);
  data.writeBigUInt64LE(1000000n, 96);
  return [{ owner: new PublicKey(INITIALIZE.launchlab), executable: false, data },
    { owner: new PublicKey(INITIALIZE.cpmm), executable: false, data: cp }];
}
test("bootstrap instruction matches the released ABI, preserves ProgramData readonly and has no unpause instruction", () => {
  const expected = c.initialize(PINS.program, PINS.admin, { operator: PINS.operator, ...INITIALIZE });
  const actual = initializeInstruction(web3);
  assert.deepEqual(actual, expected);
  assert.equal(actual.keys.length, 4);
  assert.equal(actual.keys[2].pubkey.toBase58(), "9hs85sHtbup5y4Ks1yusJdGDciwBk9keKM5JH55bFJDP");
  assert.equal(actual.keys[2].isWritable, false);
  assert.equal(actual.data[0], 0);
  assert.equal(actual.data.readBigUInt64LE(129), 1n);
});
test("initialized state must be paused and bind every wallet, Raydium account and bootstrap cap", () => {
  assert.equal(checkInitializedConfig(config(), PublicKey).paused, true);
  for (const offset of [0, 1, 33, 65, 97, 129, 161, 193, 201]) {
    const bad = config(); bad.data[offset] ^= 1;
    assert.throws(() => checkInitializedConfig(bad, PublicKey));
  }
  const foreign = config(); foreign.owner = new PublicKey(PINS.admin);
  assert.throws(() => checkInitializedConfig(foreign, PublicKey));
  const executable = config(); executable.executable = true;
  assert.throws(() => checkInitializedConfig(executable, PublicKey));
  assert.throws(() => checkInitializedConfig(null, PublicKey));
});
test("bootstrap validates existing Raydium policy without silently changing the tax authority", () => {
  let [p, cp] = platform();
  const result = checkInitializationPlatform(p, cp, PublicKey);
  assert.equal(result.platformTaxAuthority, PINS.operator);
  assert.equal(result.platformTaxAuthorityReady, false);
  new PublicKey(result.requiredTaxAuthority).toBuffer().copy(p.data, 728);
  assert.equal(checkInitializationPlatform(p, cp, PublicKey).platformTaxAuthorityReady, true);
  for (const offset of [0, 16, 80, 88, 96, 104, 688, 720, 728]) {
    [p, cp] = platform(); p.data[offset] ^= 1;
    assert.throws(() => checkInitializationPlatform(p, cp, PublicKey));
  }
  [p, cp] = platform(); cp.data[9] = 1;
  assert.throws(() => checkInitializationPlatform(p, cp, PublicKey));
  [p, cp] = platform(); cp.owner = new PublicKey(PINS.program);
  assert.throws(() => checkInitializationPlatform(p, cp, PublicKey));
});
test("bootstrap caps rent plus fees and preserves the deployer reserve", () => {
  assert.equal(initializationBudget(1676400, 10000, 1750000000).maximumCostThisTransactionSol, 0.0016864);
  for (const args of [[1676400, 10000, 501686399], [10000000, 1, 1750000000], [1676400, null, 1750000000],
    [0, 10000, 1750000000], [1676400, 0, 1750000000], [1676400, 1.5, 1750000000]])
    assert.throws(() => initializationBudget(...args));
});
test("journal signatures use canonical base58 including leading zero bytes", () => {
  const { default: bs58 } = require("bs58");
  for (const zeros of [0, 1, 2, 20, 63]) {
    const bytes = crypto.randomBytes(64); bytes.fill(0, 0, zeros); bytes[63] = 1;
    assert.equal(signatureBase58(bytes), bs58.encode(bytes));
  }
  assert.throws(() => signatureBase58(Buffer.alloc(64)));
  assert.throws(() => signatureBase58(Buffer.alloc(63, 1)));
});
test("bootstrap never prepares or broadcasts when verification is absent, config exists, or an earlier attempt is unresolved", async () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-bootstrap-"));
  const binary = Buffer.from([1, 2, 3]), a = c.addresses(PINS.program);
  const program = Buffer.alloc(36); program.writeUInt32LE(2); a.programData.toBuffer().copy(program, 4);
  const programData = Buffer.alloc(48); programData.writeUInt32LE(3); programData.writeBigUInt64LE(123n, 4);
  programData[12] = 1; new PublicKey(PINS.admin).toBuffer().copy(programData, 13); binary.copy(programData, 45);
  const num = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const string = s => Buffer.concat([num(Buffer.byteLength(s)), Buffer.from(s)]);
  const slot = Buffer.alloc(8); slot.writeBigUInt64LE(123n);
  const metadata = Buffer.concat([Buffer.alloc(8), new PublicKey(PINS.program).toBuffer(), new PublicKey(PINS.admin).toBuffer(),
    string("0.5.2"), string(VERIFY.repository), string(PINS.commit), num(VERIFY.args.length), ...VERIFY.args.map(string),
    slot, Buffer.from([verificationAddress(PublicKey)[1]])]);
  const [p, cp] = platform();
  const accounts = [
    { owner: c.LOADER, executable: true, data: program },
    { owner: c.LOADER, executable: false, data: programData }, null,
    { owner: new PublicKey(VERIFY.program), executable: false, data: metadata }, p, cp,
  ];
  let reads = 0, verified = false, reports = [];
  const rpc = { getMultipleAccountsInfoAndContext: async () => { reads++; return { value: accounts, context: { slot: 200 } }; },
    getLatestBlockhash: () => { assert.fail("Must not prepare or sign another transaction"); },
    sendRawTransaction: () => { assert.fail("Must not broadcast"); } };
  const args = { rpc, privateDir: directory, binary, adminFile: "/not-a-real-key", web3,
    cfg: { feeWallet: new PublicKey(INITIALIZE.feeWallet), platformId: new PublicKey(INITIALIZE.platform), cpConfigId: new PublicKey(INITIALIZE.cpConfig) } };
  const originalFetch = global.fetch, originalLog = console.log;
  try {
    global.fetch = async () => ({ ok: true, json: async () => ({ is_verified: verified, is_frozen: false, is_closed: false,
      repo_url: VERIFY.repository, commit: PINS.commit, on_chain_hash: normalizedHash(binary), executable_hash: normalizedHash(binary) }) });
    console.log = text => reports.push(JSON.parse(text));
    await assert.rejects(initializePausedConfig(args), /requires_public_verification/);
    assert.equal(reads, 0);
    verified = true; accounts[2] = config();
    await initializePausedConfig(args);
    assert.equal(reports[0].status, "already_initialized_paused");
    assert.equal(reports[0].transactionsSent, 0);
    accounts[2] = null;
    fs.writeFileSync(path.join(directory, INITIALIZE.record), "preserved original attempt", { mode: 0o600 });
    await assert.rejects(initializePausedConfig(args), /previous_initialization_requires_reconciliation/);
    assert.equal(fs.readFileSync(path.join(directory, INITIALIZE.record), "utf8"), "preserved original attempt");
  } finally {
    global.fetch = originalFetch; console.log = originalLog;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
