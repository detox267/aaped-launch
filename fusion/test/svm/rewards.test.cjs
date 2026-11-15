const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  setup,
  Keypair,
  PublicKey,
  SystemProgram,
  spl,
  c,
  Clock,
} = require("./helpers.cjs");
const {
  r,
  loadMoonz,
  rewardsState,
  buyMoonz,
} = require("./rewards-helpers.cjs");
function fixture({ quote = spl.NATIVE_MINT, raw = 100_000_000n } = {}) {
  const t = setup(),
    market = loadMoonz(t),
    base = Keypair.generate().publicKey,
    a = r.addresses(t.program, base, quote);
  const d = Buffer.alloc(393);
  d[0] = 2;
  [
    base,
    quote,
    spl.TOKEN_PROGRAM_ID,
    t.admin.publicKey,
    Keypair.generate().publicKey,
  ].forEach((k, i) => k.toBuffer().copy(d, 1 + i * 32));
  t.set(a.launch, t.program, d);
  t.send([
    spl.createAssociatedTokenAccountIdempotentInstruction(
      t.admin.publicKey,
      a.quoteVault,
      a.launch,
      quote,
    ),
  ]);
  if (quote.equals(spl.NATIVE_MINT))
    t.send([
      SystemProgram.transfer({
        fromPubkey: t.admin.publicKey,
        toPubkey: a.quoteVault,
        lamports: raw,
      }),
      spl.createSyncNativeInstruction(a.quoteVault),
    ]);
  else {
    const info = t.get(a.quoteVault),
      b = Buffer.from(info.data);
    b.writeBigUInt64LE(raw, 64);
    t.set(a.quoteVault, spl.TOKEN_PROGRAM_ID, b, info.lamports);
  }
  t.send(
    [
      c.creditDonation(
        t.program,
        t.operator.publicKey,
        base,
        quote,
        spl.TOKEN_PROGRAM_ID,
      ),
    ],
    [t.operator],
  );
  const init = r.initialize(t.program, t.operator.publicKey, base);
  t.send([init], [t.operator]);
  return { t, base, a, market, quote, init };
}
test("reward purchases isolate 75% budget, exact received MOONZ and donated escrow", () => {
  const { t, base, a, market } = fixture(),
    before = t.launchState(base);
  t.send([
    spl.createAssociatedTokenAccountIdempotentInstruction(
      t.admin.publicKey,
      a.bridgeVault,
      a.rewards,
      spl.NATIVE_MINT,
    ),
    SystemProgram.transfer({
      fromPubkey: t.admin.publicKey,
      toPubkey: a.bridgeVault,
      lamports: 10_000n,
    }),
    spl.createSyncNativeInstruction(a.bridgeVault),
  ]);
  t.send([buyMoonz(t, base, before.holderAvailable, market)], [t.operator]);
  const after = rewardsState(t, base);
  assert.equal(after.credited, t.balance(a.moonzVault));
  assert.equal(after.available, after.credited);
  assert.equal(after.quoteSpent, before.holderAvailable);
  assert.equal(t.balance(a.bridgeVault), 10_000n);
  assert.equal(t.launchState(base).platformAvailable, before.platformAvailable);
  assert.equal(t.balance(a.quoteVault), before.platformAvailable);
  t.send(
    [buyMoonz(t, base, 1n, market, { minMoonzOut: 1n })],
    [t.operator],
    false,
  );
});
test("slippage, deadline, wrong market, wrong vault, pause and unauthorized purchase roll back", () => {
  const { t, base, a, market, init } = fixture(),
    amount = t.launchState(base).holderAvailable;
  const before = Buffer.from(t.get(a.launch).data),
    rewards = Buffer.from(t.get(a.rewards).data);
  const make = (o = {}) => buyMoonz(t, base, amount, market, o);
  for (const override of [
    { minMoonzOut: 0xffffffffffffffffn },
    { minMoonzOut: 0n },
    { deadline: t.svm.getClock().unixTimestamp + 301n },
    { amount: amount + 1n },
  ])
    t.send([make(override)], [t.operator], false);
  const wrong = make();
  wrong.keys[22].pubkey = t.admin.publicKey;
  t.send([wrong], [t.operator], false);
  const other = fixture(); // foreign launch-owned accounts cannot substitute another CA's reward source
  const swap = make();
  swap.keys[7].pubkey = other.a.moonzVault;
  t.send([swap], [t.operator], false);
  const unauthorized = make();
  unauthorized.keys[0].pubkey = t.admin.publicKey;
  t.send([unauthorized], [t.admin], false);
  t.send([t.controls(true)]);
  t.send([make()], [t.operator], false);
  t.send([t.controls(false)]);
  t.send([init], [t.operator], false);
  assert.deepEqual(Buffer.from(t.get(a.launch).data), before);
  assert.deepEqual(Buffer.from(t.get(a.rewards).data), rewards);
  assert.equal(t.balance(a.quoteVault), 100_000_000n);
  assert.equal(t.balance(a.moonzVault), 0n);
});
test("MOONZ-paired holders receive net MOONZ directly, once, without conversion or a second split", () => {
  const { t, base, a } = fixture({ quote: r.MOONZ, raw: 1003n });
  const instruction = r.buy(
    t.program,
    t.operator.publicKey,
    base,
    r.MOONZ,
    spl.TOKEN_PROGRAM_ID,
    {
      amount: 753n,
      minMoonzOut: 753n,
      deadline: t.svm.getClock().unixTimestamp + 60n,
    },
  );
  t.send([instruction], [t.operator]);
  assert.equal(rewardsState(t, base).available, 753n);
  assert.equal(t.balance(a.quoteVault), 250n);
  assert.equal(t.balance(a.moonzVault), 753n);
  t.send([instruction], [t.operator], false);
});
test("MOONZ-only rounds reject paired payout, proof substitution and missing ATA without consuming a leaf", () => {
  const { t, base, a, market } = fixture();
  t.send(
    [buyMoonz(t, base, t.launchState(base).holderAvailable, market)],
    [t.operator],
  );
  const budget = rewardsState(t, base).available,
    recipient = Keypair.generate().publicKey,
    other = Keypair.generate().publicKey;
  const round = r.merkleRound(t.program, base, 1, [
      { recipient, amount: budget },
    ]),
    deadline = t.svm.getClock().unixTimestamp + 3600n;
  t.send(
    [
      c.openRound(t.program, t.operator.publicKey, base, {
        ...round,
        deadline,
      }),
    ],
    [t.operator],
    false,
  );
  const legacy = c.pay(
    t.program,
    t.operator.publicKey,
    base,
    spl.NATIVE_MINT,
    spl.TOKEN_PROGRAM_ID,
    round.entries[0],
  );
  t.send([legacy], [t.operator], false);
  t.send(
    [
      r.openRound(t.program, t.operator.publicKey, base, {
        ...round,
        deadline,
      }),
    ],
    [t.operator],
  );
  t.send([r.pay(t.program, base, round.entries[0])], [t.admin], false);
  assert.equal(rewardsState(t, base).remaining, budget);
  assert.equal(rewardsState(t, base).bitmap[0], 0);
  const ata = spl.getAssociatedTokenAddressSync(r.MOONZ, recipient);
  t.send([
    spl.createAssociatedTokenAccountIdempotentInstruction(
      t.admin.publicKey,
      ata,
      recipient,
      r.MOONZ,
    ),
  ]);
  for (const changed of [
    { recipient: other },
    { round: 2 },
    { amount: budget + 1n },
    { index: 1 },
  ])
    t.send(
      [r.pay(t.program, base, { ...round.entries[0], ...changed })],
      [t.admin],
      false,
    );
  t.send([r.pay(t.program, base, round.entries[0])]);
  assert.equal(t.balance(ata), budget);
  assert.equal(rewardsState(t, base).paid, budget);
  t.send([r.pay(t.program, base, round.entries[0])], [t.admin], false);
  t.send([r.closeRound(t.program, base)]);
  assert.equal(rewardsState(t, base).available, 0n);
  assert.equal(t.balance(a.moonzVault), 0n);
});
test("expired unpaid MOONZ rolls over without changing the paired platform balance", () => {
  const { t, base, a, market } = fixture();
  t.send(
    [buyMoonz(t, base, t.launchState(base).holderAvailable, market)],
    [t.operator],
  );
  const budget = rewardsState(t, base).available,
    recipient = Keypair.generate().publicKey,
    round = r.merkleRound(t.program, base, 1, [{ recipient, amount: budget }]);
  const clock = t.svm.getClock(),
    deadline = clock.unixTimestamp + 3600n;
  t.send(
    [
      r.openRound(t.program, t.operator.publicKey, base, {
        ...round,
        deadline,
      }),
    ],
    [t.operator],
  );
  t.send([r.closeRound(t.program, base)], [t.admin], false);
  t.svm.setClock(
    new Clock(
      clock.slot,
      clock.epochStartTimestamp,
      clock.epoch,
      clock.leaderScheduleEpoch,
      deadline,
    ),
  );
  t.send([r.closeRound(t.program, base)]);
  assert.equal(rewardsState(t, base).available, budget);
  assert.equal(t.balance(a.quoteVault), 25_000_000n);
  t.send([r.pay(t.program, base, round.entries[0])], [t.admin], false);
});
test("Jupiter bridge rejects other programs, arbitrary instructions, foreign signer and protected vault accounts", () => {
  const { t, base, a, market } = fixture({ quote: r.USDC });
  // Load an executable under the Jupiter address only to exercise boundary validation; it is never called.
  const path = require("node:path");
  t.svm.addProgramFromFile(
    r.JUPITER.toBase58(),
    path.join(__dirname, "../../target/deploy/moonz_fusion.so"),
  );
  const { TransactionInstruction } = require("@solana/web3.js");
  const meta = (pubkey, isWritable = false) => ({
    pubkey,
    isSigner: false,
    isWritable,
  });
  const data = Buffer.alloc(8 + 4 + 19);
  Buffer.from([229, 23, 203, 151, 122, 227, 173, 42]).copy(data);
  data.writeBigUInt64LE(75_000_000n, data.length - 19);
  data.writeBigUInt64LE(1n, data.length - 11);
  const keys = [
    meta(spl.TOKEN_PROGRAM_ID),
    meta(a.rewards),
    meta(a.sourceEscrow, true),
    meta(a.bridgeVault, true),
    meta(r.JUPITER),
    meta(spl.NATIVE_MINT),
    meta(r.JUPITER),
    meta(r.JUPITER),
    meta(r.JUPITER),
  ];
  function make(ks = keys, d = data) {
    return r.buy(
      t.program,
      t.operator.publicKey,
      base,
      r.USDC,
      spl.TOKEN_PROGRAM_ID,
      {
        amount: 75_000_000n,
        minMoonzOut: 1n,
        minBridgeOut: 1n,
        deadline: t.svm.getClock().unixTimestamp + 60n,
        creator: market.creator,
        bridge: new TransactionInstruction({
          programId: r.JUPITER,
          keys: ks,
          data: d,
        }),
      },
    );
  }
  const bad = data.map(() => 0);
  t.send([make(keys, bad)], [t.operator], false);
  for (const i of [1, 2, 3, 5]) {
    const k = keys.map((v) => ({ ...v }));
    k[i] = meta(a.quoteVault, true);
    t.send([make(k)], [t.operator], false);
  }
  t.send([make([...keys, meta(a.moonzVault, true)])], [t.operator], false);
  t.send([make([...keys, meta(a.rewards)])], [t.operator], false);
  const wrongAmount = Buffer.from(data);
  wrongAmount.writeBigUInt64LE(1n, data.length - 19);
  t.send([make(keys, wrongAmount)], [t.operator], false);
  assert.equal(t.balance(a.quoteVault), 100_000_000n);
  assert.equal(rewardsState(t, base).credited, 0n);
});

