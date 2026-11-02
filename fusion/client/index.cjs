"use strict";
const {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
} = require("@solana/web3.js");
const spl = require("@solana/spl-token");
const { createHash } = require("node:crypto");
const LAUNCHLAB = new PublicKey("LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj");
const CPMM = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const pk = (v) => (v instanceof PublicKey ? v : new PublicKey(v));
function uint(value, bytes) {
  if (typeof value === "number" && !Number.isSafeInteger(value))
    throw new Error("Use BigInt or decimal strings for raw amounts");
  const n = BigInt(value);
  if (n < 0n || n >= 1n << BigInt(bytes * 8))
    throw new Error("Unsigned integer out of range");
  const b = Buffer.alloc(bytes);
  if (bytes === 8) b.writeBigUInt64LE(n);
  else b.writeUIntLE(Number(n), 0, bytes);
  return b;
}
const u64 = (v) => uint(v, 8),
  u32 = (v) => uint(v, 4);
function bytes32(v) {
  const b = Buffer.from(v);
  if (b.length !== 32) throw new Error("Expected 32 bytes");
  return b;
}
function addresses(program, base, quote, quoteProgram = spl.TOKEN_PROGRAM_ID) {
  program = pk(program);
  const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, program)[0];
  const config = pda(Buffer.from("config")),
    taxAuthority = pda(Buffer.from("tax-authority"));
  if (!base)
    return {
      config,
      taxAuthority,
      programData: PublicKey.findProgramAddressSync(
        [program.toBuffer()],
        LOADER,
      )[0],
    };
  base = pk(base);
  const launch = pda(Buffer.from("launch"), base.toBuffer());
  return {
    config,
    taxAuthority,
    launch,
    baseVault: spl.getAssociatedTokenAddressSync(
      base,
      launch,
      true,
      spl.TOKEN_2022_PROGRAM_ID,
    ),
    ...(quote
      ? {
          quoteVault: spl.getAssociatedTokenAddressSync(
            pk(quote),
            launch,
            true,
            pk(quoteProgram),
          ),
        }
      : {}),
    unwrap: pda(Buffer.from("unwrap"), launch.toBuffer()),
  };
}
const meta = (pubkey, w = false, s = false) => ({
  pubkey: pk(pubkey),
  isWritable: w,
  isSigner: s,
});
const ix = (program, keys, tag, ...parts) =>
  new TransactionInstruction({
    programId: pk(program),
    keys,
    data: Buffer.concat([Buffer.from([tag]), ...parts]),
  });
function initialize(
  program,
  admin,
  { operator, feeWallet, platform, cpConfig, maxSwapRaw },
) {
  const a = addresses(program);
  return ix(
    program,
    [
      meta(admin, true, true),
      meta(a.config, true),
      meta(a.programData),
      meta(SystemProgram.programId),
    ],
    0,
    pk(operator).toBuffer(),
    pk(feeWallet).toBuffer(),
    pk(platform).toBuffer(),
    pk(cpConfig).toBuffer(),
    u64(maxSwapRaw),
  );
}
function controls(program, admin, { operator, maxSwapRaw, paused }) {
  if (typeof paused !== "boolean") throw new Error("paused must be boolean");
  return ix(
    program,
    [meta(admin, false, true), meta(addresses(program).config, true)],
    1,
    pk(operator).toBuffer(),
    u64(maxSwapRaw),
    Buffer.from([Number(paused)]),
  );
}
const proposeAdmin = (program, admin, next) =>
  ix(
    program,
    [meta(admin, false, true), meta(addresses(program).config, true)],
    2,
    pk(next).toBuffer(),
  );
const acceptAdmin = (program, next) =>
  ix(
    program,
    [meta(next, false, true), meta(addresses(program).config, true)],
    3,
  );
