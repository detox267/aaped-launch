const test = require("node:test"),
  assert = require("node:assert/strict"),
  { Keypair } = require("@solana/web3.js");
const c = require("../client/index.cjs"),
  { check, hash } = require("../ops/check-verification.cjs");
function fixture() {
  const programId = Keypair.generate().publicKey.toBase58(),
    authority = Keypair.generate().publicKey,
    expectedCommit = "a".repeat(40);
  const binary = Buffer.from(
    "\x7fELF Moonz Fusion security/advisories/new\0\0",
  );
  const program = Buffer.alloc(36);
  program.writeUInt32LE(2);
  c.addresses(programId).programData.toBuffer().copy(program, 4);
  const programData = Buffer.alloc(45 + binary.length + 20);
  programData.writeUInt32LE(3);
  programData[12] = 1;
  authority.toBuffer().copy(programData, 13);
  binary.copy(programData, 45);
  const executableHash = hash(binary);
  return {
    programId,
    expectedAuthority: authority.toBase58(),
    expectedCommit,
    binary,
    program: { owner: c.LOADER, executable: true, data: program },
    programData: { owner: c.LOADER, data: programData },
    verification: {
      is_verified: true,
      is_frozen: false,
      is_closed: false,
      commit: expectedCommit,
      repo_url: `https://github.com/detox267/aaped-launch/tree/${expectedCommit}`,
      on_chain_hash: executableHash,
      executable_hash: executableHash,
    },
  };
}
test("verification requires the actual deployed bytes, public commit and retained authority", () =>
  assert.equal(check(fixture()).upgradeable, true));
test("old verification cannot authorize a changed program binary", () => {
  const f = fixture();
  f.programData.data[46] ^= 1;
  assert.throws(() => check(f), /differs/);
});
test("verification rejects revoked/wrong authority, wrong source, pending and stale status", () => {
  for (const change of [
    (f) => (f.programData.data[12] = 0),
    (f) => (f.expectedAuthority = Keypair.generate().publicKey.toBase58()),
    (f) => (f.verification.commit = "b".repeat(40)),
    (f) => (f.verification.repo_url = "https://github.com/other/repo"),
    (f) => (f.verification.is_verified = false),
    (f) => (f.verification.is_frozen = true),
    (f) => (f.verification.on_chain_hash = "0".repeat(64)),
  ]) {
    const f = fixture();
    change(f);
    assert.throws(() => check(f));
  }
});
