"use strict";
const {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
} = require("@solana/web3.js");
const spl = require("@solana/spl-token"),
  c = require("./index.cjs");
const MOONZ = new PublicKey("DfUWVvq1NDip9EQT9RreVDTQL3kArLJkwq7e9LXZEfkh");
const OG = new PublicKey("DBc9SEQghiJUj52YPqTKk8R4CMRgagBxi2LU1yBbeMpk");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const OG_FEES = new PublicKey("3mTCqBzGWMkUHqp3Ysepj3oewaMw6ndGQ368gEnxv1uH");
const JUPITER = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const pk = (x) => new PublicKey(x);
const meta = (key, w = false, s = false) => ({
  pubkey: pk(key),
  isWritable: w,
  isSigner: s,
});
function uint(value, n = 8) {
  if (typeof value === "number" && !Number.isSafeInteger(value))
    throw Error("Use exact raw amounts");
  const x = BigInt(value);
  if (x < 0n || x >= 1n << BigInt(n * 8)) throw Error("Integer out of bounds");
  const b = Buffer.alloc(n);
  if (n === 8) b.writeBigUInt64LE(x);
  else b.writeUInt32LE(Number(x));
  return b;
}
const ix = (program, keys, tag, ...data) =>
  new TransactionInstruction({
    programId: pk(program),
    keys,
    data: Buffer.concat([Buffer.from([tag]), ...data]),
  });
const ata = (mint, owner, token = spl.TOKEN_PROGRAM_ID) =>
  spl.getAssociatedTokenAddressSync(pk(mint), pk(owner), true, pk(token));
