const test = require("node:test"),
  assert = require("node:assert/strict"),
  { Keypair } = require("@solana/web3.js");
const {
  quoteBuy,
  quoteRawForMoonz,
  decodeMarket,
} = require("../worker/moonz-market.cjs");
const { planRound } = require("../worker/reward-plan.cjs"),
  r = require("../client/rewards.cjs"),
  c = require("../client/index.cjs"),
  spl = require("@solana/spl-token");
const key = () => Keypair.generate().publicKey;
const m = () => ({
  x: 150_000_000_000n,
  y: 1_100_000_000_000_000n,
  phase: 1,
  saleRemaining: 340_000_000_000_000n,
  observedAt: 1000,
  quote: spl.NATIVE_MINT,
  creator: key(),
  slot: 123,
});
test("MOONZ executable quote includes immutable 1.25% trading fee and conservative slippage", () => {
  const market = m(),
    q = quoteBuy(market, 1_000_000_000n, { now: 1000 });
  assert.equal(q.tradeFee, "12500000");
  const expected = (market.y * 987_500_000n) / (market.x + 987_500_000n);
  assert.equal(BigInt(q.expectedOut), expected);
  assert.equal(BigInt(q.minOut), (expected * 9900n) / 10000n);
  assert.equal(quoteRawForMoonz(market, 1_000_000n), 136n);
});
test("stale market, excessive impact and uncertain graduation cannot produce an executable reward quote", () => {
  assert.throws(() => quoteBuy(m(), 1_000_000_000n, { now: 31001 }));
  assert.throws(() => quoteBuy(m(), 100_000_000_000n, { now: 1000 }));
  assert.throws(() =>
    quoteBuy({ ...m(), saleRemaining: 1n }, 1_000_000_000n, { now: 1000 }),
  );
});
test("missing MOONZ ATA and integer dust roll over without reallocating or taking another fee", () => {
  const program = key(),
    base = key(),
    holders = [
      { recipient: key(), balance: "1", hasMoonzAta: true },
      { recipient: key(), balance: "1", hasMoonzAta: false },
      { recipient: key(), balance: "1", hasMoonzAta: true },
    ];
  const round = planRound(program, base, 1, 1000n, holders);
  assert.equal(round.total, 666n);
  assert.equal(round.unallocated, "334");
  assert.deepEqual(
    round.entries.map((e) => e.amount),
    [333n, 333n],
  );
  assert.notDeepEqual(
    round.root,
    c.merkleRound(program, base, 1, round.entries).root,
  );
  assert.equal(
    planRound(
      program,
      base,
      1,
      1000n,
      holders.map((h) => ({ ...h, hasMoonzAta: false })),
    ).unallocated,
    "1000",
  );
});
test("MOONZ mint is pinned and reward vaults and proofs are distinct for every CA", () => {
  const program = key(),
    base = key(),
    a = r.addresses(program, base, spl.NATIVE_MINT);
  assert(!a.rewards.equals(a.launch));
  assert(
    !a.moonzVault.equals(
      r.addresses(program, key(), spl.NATIVE_MINT).moonzVault,
    ),
  );
  assert.equal(
    r.MOONZ.toBase58(),
    "DfUWVvq1NDip9EQT9RreVDTQL3kArLJkwq7e9LXZEfkh",
  );
  assert.throws(
    () =>
      r.buy(program, key(), base, r.USDC, spl.TOKEN_PROGRAM_ID, {
        amount: 1n,
        minMoonzOut: 1n,
        deadline: 1000,
        creator: key(),
      }),
    /requires an exact-in bridge/,
  );
});
