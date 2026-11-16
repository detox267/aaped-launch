'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {setup, spl, c, sdk, BN, SystemProgram, Clock} = require('./helpers.cjs');
const {loadMoonz, r} = require('./rewards-helpers.cjs');
const p = require('../../client/policy.cjs');
function fixture() {
  const t = setup({raydium: true}), market = loadMoonz(t), l = t.launch(), base = l.mint.publicKey;
  t.send([l.instruction], [t.admin, l.mint]);
  const userBase = t.buy(l);
  t.send([SystemProgram.transfer({fromPubkey: t.admin.publicKey, toPubkey: l.a.quoteVault, lamports: 1000000000n}),
    spl.createSyncNativeInstruction(l.a.quoteVault)]);
  t.send([c.creditDonation(t.program, t.operator.publicKey, base, l.quote, spl.TOKEN_PROGRAM_ID)], [t.operator]);
  const a = p.addresses(t.program, base, l.quote);
  const initialize = p.initialize(t.program, t.operator.publicKey, base, l.quote);
  t.send([initialize], [t.operator]);
  const state = () => p.decodePolicy(t.get(a.policy).data);
  function buy(amount = 100000000n, overrides = {}) {
    const minimum = overrides.minOut ?? 1n;
    const swap = sdk.buyExactInInstruction(c.LAUNCHLAB, a.policy, sdk.getPdaLaunchpadAuth(c.LAUNCHLAB).publicKey,
      l.global, t.platform, l.pool, a.policyBaseVault, a.policyQuoteVault,
      sdk.getPdaLaunchpadVaultId(c.LAUNCHLAB, l.pool, base).publicKey,
      sdk.getPdaLaunchpadVaultId(c.LAUNCHLAB, l.pool, l.quote).publicKey,
      base, l.quote, spl.TOKEN_2022_PROGRAM_ID, spl.TOKEN_PROGRAM_ID,
      sdk.getPdaPlatformVault(c.LAUNCHLAB, t.platform, l.quote).publicKey,
      sdk.getPdaCreatorVault(c.LAUNCHLAB, t.admin.publicKey, l.quote).publicKey,
      new BN(String(amount)), new BN(String(minimum)), new BN(0));
    return p.buyback(t.program, overrides.operator || t.operator.publicKey, base, l.quote, spl.TOKEN_PROGRAM_ID,
      swap, {amount, minOut: minimum, deadline: overrides.deadline ?? t.svm.getClock().unixTimestamp + 60n});
  }
  return {t, market, l, base, userBase, a, initialize, state, buy};
}
test('real LaunchLab buyback preserves prize reserves, isolates tax tokens and burns only acquired tokens', () => {
  const {t, l, base, userBase, a, initialize, state, buy} = fixture();
  t.send([initialize], [t.operator], false);
  t.send([spl.createTransferCheckedInstruction(userBase, base, a.policyBaseVault, t.admin.publicKey,
    1000000n, 6, [], spl.TOKEN_2022_PROGRAM_ID)]);
  const donated = t.balance(a.policyBaseVault, spl.TOKEN_2022_PROGRAM_ID);
  const reserve = 100000000n;
  t.send([p.reservePrize(t.program, t.operator.publicKey, base, l.quote, spl.TOKEN_PROGRAM_ID, reserve)], [t.operator]);
  const before = t.launchState(base), taxBefore = t.balance(l.a.baseVault, spl.TOKEN_2022_PROGRAM_ID);
  t.send([buy()], [t.operator]);
  const s = state(); assert(s.basePending > 0n); assert.equal(s.baseBought, s.basePending);
  assert.equal(s.holderQuoteSpent, 100000000n); assert.equal(s.prizeQuoteAvailable, reserve);
  assert.equal(t.launchState(base).holderAvailable, before.holderAvailable - 100000000n);
  assert.equal(t.launchState(base).platformAvailable, before.platformAvailable);
  assert.equal(t.balance(a.policyQuoteVault), reserve);
  assert.equal(t.balance(a.policyBaseVault, spl.TOKEN_2022_PROGRAM_ID), donated + s.basePending);
  t.send([p.burn(t.program, t.operator.publicKey, base, s.basePending + 1n)], [t.operator], false);
  const supply = spl.MintLayout.decode(Buffer.from(t.get(base).data).subarray(0, spl.MINT_SIZE)).supply;
  t.send([p.burn(t.program, t.operator.publicKey, base, s.basePending)], [t.operator]);
  assert.equal(state().basePending, 0n); assert.equal(state().baseBurned, s.basePending);
  assert.equal(t.balance(a.policyBaseVault, spl.TOKEN_2022_PROGRAM_ID), donated);
  assert.equal(t.balance(l.a.baseVault, spl.TOKEN_2022_PROGRAM_ID), taxBefore);
  assert.equal(spl.MintLayout.decode(Buffer.from(t.get(base).data).subarray(0, spl.MINT_SIZE)).supply, supply - s.basePending);
  t.send([p.burn(t.program, t.operator.publicKey, base, 1n)], [t.operator], false);
});
test('buyback rejects changed CA/vault, expired bounds, excess budget, bad slippage and unauthorized operator atomically', () => {
  const {t, l, base, a, buy} = fixture();
  const other = t.launch(); t.send([other.instruction], [t.admin, other.mint]);
  t.send([p.initialize(t.program, t.operator.publicKey, other.mint.publicKey, other.quote)], [t.operator]);
  const otherA = p.addresses(t.program, other.mint.publicKey, other.quote);
  const beforeLaunch = Buffer.from(t.get(l.a.launch).data), beforePolicy = Buffer.from(t.get(a.policy).data);
  const checks = [buy(750000001n), buy(100000000n, {minOut: 0xffffffffffffffffn}),
    buy(100000000n, {deadline: t.svm.getClock().unixTimestamp + 301n})];
  for (const [index, address] of [[3,otherA.policy],[7,otherA.policyBaseVault],[8,otherA.policyQuoteVault],
    [11,otherA.policy],[11+4,other.pool]]) {
    const ix = buy(); ix.keys[index].pubkey = address; checks.push(ix);
  }
  for (const ix of checks) {t.send([ix], [t.operator], false);
    assert(Buffer.from(t.get(l.a.launch).data).equals(beforeLaunch)); assert(Buffer.from(t.get(a.policy).data).equals(beforePolicy));}
  t.send([buy(100000000n, {operator: t.admin.publicKey})], [t.admin], false);
  t.send([t.controls(true)]); t.send([buy()], [t.operator], false);
});
test('reserved platform prize survives platform withdrawal and buys MOONZ only for the original creator', () => {
  const {t, l, base, a, state, market} = fixture(), reserve = 100000000n;
  const holder = t.launchState(base).holderAvailable;
  t.send([p.reservePrize(t.program, t.operator.publicKey, base, l.quote, spl.TOKEN_PROGRAM_ID, 250000001n)], [t.operator], false);
  t.send([p.reservePrize(t.program, t.operator.publicKey, base, l.quote, spl.TOKEN_PROGRAM_ID, reserve)], [t.operator]);
  t.send([c.payPlatform(t.program, t.operator.publicKey, base, l.quote, spl.TOKEN_PROGRAM_ID,
    t.fee.publicKey, t.launchState(base).platformAvailable)], [t.operator]);
  assert.equal(t.balance(a.policyQuoteVault), reserve); assert.equal(t.launchState(base).holderAvailable, holder);
  const creatorAta = spl.getAssociatedTokenAddressSync(r.MOONZ, t.admin.publicKey);
  const otherAta = spl.getAssociatedTokenAddressSync(r.MOONZ, t.operator.publicKey);
  for (const [owner, ata] of [[t.admin.publicKey,creatorAta],[t.operator.publicKey,otherAta]])
    t.send([spl.createAssociatedTokenAccountIdempotentInstruction(t.admin.publicKey, ata, owner, r.MOONZ)]);
  const request = {amount: reserve, minMoonzOut: 1n, deadline: t.svm.getClock().unixTimestamp + 60n,
    creator: t.admin.publicKey, marketCreator: market.creator, marketQuote: market.quote};
  const make = overrides => p.payPrize(t.program, t.operator.publicKey, base, l.quote, spl.TOKEN_PROGRAM_ID, {...request, ...overrides});
  t.send([make({creator: t.operator.publicKey})], [t.operator], false);
  t.send([make({minMoonzOut: 0xffffffffffffffffn})], [t.operator], false);
  assert.equal(t.balance(a.policyQuoteVault), reserve);
  const before = t.balance(creatorAta); t.send([make()], [t.operator]);
  const paid = t.balance(creatorAta) - before; assert(paid > 0n);
  assert.equal(state().prizeMoonzPaid, paid); assert.equal(state().prizeQuoteAvailable, 0n);
  assert.equal(state().prizeQuoteSpent, reserve); assert.equal(state().prizeQuoteReserved, reserve);
  assert.equal(t.launchState(base).holderAvailable, holder); assert.equal(t.balance(a.policyMoonzVault), 0n);
  t.send([make()], [t.operator], false);
});
test('real CPMM reverse buyback uses the policy pair input and net Token2022 output', () => {
  const {t, l, base, userBase, a, state} = fixture(), quote = l.quote, owner = t.admin.publicKey;
  const ordered = [base, quote].sort((x,y) => Buffer.compare(x.toBuffer(),y.toBuffer())), baseFirst = ordered[0].equals(base);
  const keys = sdk.getCreatePoolKeys({programId:c.CPMM, configId:t.cpConfig, mintA:ordered[0], mintB:ordered[1]});
  const userQuote = spl.getAssociatedTokenAddressSync(quote, owner), userLp = spl.getAssociatedTokenAddressSync(keys.lpMint,owner);
  const baseAmount = t.balance(userBase,spl.TOKEN_2022_PROGRAM_ID)/2n, quoteAmount = 1000000000n;
  t.send([SystemProgram.transfer({fromPubkey:owner,toPubkey:userQuote,lamports:quoteAmount}),spl.createSyncNativeInstruction(userQuote),
    sdk.makeCreateCpmmPoolInInstruction(c.CPMM,owner,t.cpConfig,keys.authority,keys.poolId,ordered[0],ordered[1],keys.lpMint,
      baseFirst?userBase:userQuote,baseFirst?userQuote:userBase,userLp,keys.vaultA,keys.vaultB,sdk.CREATE_CPMM_POOL_FEE_ACC,
      baseFirst?spl.TOKEN_2022_PROGRAM_ID:spl.TOKEN_PROGRAM_ID,baseFirst?spl.TOKEN_PROGRAM_ID:spl.TOKEN_2022_PROGRAM_ID,
      keys.observationId,new BN(String(baseFirst?baseAmount:quoteAmount)),new BN(String(baseFirst?quoteAmount:baseAmount)),new BN(0))]);
  const clock=t.svm.getClock();t.svm.setClock(new Clock(clock.slot,clock.epochStartTimestamp,clock.epoch,clock.leaderScheduleEpoch,clock.unixTimestamp+5n));
  const amount=10000000n;
  const swap=sdk.makeSwapCpmmBaseInInstruction(c.CPMM,a.policy,keys.authority,t.cpConfig,keys.poolId,a.policyQuoteVault,a.policyBaseVault,
    baseFirst?keys.vaultB:keys.vaultA,baseFirst?keys.vaultA:keys.vaultB,spl.TOKEN_PROGRAM_ID,spl.TOKEN_2022_PROGRAM_ID,
    quote,base,keys.observationId,new BN(String(amount)),new BN(1));
  const ix=p.buyback(t.program,t.operator.publicKey,base,quote,spl.TOKEN_PROGRAM_ID,swap,
    {amount,minOut:1n,deadline:t.svm.getClock().unixTimestamp+60n});
  const before=t.launchState(base);t.send([ix],[t.operator]);
  assert(state().basePending>0n);assert.equal(state().holderQuoteSpent,amount);
  assert.equal(t.balance(a.policyBaseVault,spl.TOKEN_2022_PROGRAM_ID),state().basePending);
  assert.equal(t.launchState(base).holderAvailable,before.holderAvailable-amount);
  assert.equal(t.launchState(base).platformAvailable,before.platformAvailable);
});
test('MOONZ-paired creator prize transfers only the reserved MOONZ with no market CPI or second split', () => {
  const {t, l, base} = fixture();
  // Fixture-only supported quote selection: the base is the real fixed-tax mint.
  // Seed a v2 MOONZ-paired launch; live launch state cannot be edited this way.
  const info=t.get(l.a.launch), data=Buffer.from(info.data);
  r.MOONZ.toBuffer().copy(data,33);data.fill(0,161);
  t.set(l.a.launch,t.program,data,info.lamports);
  const a=p.addresses(t.program,base,r.MOONZ), creatorAta=spl.getAssociatedTokenAddressSync(r.MOONZ,t.admin.publicKey);
  for (const [owner,address] of [[a.launch,a.quoteVault],[t.admin.publicKey,creatorAta]])
    t.send([spl.createAssociatedTokenAccountIdempotentInstruction(t.admin.publicKey,address,owner,r.MOONZ)]);
  const vault=t.get(a.quoteVault), bytes=Buffer.from(vault.data);bytes.writeBigUInt64LE(4000000n,64);
  t.set(a.quoteVault,spl.TOKEN_PROGRAM_ID,bytes,vault.lamports);
  t.send([c.creditDonation(t.program,t.operator.publicKey,base,r.MOONZ,spl.TOKEN_PROGRAM_ID)],[t.operator]);
  t.send([p.reservePrize(t.program,t.operator.publicKey,base,r.MOONZ,spl.TOKEN_PROGRAM_ID,1000000n)],[t.operator]);
  const before=t.balance(creatorAta);
  t.send([p.payPrize(t.program,t.operator.publicKey,base,r.MOONZ,spl.TOKEN_PROGRAM_ID,
    {amount:1000000n,minMoonzOut:1000000n,deadline:t.svm.getClock().unixTimestamp+60n,creator:t.admin.publicKey})],[t.operator]);
  assert.equal(t.balance(creatorAta)-before,1000000n);assert.equal(t.launchState(base).holderAvailable,3000000n);
  assert.equal(p.decodePolicy(t.get(a.policy).data).prizeMoonzPaid,1000000n);
});
test('unused prize reserves return only to the platform budget without changing holder balances or credited fees', () => {
  const {t, l, base, a, state} = fixture();
  const before = t.launchState(base);
  t.send([p.reservePrize(t.program, t.operator.publicKey, base, l.quote, spl.TOKEN_PROGRAM_ID, 100000000n)], [t.operator]);
  const release = amount => p.releasePrize(t.program, t.operator.publicKey, base, l.quote, spl.TOKEN_PROGRAM_ID, amount);
  t.send([release(100000001n)], [t.operator], false);
  t.send([release(60000000n)], [t.operator]);
  const after = t.launchState(base);
  assert.equal(after.holderAvailable, before.holderAvailable);
  assert.equal(after.credited, before.credited);
  assert.equal(after.platformAvailable, before.platformAvailable - 40000000n);
  assert.equal(after.paidPlatform, before.paidPlatform + 40000000n);
  assert.equal(state().prizeQuoteReleased, 60000000n);
  assert.equal(state().prizeQuoteAvailable, 40000000n);
  assert.equal(t.balance(a.policyQuoteVault), 40000000n);
});
