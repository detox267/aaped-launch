const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { PublicKey } = require("@solana/web3.js");
const { PINS, VERIFY, verificationArgs, verificationAddress, checkVerificationMetadata,
  normalizedHash, publicVerificationMatches, rpcProvider } = require("../ops/deploy-inactive-vps.cjs");
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function string(s) { const b = Buffer.from(s); return Buffer.concat([u32(b.length), b]); }
function fixture(overrides = {}) {
  const v = { program: PINS.program, signer: PINS.admin, version: "0.5.2", repository: VERIFY.repository,
    commit: PINS.commit, args: VERIFY.args, slot: 469697376n, bump: verificationAddress(PublicKey)[1], ...overrides };
  const slot = Buffer.alloc(8); slot.writeBigUInt64LE(v.slot);
  const data = Buffer.concat([Buffer.alloc(8), new PublicKey(v.program).toBuffer(), new PublicKey(v.signer).toBuffer(),
    string(v.version), string(v.repository), string(v.commit), u32(v.args.length), ...v.args.map(string), slot, Buffer.from([v.bump])]);
  return { account: { owner: new PublicKey(VERIFY.program), executable: false, data }, PublicKey, deploymentSlot: "469697376" };
}
test("verification rebuilds the exact public source and uses the explicit admin and isolated RPC config", () => {
  const args = verificationArgs({ rpcUrl: "https://solana-mainnet.g.alchemy.com/v2/SECRET", adminFile: "/private/fusion-admin.json", configFile: "/private/verify-config.json" });
  const value = (a, flag) => a[a.indexOf(flag) + 1];
  for (const a of [args.upload, args.remote]) {
    assert.equal(value(a, "--url"), "https://solana-mainnet.g.alchemy.com/v2/SECRET");
    assert.equal(value(a, "--config"), "/private/verify-config.json");
    assert.equal(value(a, "--program-id"), PINS.program);
  }
  assert.equal(value(args.upload, "--keypair"), "/private/fusion-admin.json");
  assert.equal(value(args.upload, "--commit-hash"), PINS.commit);
  assert.equal(value(args.upload, "--mount-path"), "fusion");
  assert.equal(value(args.upload, "--library-name"), "moonz_fusion");
  assert.equal(value(args.upload, "--arch"), "v0");
  assert(args.upload.includes(VERIFY.repository)); assert(args.upload.includes("--skip-prompt"));
  for (const flag of ["--skip-build", "--current-dir", "--remote"]) assert(!args.upload.includes(flag));
  assert.equal(value(args.remote, "--uploader"), PINS.admin);
  assert.equal(rpcProvider(value(args.remote, "--url")), "Alchemy");
});
test("finalized verification metadata binds the source, signer, program, build flags and deployment slot", () => {
  assert.equal(checkVerificationMetadata(fixture()).metadataRecorded, true);
  for (const change of [
    { program: PINS.operator }, { signer: PINS.operator }, { version: "0.4.0" },
    { repository: "https://github.com/other/repo" }, { commit: "0".repeat(40) },
    { args: [...VERIFY.args, "--bpf"] }, { args: ["--mount-path", "other"] },
    { slot: 469697375n }, { bump: (verificationAddress(PublicKey)[1] + 1) % 256 },
  ]) assert.throws(() => checkVerificationMetadata(fixture(change)), /release_mismatch/);
});
test("metadata validation rejects absent, foreign, truncated and trailing-data accounts", () => {
  assert.throws(() => checkVerificationMetadata({ ...fixture(), account: null }), /missing/);
  const wrong = fixture(); wrong.account.owner = new PublicKey(PINS.program);
  assert.throws(() => checkVerificationMetadata(wrong), /wrong_owner/);
  const short = fixture(); short.account.data = short.account.data.subarray(0, 90);
  assert.throws(() => checkVerificationMetadata(short), /malformed/);
  const extra = fixture(); extra.account.data = Buffer.concat([extra.account.data, Buffer.from([0])]);
  assert.throws(() => checkVerificationMetadata(extra), /release_mismatch/);
});
test("public verified status alone cannot replace release, hash, closed-state and upgradeability checks", () => {
  const binary = Buffer.from([1, 2, 3, 0, 0]), h = normalizedHash(binary);
  const status = { is_verified: true, is_frozen: false, is_closed: false, commit: PINS.commit,
    repo_url: VERIFY.repository, on_chain_hash: h, executable_hash: h };
  assert.equal(publicVerificationMatches(status, binary), true);
  for (const change of [
    { is_verified: false }, { is_frozen: true }, { is_closed: true }, { commit: "0".repeat(40) },
    { repo_url: "https://github.com/other/repo" }, { on_chain_hash: "0".repeat(64) },
    { executable_hash: "0".repeat(64) },
  ]) assert.equal(publicVerificationMatches({ ...status, ...change }, binary), false);
  assert.equal(publicVerificationMatches(null, binary), false);
});
test("verifier hash normalizes only trailing account padding, not meaningful bytes", () => {
  const bytes = Buffer.from([1, 0, 2, 0, 0]);
  assert.equal(normalizedHash(bytes), crypto.createHash("sha256").update(Buffer.from([1, 0, 2])).digest("hex"));
  assert.notEqual(normalizedHash(bytes), normalizedHash(Buffer.from([1, 2])));
});
