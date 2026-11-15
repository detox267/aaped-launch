const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const web3 = require("@solana/web3.js"), { PublicKey } = web3;
const sdk = require("@raydium-io/raydium-sdk-v2");
const { PINS, INITIALIZE, TAX_REGISTRATION, taxAuthorityInstruction, checkTaxAuthorityChange,
  requireEmptyPlatform, registerTaxAuthority, VERIFY, normalizedHash } = require("../ops/deploy-inactive-vps.cjs");
function fixture() {
  const data = Buffer.alloc(944);
  crypto.createHash("sha256").update("account:PlatformConfig").digest().subarray(0, 8).copy(data);
  data.writeBigUInt64LE(1061n, 8);
  for (const [offset, key] of [[16, INITIALIZE.feeWallet], [48, INITIALIZE.feeWallet], [688, INITIALIZE.cpConfig],
    [728, PINS.operator], [760, PINS.admin], [800, PINS.operator], [834, PINS.admin]])
    new PublicKey(key).toBuffer().copy(data, offset);
  data.writeBigUInt64LE(1000000n, 96); Buffer.from("MOONZ").copy(data, 112);
  Buffer.from("https://moonz.fun").copy(data, 176); Buffer.from("https://moonz.fun/logo.png").copy(data, 432);
  data[832] = 1; data[833] = 1;
  return { owner: new PublicKey(INITIALIZE.launchlab), executable: false, lamports: 10000000, data };
}
function changed(before) {
  const after = { ...before, data: Buffer.from(before.data) };
  PublicKey.findProgramAddressSync([Buffer.from("tax-authority")], new PublicKey(PINS.program))[0].toBuffer().copy(after.data, 728);
  after.data.writeBigUInt64LE(1087n, 8); return after;
}
test("authority update exactly matches the pinned Raydium SDK while carrying all current serialized fields forward", () => {
  const before = fixture(), d = sdk.PlatformConfig.decode(before.data);
  const string = bytes => Buffer.from(bytes).toString("utf8").replace(/\0+$/, "");
  const expected = sdk.updatePlatformConfig(new PublicKey(INITIALIZE.launchlab), new PublicKey(PINS.admin),
    new PublicKey(INITIALIZE.platform), { type: "updateAll", value: {
      platformClaimFeeWallet: d.platformClaimFeeWallet, platformLockNftWallet: d.platformLockNftWallet,
      platformVestingWallet: d.platformVestingWallet, cpConfigId: d.cpConfigId,
      migrateCpLockNftScale: { platformScale: d.platformScale, creatorScale: d.creatorScale, burnScale: d.burnScale },
      feeRate: d.feeRate, name: string(d.name), web: string(d.web), img: string(d.img),
      transferFeeExtensionAuth: new PublicKey(changed(before).data.subarray(728, 760)),
      creatorFeeRate: d.creatorFeeRate, platformVestingScale: d.platformVestingScale,
    } });
  assert.deepEqual(taxAuthorityInstruction(web3, before.data), expected);
  assert.equal(TAX_REGISTRATION.poolBytes, sdk.LaunchpadPool.span);
  assert.equal(TAX_REGISTRATION.platformOffset, sdk.LaunchpadPool.offsetOf("platformId"));
});
test("receipt validation rejects every unrelated platform byte change and wrong authority, epoch, owner, rent or executable state", () => {
  const before = fixture(), after = changed(before);
  assert.equal(checkTaxAuthorityChange(before, after, PublicKey).otherPlatformSettingsUnchanged, true);
  for (let offset = 0; offset < 944; offset++) {
    if ((offset >= 8 && offset < 16) || (offset >= 728 && offset < 760)) continue;
    const bad = { ...after, data: Buffer.from(after.data) }; bad.data[offset] ^= 1;
    assert.throws(() => checkTaxAuthorityChange(before, bad, PublicKey), /unrelated_setting/);
  }
  for (const change of [a => a.data[728] ^= 1, a => a.data.writeBigUInt64LE(1061n, 8),
    a => a.lamports++, a => a.executable = true, a => a.owner = new PublicKey(PINS.program)]) {
    const bad = { ...after, data: Buffer.from(after.data) }; change(bad);
    assert.throws(() => checkTaxAuthorityChange(before, bad, PublicKey));
  }
});
test("noncanonical branding and foreign layouts cannot be silently normalized by a bulk platform update", () => {
  const before = fixture(); before.data[130] = 1;
  assert.throws(() => taxAuthorityInstruction(web3, before.data), /noncanonical_branding/);
  const utf8 = fixture(); utf8.data[112] = 0xff;
  assert.throws(() => taxAuthorityInstruction(web3, utf8.data));
  assert.throws(() => taxAuthorityInstruction(web3, Buffer.alloc(944)), /layout_mismatch/);
});
test("both finalized and confirmed platform scans must be empty at or beyond the checked state slot", async () => {
  const commitments = [];
  const rpc = { getProgramAccounts: async (key, options) => {
    assert.equal(key.toBase58(), INITIALIZE.launchlab);
    assert.deepEqual(options.dataSlice, { offset: 0, length: 0 });
    assert.equal(options.filters[1].memcmp.bytes, INITIALIZE.platform);
    commitments.push(options.commitment); return { context: { slot: 100 }, value: [] };
  } };
  await requireEmptyPlatform(rpc, PublicKey, 100);
  assert.deepEqual(commitments, ["finalized", "confirmed"]);
  for (const commitment of ["finalized", "confirmed"]) {
    await assert.rejects(requireEmptyPlatform({ getProgramAccounts: async (_, options) => ({ context: { slot: 100 },
      value: options.commitment === commitment ? [{}] : [] }) }, PublicKey, 100), /existing_platform_launches/);
  }
  await assert.rejects(requireEmptyPlatform({ getProgramAccounts: async () => ({ context: { slot: 99 }, value: [] }) }, PublicKey, 100), /scan_invalid/);
  await assert.rejects(requireEmptyPlatform({ getProgramAccounts: async () => { throw Error("provider unavailable"); } }, PublicKey, 100));
});
test("missing source verification or active backend flags prevent tax registration before transaction preparation", async () => {
  const binary = Buffer.from([1, 2, 3]);
  let verified = false, backendChecks = 0;
  const args = { binary, web3, privateDir: "/unused", adminFile: "/unused",
    cfg: { feeWallet: new PublicKey(INITIALIZE.feeWallet), platformId: new PublicKey(INITIALIZE.platform), cpConfigId: new PublicKey(INITIALIZE.cpConfig) },
    rpc: { getMultipleAccountsInfoAndContext: () => assert.fail("Must not prepare a transaction") },
    checkBackend: () => { backendChecks++; throw Error("backend flags active"); } };
  const original = global.fetch;
  try {
    global.fetch = async () => ({ ok: true, json: async () => ({ is_verified: verified, is_frozen: false, is_closed: false,
      repo_url: VERIFY.repository, commit: PINS.commit, on_chain_hash: normalizedHash(binary), executable_hash: normalizedHash(binary) }) });
    await assert.rejects(registerTaxAuthority(args), /requires_public_verification/);
    assert.equal(backendChecks, 0);
    verified = true;
    await assert.rejects(registerTaxAuthority(args), /backend flags active/);
    assert.equal(backendChecks, 1);
  } finally { global.fetch = original; }
});