function launch(program, payer, raydiumInstruction) {
  const r = raydiumInstruction;
  if (
    !r.programId.equals(LAUNCHLAB) ||
    r.keys.length < 15 ||
    r.keys.length > 17 ||
    !r.keys[0].pubkey.equals(pk(payer)) ||
    !r.keys[1].pubkey.equals(pk(payer))
  )
    throw new Error("Unexpected Raydium launch");
  const a = addresses(
    program,
    r.keys[6].pubkey,
    r.keys[7].pubkey,
    r.keys[11].pubkey,
  );
  return ix(
    program,
    [
      meta(payer, true, true),
      meta(a.config),
      meta(a.launch, true),
      meta(a.baseVault, true),
      meta(a.quoteVault, true),
      meta(spl.ASSOCIATED_TOKEN_PROGRAM_ID),
      meta(a.taxAuthority),
      ...r.keys,
    ],
    4,
    u32(r.data.length),
    r.data,
  );
}
function collect(program, operator, base, sources = []) {
  if (
    sources.length > 16 ||
    new Set(sources.map((x) => pk(x).toBase58())).size !== sources.length
  )
    throw new Error("At most 16 unique tax accounts");
  const a = addresses(program, base);
  return ix(
    program,
    [
      meta(operator, false, true),
      meta(a.config),
      meta(a.launch),
      meta(base, true),
      meta(a.baseVault, true),
      meta(a.taxAuthority),
      meta(spl.TOKEN_2022_PROGRAM_ID),
      ...sources.map((x) => meta(x, true)),
    ],
    5,
  );
}
function convert(
  program,
  operator,
  base,
  quote,
  quoteProgram,
  swap,
  { amount, minOut, deadline },
) {
  const a = addresses(program, base, quote, quoteProgram),
    route = swap.programId.equals(LAUNCHLAB)
      ? 0
      : swap.programId.equals(CPMM)
        ? 1
        : -1;
  if (route < 0 || !swap.keys[0].pubkey.equals(a.launch))
    throw new Error("Swap must use this launch PDA");
  const expected = Buffer.concat([
    Buffer.from(
      route === 0
        ? [149, 39, 222, 155, 211, 124, 152, 26]
        : [143, 190, 90, 218, 196, 30, 51, 222],
    ),
    u64(amount),
    u64(minOut),
    ...(route === 0 ? [u64(0)] : []),
  ]);
  if (!expected.equals(swap.data))
    throw new Error("Swap amounts or instruction mismatch");
  const routeKeys = swap.keys.map((k) => ({ ...k, isSigner: false }));
  if (route === 1) routeKeys.push(meta(CPMM));
  return ix(
    program,
    [
      meta(operator, false, true),
      meta(a.config),
      meta(a.launch, true),
      meta(base),
      meta(quote),
      meta(a.baseVault, true),
      meta(a.quoteVault, true),
      ...routeKeys,
    ],
    6,
    Buffer.from([route]),
    u64(amount),
    u64(minOut),
    u64(deadline),
  );
}
function openRound(program, operator, base, { root, total, leaves, deadline }) {
  if (leaves < 1 || leaves > 1024)
    throw new Error("Round supports 1–1024 leaves");
  const a = addresses(program, base);
  return ix(
    program,
    [meta(operator, false, true), meta(a.config), meta(a.launch, true)],
    7,
    bytes32(root),
    u64(total),
    u32(leaves),
    u64(deadline),
  );
}
function paymentKeys(program, payer, base, quote, quoteProgram, recipient) {
  const a = addresses(program, base, quote, quoteProgram);
  quote = pk(quote);
  quoteProgram = pk(quoteProgram);
  recipient = pk(recipient);
  if (!PublicKey.isOnCurve(recipient.toBytes()))
    throw new Error("Payout recipient must be an on-curve wallet");
  const native = quote.equals(spl.NATIVE_MINT);
  const destination = native
    ? recipient
    : spl.getAssociatedTokenAddressSync(quote, recipient, false, quoteProgram);
  return [
    meta(payer, true, true),
    meta(a.config),
    meta(a.launch, true),
    meta(quote),
    meta(a.quoteVault, true),
    meta(recipient, native),
    meta(destination, true),
    meta(quoteProgram),
    meta(SystemProgram.programId),
    meta(a.unwrap, true),
  ];
}
function pay(
  program,
  payer,
  base,
  quote,
  quoteProgram,
  { recipient, round, index, amount, proof },
) {
  if (proof.length > 10) throw new Error("Proof too long");
  return ix(
    program,
    paymentKeys(program, payer, base, quote, quoteProgram, recipient),
    8,
    u64(round),
    u32(index),
    u64(amount),
    u32(proof.length),
    ...proof.map(bytes32),
  );
}
const closeRound = (program, base) =>
  ix(program, [meta(addresses(program, base).launch, true)], 9);
const payPlatform = (
  program,
  payer,
  base,
  quote,
  quoteProgram,
  feeWallet,
  amount,
) =>
  ix(
    program,
    paymentKeys(program, payer, base, quote, quoteProgram, feeWallet),
    10,
    u64(amount),
  );
