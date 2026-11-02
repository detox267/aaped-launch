const test = require("node:test");
const assert = require("node:assert/strict");
const { setup, Keypair, spl, c, SystemProgram } = require("./helpers.cjs");

test("pre-funding launch and unwrap PDAs cannot block launch or change the holder amount", () => {
  const t = setup({ raydium: true });
  const l = t.launch();
  const base = l.mint.publicKey;
  t.send([
    SystemProgram.transfer({
      fromPubkey: t.admin.publicKey,
      toPubkey: l.a.launch,
      lamports: 1_000_000,
    }),
  ]);
  t.send([l.instruction], [t.admin, l.mint]);
  t.send([
    SystemProgram.transfer({
      fromPubkey: t.admin.publicKey,
      toPubkey: l.a.quoteVault,
      lamports: 10_000_000,
    }),
    spl.createSyncNativeInstruction(l.a.quoteVault),
    SystemProgram.transfer({
      fromPubkey: t.admin.publicKey,
      toPubkey: l.a.unwrap,
      lamports: 1_000_000,
    }),
  ]);
  t.send(
    [
      c.creditDonation(
        t.program,
        t.operator.publicKey,
        base,
        l.quote,
        spl.TOKEN_PROGRAM_ID,
      ),
    ],
    [t.operator],
  );
  const recipient = Keypair.generate().publicKey;
  t.svm.airdrop(recipient.toBase58(), 1_000_000n);
  const r = c.merkleRound(t.program, base, 1, [
    { recipient, amount: 7_500_000n },
  ]);
  t.send(
    [
      c.openRound(t.program, t.operator.publicKey, base, {
        ...r,
        deadline: t.svm.getClock().unixTimestamp + 3600n,
      }),
    ],
    [t.operator],
  );
  const before = t.svm.getBalance(recipient.toBase58());
  t.send(
    [
      c.pay(
        t.program,
        t.operator.publicKey,
        base,
        l.quote,
        spl.TOKEN_PROGRAM_ID,
        r.entries[0],
      ),
    ],
    [t.operator],
  );
  assert.equal(t.svm.getBalance(recipient.toBase58()) - before, 7_500_000n);
  assert.equal(t.balance(l.a.quoteVault), 2_500_000n);
  assert.equal(t.launchState(base).platformAvailable, 2_500_000n);
});
