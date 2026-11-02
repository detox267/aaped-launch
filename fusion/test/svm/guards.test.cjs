const test = require("node:test"),
  assert = require("node:assert/strict");
const { setup, Keypair, spl, c, Clock } = require("./helpers.cjs");
function round(t, l, amount = 750n, recipients = null) {
  const entries = recipients || [
    { recipient: Keypair.generate().publicKey, amount },
  ];
  const r = c.merkleRound(t.program, l.base, 1, entries),
    deadline = t.svm.getClock().unixTimestamp + 3600n;
  t.send(
    [c.openRound(t.program, t.operator.publicKey, l.base, { ...r, deadline })],
    [t.operator],
  );
  return { ...r, deadline };
}
const payout = (t, l, e) =>
  c.pay(
    t.program,
    t.operator.publicKey,
    l.base,
    l.quote,
    spl.TOKEN_PROGRAM_ID,
    e,
  );
const createRecipient = (t, l, recipient) =>
  t.send([
    spl.createAssociatedTokenAccountIdempotentInstruction(
      t.admin.publicKey,
      spl.getAssociatedTokenAddressSync(l.quote, recipient),
      recipient,
      l.quote,
    ),
  ]);
test("missing ATA fails atomically; expiry returns the same net budget without another fee", () => {
  const t = setup(),
    l = t.tokenFixture(),
    r = round(t, l),
    before = t.launchState(l.base);
  t.send([payout(t, l, r.entries[0])], [t.operator], false);
  assert.deepEqual(t.launchState(l.base), before);
  assert.equal(t.balance(l.a.quoteVault), 1000n);
  t.send([c.closeRound(t.program, l.base)], [t.admin], false);
  const clock = t.svm.getClock();
  t.svm.setClock(
    new Clock(
      clock.slot,
      clock.epochStartTimestamp,
      clock.epoch,
      clock.leaderScheduleEpoch,
      r.deadline,
    ),
  );
  t.send([c.closeRound(t.program, l.base)]);
  const s = t.launchState(l.base);
  assert.equal(s.holderAvailable, 750n);
  assert.equal(s.platformAvailable, 250n);
  assert.equal(s.credited, 1000n);
});
test("token payouts transfer exact amounts and reject replay, overclaim, wrong recipient and old-round proofs", () => {
  const t = setup(),
    l = t.tokenFixture(),
    r = round(t, l),
    e = r.entries[0];
  createRecipient(t, l, e.recipient);
  for (const bad of [
    { ...e, amount: 751n },
    { ...e, round: 2n },
    { ...e, recipient: Keypair.generate().publicKey },
    { ...e, index: 1 },
  ])
    t.send([payout(t, l, bad)], [t.operator], false);
  t.send([payout(t, l, e)], [t.operator]);
  assert.equal(
    t.balance(spl.getAssociatedTokenAddressSync(l.quote, e.recipient)),
    750n,
  );
  t.send([payout(t, l, e)], [t.operator], false);
  assert.equal(t.balance(l.a.quoteVault), 250n);
});
test("same quote mint cannot bypass per-CA source account or proof binding", () => {
  const t = setup(),
    a = t.tokenFixture(),
    b = t.tokenFixture(a.mint),
    r = round(t, a),
    e = r.entries[0];
  createRecipient(t, a, e.recipient);
  const wrongSource = payout(t, a, e);
  wrongSource.keys[4].pubkey = b.a.quoteVault;
  t.send([wrongSource], [t.operator], false);
  t.send([payout(t, b, e)], [t.operator], false);
  assert.equal(t.balance(a.a.quoteVault), 1000n);
  assert.equal(t.balance(b.a.quoteVault), 1000n);
});
test("platform payout can only debit its 25% and pay the configured fee wallet", () => {
  const t = setup(),
    l = t.tokenFixture();
  createRecipient(t, l, t.fee.publicKey);
  const pay = (recipient, amount) =>
    c.payPlatform(
      t.program,
      t.operator.publicKey,
      l.base,
      l.quote,
      spl.TOKEN_PROGRAM_ID,
      recipient,
      amount,
    );
  t.send([pay(t.admin.publicKey, 250n)], [t.operator], false);
  t.send([pay(t.fee.publicKey, 251n)], [t.operator], false);
  t.send([pay(t.fee.publicKey, 250n)], [t.operator]);
  assert.equal(t.balance(l.a.quoteVault), 750n);
  t.send([pay(t.fee.publicKey, 1n)], [t.operator], false);
  assert.equal(t.launchState(l.base).holderAvailable, 750n);
});
test("donations cannot be credited twice and holder budgets cannot be overcommitted", () => {
  const t = setup(),
    l = t.tokenFixture();
  t.send(
    [
      c.creditDonation(
        t.program,
        t.operator.publicKey,
        l.base,
        l.quote,
        spl.TOKEN_PROGRAM_ID,
      ),
    ],
    [t.operator],
    false,
  );
  const r = c.merkleRound(t.program, l.base, 1, [
    { recipient: Keypair.generate().publicKey, amount: 751n },
  ]);
  t.send(
    [
      c.openRound(t.program, t.operator.publicKey, l.base, {
        ...r,
        deadline: t.svm.getClock().unixTimestamp + 3600n,
      }),
    ],
    [t.operator],
    false,
  );
  assert.equal(t.launchState(l.base).holderAvailable, 750n);
});
test("pause, operator binding and two-step admin change leave loader upgrade authority intact", () => {
  const t = setup(),
    l = t.tokenFixture(),
    pd = Buffer.from(t.get(t.cfg.programData).data);
  t.send(
    [
      c.controls(t.program, t.operator.publicKey, {
        operator: t.operator.publicKey,
        maxSwapRaw: 1n,
        paused: true,
      }),
    ],
    [t.operator],
    false,
  );
  const r = c.merkleRound(t.program, l.base, 1, [
    { recipient: Keypair.generate().publicKey, amount: 1n },
  ]);
  const open = (operator) =>
    c.openRound(t.program, operator, l.base, {
      ...r,
      deadline: t.svm.getClock().unixTimestamp + 3600n,
    });
  t.send([open(t.admin.publicKey)], [t.admin], false);
  t.send([t.controls(true)]);
  t.send([open(t.operator.publicKey)], [t.operator], false);
  t.send([c.proposeAdmin(t.program, t.admin.publicKey, t.operator.publicKey)]);
  t.send([c.acceptAdmin(t.program, t.admin.publicKey)], [t.admin], false);
  t.send([c.acceptAdmin(t.program, t.operator.publicKey)], [t.operator]);
  t.send([t.controls(false)], [t.admin], false);
  assert.deepEqual(Buffer.from(t.get(t.cfg.programData).data), pd);
});
test("frozen recipient rolls back bitmap and budget consumption", () => {
  const t = setup(),
    l = t.tokenFixture(),
    r = round(t, l),
    e = r.entries[0];
  createRecipient(t, l, e.recipient);
  const dest = spl.getAssociatedTokenAddressSync(l.quote, e.recipient);
  t.send([
    spl.createFreezeAccountInstruction(dest, l.quote, t.admin.publicKey),
  ]);
  const before = t.launchState(l.base);
  t.send([payout(t, l, e)], [t.operator], false);
  assert.deepEqual(t.launchState(l.base), before);
});