test("the same pinned program buys MOONZ from SOL and USDC AMM phases", () => {
  for (const quote of [spl.NATIVE_MINT, r.USDC]) {
    const { t, base, market } = fixture({ quote }),
      state = market.market.state;
    const info = t.get(state),
      d = Buffer.from(info.data);
    d[10] = 2;
    d[303] = quote.equals(r.USDC) ? 1 : 0;
    t.set(state, r.OG, d, info.lamports);
    const m = r.market(market.creator, quote),
      reserve = t.get(m.treasury),
      data = Buffer.from(reserve.data);
    const x = quote.equals(r.USDC) ? 50_000_000_000n : 100_000_000_000n;
    data.writeBigUInt64LE(x, 64);
    t.set(
      m.treasury,
      spl.TOKEN_PROGRAM_ID,
      data,
      quote.equals(spl.NATIVE_MINT) ? x + 2_039_280n : reserve.lamports,
    );
    const current = {
      ...market,
      phase: 2,
      quote,
      x,
      y: t.balance(m.lpVault),
      market: m,
    };
    t.send(
      [buyMoonz(t, base, t.launchState(base).holderAvailable, current)],
      [t.operator],
    );
    assert(rewardsState(t, base).available > 0n);
    assert.equal(t.launchState(base).platformAvailable, 25_000_000n);
  }
});

