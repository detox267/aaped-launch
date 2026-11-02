const test = require("node:test"),
  assert = require("node:assert/strict");
const { Keypair, PublicKey } = require("@solana/web3.js"),
  spl = require("@solana/spl-token");
const c = require("../client/index.cjs");
const key = () => Keypair.generate().publicKey;
test("per-CA vaults remain separate for identical quote mints", () => {
  const program = key(),
    quote = key(),
    a = c.addresses(program, key(), quote),
    b = c.addresses(program, key(), quote);
  assert(!a.quoteVault.equals(b.quoteVault));
  assert(!PublicKey.isOnCurve(a.launch.toBytes()));
  assert(a.config.equals(b.config));
  assert(a.taxAuthority.equals(b.taxAuthority));
});
test("Merkle proofs bind program, CA, round, index, recipient and amount", () => {
  const program = key(),
    base = key(),
    round = c.merkleRound(program, base, 1, [
      { recipient: key(), amount: 1n },
      { recipient: key(), amount: 2n },
      { recipient: key(), amount: 3n },
    ]);
  assert.equal(round.total, 6n);
  for (const e of round.entries) {
    let node = c.leaf(
      program,
      c.addresses(program, base).launch,
      e.round,
      e.index,
      e.recipient,
      e.amount,
    );
    for (const p of e.proof) node = c.parent(node, p);
    assert.deepEqual(node, round.root);
  }
  const e = round.entries[0],
    launch = c.addresses(program, base).launch,
    valid = c.leaf(program, launch, 1, 0, e.recipient, 1);
  for (const args of [
    [key(), launch, 1, 0, e.recipient, 1],
    [program, key(), 1, 0, e.recipient, 1],
    [program, launch, 2, 0, e.recipient, 1],
    [program, launch, 1, 1, e.recipient, 1],
    [program, launch, 1, 0, key(), 1],
    [program, launch, 1, 0, e.recipient, 2],
  ])
    assert.notDeepEqual(c.leaf(...args), valid);
});
test("round builder rejects duplicate wallets, zero amounts, overflow and PDAs", () => {
  const program = key(),
    base = key(),
    wallet = key(),
    build = (entries) => c.merkleRound(program, base, 1, entries);
  assert.throws(() =>
    build([
      { recipient: wallet, amount: 1 },
      { recipient: wallet, amount: 2 },
    ]),
  );
  assert.throws(() => build([{ recipient: wallet, amount: 0 }]));
  assert.throws(() => build([{ recipient: wallet, amount: 2n ** 64n }]));
  assert.throws(() =>
    build([{ recipient: c.addresses(program, base).launch, amount: 1 }]),
  );
});
test("round size limit and odd-leaf proofs cover 1024 recipients", () => {
  const program = key(),
    base = key(),
    entries = Array.from({ length: 1024 }, () => ({
      recipient: key(),
      amount: 1,
    })),
    round = c.merkleRound(program, base, 9, entries);
  assert.equal(round.entries[1023].proof.length, 10);
  assert.throws(() =>
    c.merkleRound(program, base, 9, [
      ...entries,
      { recipient: key(), amount: 1 },
    ]),
  );
});
test("raw amount encoders reject lossy JavaScript numbers", () => {
  assert.throws(() =>
    c.initialize(key(), key(), {
      operator: key(),
      feeWallet: key(),
      platform: key(),
      cpConfig: key(),
      maxSwapRaw: Number.MAX_SAFE_INTEGER + 1,
    }),
  );
});
test("PDA payment instruction signs only with relayer", () => {
  const program = key(),
    base = key(),
    payer = key(),
    recipient = key(),
    quote = key();
  const r = c.merkleRound(program, base, 1, [{ recipient, amount: 100 }]);
  const ix = c.pay(
    program,
    payer,
    base,
    quote,
    spl.TOKEN_PROGRAM_ID,
    r.entries[0],
  );
  assert.deepEqual(
    ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58()),
    [payer.toBase58()],
  );
  assert(
    ix.keys[6].pubkey.equals(
      spl.getAssociatedTokenAddressSync(quote, recipient),
    ),
  );
});