function addresses(
  program,
  base,
  quote,
  quoteProgram = spl.TOKEN_PROGRAM_ID,
  marketQuote = spl.NATIVE_MINT,
) {
  const a = c.addresses(program, base, quote, quoteProgram),
    rewards = PublicKey.findProgramAddressSync(
      [Buffer.from("rewards"), a.launch.toBuffer()],
      pk(program),
    )[0];
  return {
    ...a,
    rewards,
    moonzVault: ata(MOONZ, rewards),
    sourceEscrow: quote ? ata(quote, rewards, quoteProgram) : null,
    bridgeVault: ata(marketQuote, rewards),
  };
}
function market(creator, quote = spl.NATIVE_MINT) {
  quote = pk(quote);
  if (!quote.equals(spl.NATIVE_MINT) && !quote.equals(USDC))
    throw Error("Unsupported MOONZ market quote");
  const pda = (s, k = MOONZ) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from(s), pk(k).toBuffer()],
        OG,
      )[0],
    authority = pda("creator_fees", creator);
  return {
    state: pda("launch_state"),
    saleVault: pda("sale_vault"),
    lpVault: pda("lp_vault"),
    treasury: pda(quote.equals(USDC) ? "treasury_usdc" : "treasury_wsol"),
    creatorAuthority: authority,
    creatorFeeVault: ata(quote, authority),
    platformFeeVault: ata(quote, OG_FEES),
    quote,
  };
}
function initialize(program, operator, base) {
  const a = addresses(program, base);
  return ix(
    program,
    [
      meta(operator, true, true),
      meta(a.config),
      meta(a.launch),
      meta(a.rewards, true),
      meta(MOONZ),
      meta(a.moonzVault, true),
      meta(spl.TOKEN_PROGRAM_ID),
      meta(spl.ASSOCIATED_TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
    ],
    12,
  );
}
function buy(
  program,
  operator,
  base,
  quote,
  quoteProgram,
  {
    amount,
    minMoonzOut,
    deadline,
    creator,
    marketQuote = spl.NATIVE_MINT,
    minBridgeOut = 0n,
    bridge = null,
  },
) {
  quote = pk(quote);
  const a = addresses(program, base, quote, quoteProgram, marketQuote);
  const keys = [
    meta(operator, true, true),
    meta(a.config),
    meta(a.launch, true),
    meta(a.rewards, true),
    meta(quote),
    meta(a.quoteVault, true),
    meta(MOONZ),
    meta(a.moonzVault, true),
    meta(a.sourceEscrow, true),
    meta(marketQuote),
    meta(a.bridgeVault, true),
    meta(quoteProgram),
    meta(spl.TOKEN_PROGRAM_ID),
    meta(spl.ASSOCIATED_TOKEN_PROGRAM_ID),
    meta(SystemProgram.programId),
  ];
  if (!quote.equals(MOONZ)) {
    const m = market(creator, marketQuote);
    keys.push(
      meta(OG),
      meta(m.state, true),
      meta(m.saleVault, true),
      meta(m.lpVault, true),
      meta(m.treasury, true),
      meta(m.creatorAuthority),
      meta(m.creatorFeeVault, true),
      meta(m.platformFeeVault, true),
    );
  }
  if (bridge) {
    if (
      !bridge.programId.equals(JUPITER) ||
      quote.equals(MOONZ) ||
      quote.equals(pk(marketQuote))
    )
      throw Error("Invalid bridge");
    keys.push(
      meta(JUPITER),
      ...bridge.keys.map((k) => {
        if (k.isSigner && !k.pubkey.equals(a.rewards))
          throw Error("Unexpected bridge signer");
        return { ...k, isSigner: false };
      }),
    );
  } else if (!quote.equals(MOONZ) && !quote.equals(pk(marketQuote)))
    throw Error("Paired asset requires an exact-in bridge");
  const data = bridge ? Buffer.from(bridge.data) : Buffer.alloc(0);
  if (data.length > 900) throw Error("Bridge too large");
  return ix(
    program,
    keys,
    13,
    uint(amount),
    uint(minBridgeOut),
    uint(minMoonzOut),
    uint(deadline),
    uint(data.length, 4),
    data,
  );
}
function openRound(program, operator, base, { root, total, leaves, deadline }) {
  root = Buffer.from(root);
  if (root.length !== 32 || leaves < 1 || leaves > 1024)
    throw Error("Invalid round");
  const a = addresses(program, base);
  return ix(
    program,
    [
      meta(operator, false, true),
      meta(a.config),
      meta(a.launch),
      meta(a.rewards, true),
    ],
    14,
    root,
    uint(total),
    uint(leaves, 4),
    uint(deadline),
  );
}
function pay(program, base, { recipient, round, index, amount, proof }) {
  if (proof.length > 10 || !PublicKey.isOnCurve(pk(recipient).toBytes()))
    throw Error("Invalid payout");
  const a = addresses(program, base);
  return ix(
    program,
    [
      meta(a.config),
      meta(a.launch),
      meta(a.rewards, true),
      meta(MOONZ),
      meta(a.moonzVault, true),
      meta(recipient),
      meta(ata(MOONZ, recipient), true),
      meta(spl.TOKEN_PROGRAM_ID),
    ],
    15,
    uint(round),
    uint(index, 4),
    uint(amount),
    uint(proof.length, 4),
    ...proof.map((x) => {
      const b = Buffer.from(x);
      if (b.length !== 32) throw Error("Invalid proof");
      return b;
    }),
  );
}
function closeRound(program, base) {
  const a = addresses(program, base);
  return ix(program, [meta(a.launch), meta(a.rewards, true)], 16);
}
function merkleRound(program, base, round, payments) {
  return c.merkleRound(
    program,
    base,
    round,
    payments,
    addresses(program, base).rewards,
  );
}
function decodeRewards(input) {
  const d = Buffer.from(input);
  if (d.length !== 257 || d[0] !== 1) throw Error("Invalid rewards state");
  let i = 33;
  const r = { launch: new PublicKey(d.subarray(1, 33)) };
  for (const key of [
    "available",
    "credited",
    "paid",
    "quoteSpent",
    "round",
    "remaining",
    "deadline",
    "leaves",
  ]) {
    r[key] = d.readBigUInt64LE(i);
    i += 8;
  }
  r.root = d.subarray(i, i + 32);
  r.bitmap = d.subarray(i + 32);
  return r;
}
module.exports = {
  MOONZ,
  OG,
  USDC,
  OG_FEES,
  JUPITER,
  addresses,
  market,
  initialize,
  buy,
  openRound,
  pay,
  closeRound,
  merkleRound,
  decodeRewards,
};