test("read-only planner gates net tier, retains purchased MOONZ and holds non-direct pairs", async () => {
  const { planPurchase } = require("../../worker/reward-plan.cjs");
  const { t, base, market } = fixture();
  const info = (k) => {
    const a = t.get(k);
    return a
      ? {
          ...a,
          owner: new PublicKey(a.programAddress),
          data: Buffer.from(a.data),
        }
      : null;
  };
  const rpc = {
    getAccountInfo: async (k) => info(k),
    getMultipleAccountsInfoAndContext: async (keys) => ({
      context: { slot: 123 },
      value: keys.map(info),
    }),
    getBlockTime: async () => Math.floor(Date.now() / 1000),
  };
  const args = {
    rpc,
    program: t.program,
    operator: t.operator.publicKey,
    base,
    prices: {
      quote: async () => ({ usdMicros: "499999999", priceAt: Date.now() }),
    },
  };
  assert.equal((await planPurchase(args)).status, "accumulating");
  args.prices = {
    quote: async () => ({ usdMicros: "500000000", priceAt: Date.now() }),
  };
  const ready = await planPurchase(args);
  assert.equal(ready.status, "purchase_ready");
  assert.equal(ready.instruction.data[0], 13);
  t.send(
    [buyMoonz(t, base, t.launchState(base).holderAvailable, market)],
    [t.operator],
  );
  assert.equal((await planPurchase(args)).status, "moonz_ready");
  const { t: u, base: b } = fixture({ quote: r.USDC });
  const ui = (k) => {
    const a = u.get(k);
    return a
      ? {
          ...a,
          owner: new PublicKey(a.programAddress),
          data: Buffer.from(a.data),
        }
      : null;
  };
  const urpc = {
    ...rpc,
    getAccountInfo: async (k) => ui(k),
    getMultipleAccountsInfoAndContext: async (keys) => ({
      context: { slot: 123 },
      value: keys.map(ui),
    }),
  };
  assert.equal(
    (
      await planPurchase({
        ...args,
        rpc: urpc,
        program: u.program,
        operator: u.operator.publicKey,
        base: b,
      })
    ).status,
    "bridge_review_required",
  );
});
