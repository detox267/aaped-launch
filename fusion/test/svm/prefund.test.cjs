const test = require("node:test");
const assert = require("node:assert/strict");
const { setup, Keypair, spl, c, SystemProgram } = require("./helpers.cjs");

test("pre-funding launch and unwrap PDAs cannot block launch or change the platform amount", () => {
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
  const recipient = t.fee.publicKey;
  const before = t.svm.getBalance(recipient.toBase58());
  t.send(
    [
      c.payPlatform(
        t.program,
        t.operator.publicKey,
        base,
        l.quote,
        spl.TOKEN_PROGRAM_ID,
        recipient,
        2_500_000n,
      ),
    ],
    [t.operator],
  );
  assert.equal(t.svm.getBalance(recipient.toBase58()) - before, 2_500_000n);
  assert.equal(t.balance(l.a.quoteVault), 7_500_000n);
  assert.equal(t.launchState(base).holderAvailable, 7_500_000n);
  assert.equal(t.launchState(base).platformAvailable, 0n);
});
