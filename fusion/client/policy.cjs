'use strict';
const {PublicKey, TransactionInstruction, SystemProgram} = require('@solana/web3.js');
const spl = require('@solana/spl-token'), c = require('./index.cjs'), r = require('./rewards.cjs');
const pk = x => new PublicKey(x);
const meta = (key, isWritable = false, isSigner = false) => ({pubkey: pk(key), isWritable, isSigner});
const uint = value => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw Error('Use exact raw amounts');
  const n = BigInt(value); if (n < 0n || n >= 1n << 64n) throw Error('Integer out of bounds');
  const data = Buffer.alloc(8); data.writeBigUInt64LE(n); return data;
};
const ix = (program, keys, tag, ...data) => new TransactionInstruction({programId: pk(program), keys,
  data: Buffer.concat([Buffer.from([tag]), ...data])});
const ata = (mint, owner, token = spl.TOKEN_PROGRAM_ID) => spl.getAssociatedTokenAddressSync(pk(mint), pk(owner), true, pk(token));
const POLICY_LEN = 113;
function addresses(program, base, quote, quoteProgram = spl.TOKEN_PROGRAM_ID) {
  const a = c.addresses(program, base, quote, quoteProgram);
  const policy = PublicKey.findProgramAddressSync([Buffer.from('policy'), a.launch.toBuffer()], pk(program))[0];
  return {...a, policy, policyBaseVault: ata(base, policy, spl.TOKEN_2022_PROGRAM_ID),
    policyQuoteVault: quote ? ata(quote, policy, quoteProgram) : null, policyMoonzVault: ata(r.MOONZ, policy)};
}
function initialize(program, operator, base, quote, quoteProgram = spl.TOKEN_PROGRAM_ID) {
  const a = addresses(program, base, quote, quoteProgram);
  return ix(program, [meta(operator, true, true), meta(a.config), meta(a.launch), meta(a.policy, true),
    meta(base), meta(a.policyBaseVault, true), meta(quote), meta(a.policyQuoteVault, true), meta(r.MOONZ),
    meta(a.policyMoonzVault, true), meta(spl.TOKEN_2022_PROGRAM_ID), meta(quoteProgram), meta(spl.TOKEN_PROGRAM_ID),
    meta(spl.ASSOCIATED_TOKEN_PROGRAM_ID), meta(SystemProgram.programId)], 18);
}
function buyback(program, operator, base, quote, quoteProgram, swap, {amount, minOut, deadline}) {
  const a = addresses(program, base, quote, quoteProgram);
  const route = swap.programId.equals(c.LAUNCHLAB) ? 0 : swap.programId.equals(c.CPMM) ? 1 : -1;
  if (route < 0 || !swap.keys[0]?.pubkey.equals(a.policy) || swap.keys.some(k => k.isSigner && !k.pubkey.equals(a.policy)))
    throw Error('Buyback must use this policy PDA');
  const expected = Buffer.concat([Buffer.from(route === 0 ? [250,234,13,123,213,156,19,236] : [143,190,90,218,196,30,51,222]),
    uint(amount), uint(minOut), ...(route === 0 ? [uint(0)] : [])]);
  if (!expected.equals(swap.data)) throw Error('Buyback amounts or instruction mismatch');
  const routeKeys = swap.keys.map(k => ({...k, isSigner: false}));
  if (route === 1) routeKeys.push(meta(c.CPMM));
  return ix(program, [meta(operator, false, true), meta(a.config), meta(a.launch, true), meta(a.policy, true),
    meta(base), meta(quote), meta(a.quoteVault, true), meta(a.policyBaseVault, true), meta(a.policyQuoteVault, true),
    meta(spl.TOKEN_2022_PROGRAM_ID), meta(quoteProgram), ...routeKeys], 19, Buffer.from([route]),
    uint(amount), uint(minOut), uint(deadline));
}
function burn(program, operator, base, amount) {
  const a = addresses(program, base);
  return ix(program, [meta(operator, false, true), meta(a.config), meta(a.launch), meta(a.policy, true),
    meta(base, true), meta(a.policyBaseVault, true), meta(spl.TOKEN_2022_PROGRAM_ID)], 20, uint(amount));
}
function reservePrize(program, operator, base, quote, quoteProgram, amount) {
  const a = addresses(program, base, quote, quoteProgram);
  return ix(program, [meta(operator, false, true), meta(a.config), meta(a.launch, true), meta(a.policy, true),
    meta(quote), meta(a.quoteVault, true), meta(a.policyQuoteVault, true), meta(quoteProgram)], 21, uint(amount));
}
function releasePrize(program, operator, base, quote, quoteProgram, amount) {
  const result = reservePrize(program, operator, base, quote, quoteProgram, amount);
  result.data[0] = 23; return result;
}
function payPrize(program, operator, base, quote, quoteProgram, {amount, minMoonzOut, deadline, creator,
  marketCreator, marketQuote = spl.NATIVE_MINT}) {
  quote = pk(quote);
  if (!pk(quoteProgram).equals(spl.TOKEN_PROGRAM_ID) || (!quote.equals(r.MOONZ) && !quote.equals(pk(marketQuote))))
    throw Error('Prize requires MOONZ or the current MOONZ market quote');
  const a = addresses(program, base, quote, quoteProgram);
  const original = r.buy(program, operator, base, quote, quoteProgram,
    {amount, minMoonzOut, deadline, creator: marketCreator, marketQuote});
  const keys = original.keys.map(k => ({...k}));
  keys[2].isWritable = false;
  keys[3] = meta(a.policy, true); keys[5] = meta(a.policyQuoteVault, true);
  keys[7] = meta(a.policyMoonzVault, true); keys[8] = meta(a.policyQuoteVault, true);
  keys[9] = meta(quote); keys[10] = meta(a.policyQuoteVault, true);
  keys.push(meta(creator), meta(ata(r.MOONZ, creator), true));
  return ix(program, keys, 22, uint(amount), uint(minMoonzOut), uint(deadline));
}
function decodePolicy(data) {
  const b = Buffer.from(data);
  if (b.length !== POLICY_LEN || b[0] !== 1) throw Error('Unsupported policy account');
  const result = {version: b[0], launch: new PublicKey(b.subarray(1,33))};
  ['basePending','baseBought','baseBurned','holderQuoteSpent','prizeQuoteAvailable','prizeQuoteReserved',
    'prizeQuoteSpent','prizeMoonzPaid','sequence','prizeQuoteReleased'].forEach((name, i) => {result[name] = b.readBigUInt64LE(33 + i * 8);});
  return result;
}
module.exports = {addresses, initialize, buyback, burn, reservePrize, payPrize, releasePrize, decodePolicy, POLICY_LEN};