function creditDonation(program, operator, base, quote, quoteProgram) {
  const a = addresses(program, base, quote, quoteProgram);
  return ix(
    program,
    [
      meta(operator, false, true),
      meta(a.config),
      meta(a.launch, true),
      meta(quote),
      meta(a.quoteVault),
    ],
    11,
  );
}
const hash = (...parts) =>
  createHash("sha256").update(Buffer.concat(parts)).digest();
const leaf = (program, launch, round, index, wallet, amount) =>
  hash(
    Buffer.from("MOONZ_FUSION_HOLDER_V1"),
    pk(program).toBuffer(),
    pk(launch).toBuffer(),
    u64(round),
    u32(index),
    pk(wallet).toBuffer(),
    u64(amount),
  );
const parent = (a, b) =>
  hash(
    Buffer.from("MOONZ_FUSION_NODE_V1"),
    ...(Buffer.compare(a, b) <= 0 ? [a, b] : [b, a]),
  );
function merkleRound(program, base, round, payments) {
  if (!payments.length || payments.length > 1024)
    throw new Error("Split into rounds of at most 1024 recipients");
  const launch = addresses(program, base).launch,
    wallets = new Set();
  let total = 0n;
  const entries = payments.map((p, index) => {
    const recipient = pk(p.recipient),
      amount = BigInt(p.amount);
    u64(amount);
    if (
      amount === 0n ||
      !PublicKey.isOnCurve(recipient.toBytes()) ||
      wallets.has(recipient.toBase58())
    )
      throw new Error("Invalid or duplicate recipient");
    wallets.add(recipient.toBase58());
    total += amount;
    u64(total);
    return { recipient, amount, round: BigInt(round), index, proof: [] };
  });
  let layer = entries.map((e) => ({
    hash: leaf(program, launch, round, e.index, e.recipient, e.amount),
    members: [e.index],
  }));
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i],
        right = layer[i + 1];
      if (!right) {
        next.push(left);
        continue;
      }
      for (const n of left.members) entries[n].proof.push(right.hash);
      for (const n of right.members) entries[n].proof.push(left.hash);
      next.push({
        hash: parent(left.hash, right.hash),
        members: [...left.members, ...right.members],
      });
    }
    layer = next;
  }
  return { root: layer[0].hash, total, leaves: entries.length, entries };
}
function decoder(data, length) {
  data = Buffer.from(data);
  if (data.length !== length || data[0] !== 1)
    throw new Error("Unsupported Fusion state");
  let i = 1;
  return {
    key: () => {
      const p = new PublicKey(data.subarray(i, i + 32));
      i += 32;
      return p;
    },
    num: () => {
      const n = data.readBigUInt64LE(i);
      i += 8;
      return n;
    },
    bytes: (n) => {
      const b = data.subarray(i, i + n);
      i += n;
      return b;
    },
  };
}
function decodeConfig(data) {
  const r = decoder(data, 202);
  const cfg = {
    admin: r.key(),
    pendingAdmin: r.key(),
    operator: r.key(),
    feeWallet: r.key(),
    platform: r.key(),
    cpConfig: r.key(),
    maxSwapRaw: r.num(),
  };
  const flag = r.bytes(1)[0];
  if (flag > 1) throw new Error("Invalid pause flag");
  return { ...cfg, paused: !!flag };
}
function decodeLaunch(data) {
  const r = decoder(data, 393);
  return {
    base: r.key(),
    quote: r.key(),
    quoteProgram: r.key(),
    creator: r.key(),
    pool: r.key(),
    holderAvailable: r.num(),
    platformAvailable: r.num(),
    credited: r.num(),
    paidHolders: r.num(),
    paidPlatform: r.num(),
    round: r.num(),
    remaining: r.num(),
    deadline: r.num(),
    leaves: r.num(),
    root: r.bytes(32),
    bitmap: r.bytes(128),
  };
}
module.exports = {
  LAUNCHLAB,
  CPMM,
  LOADER,
  addresses,
  initialize,
  controls,
  proposeAdmin,
  acceptAdmin,
  launch,
  collect,
  convert,
  openRound,
  pay,
  closeRound,
  payPlatform,
  creditDonation,
  merkleRound,
  leaf,
  parent,
  decodeConfig,
  decodeLaunch,
};
