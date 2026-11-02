const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  setup,
  Keypair,
  spl,
  c,
  SystemProgram,
  sdk,
  BN,
  Clock,
} = require("./helpers.cjs");
test("real Raydium CPI creates a fixed-tax mint and per-token vaults", () => {
  const t = setup({ raydium: true }),
    l = t.launch();
  t.send([l.instruction], [t.admin, l.mint]);
  const s = t.launchState(l.mint.publicKey);
  assert(s.quote.equals(spl.NATIVE_MINT));
  assert.equal(s.credited, 0n);
  const info = t.get(l.mint.publicKey),
    m = spl.unpackMint(
      l.mint.publicKey,
      {
        ...info,
        owner: spl.TOKEN_2022_PROGRAM_ID,
        data: Buffer.from(info.data),
      },
      spl.TOKEN_2022_PROGRAM_ID,
    );
  const fee = spl.getTransferFeeConfig(m);
  assert.equal(fee.newerTransferFee.transferFeeBasisPoints, 300);
  assert(fee.withdrawWithheldAuthority.equals(t.cfg.taxAuthority));
  assert.equal(m.mintAuthority, null);
  assert.equal(m.freezeAuthority, null);
  assert.equal(
    spl.unpackAccount(l.a.quoteVault, {
      ...t.get(l.a.quoteVault),
      owner: spl.TOKEN_PROGRAM_ID,
      data: Buffer.from(t.get(l.a.quoteVault).data),
    }).amount,
    0n,
  );
});
test("real CPMM program converts only this CA vault on the pinned pair using the production quote", async () => {
  const t = setup({ raydium: true }),
    l = t.launch(),
    base = l.mint.publicKey,
    quote = l.quote,
    owner = t.admin.publicKey;
  t.send([l.instruction], [t.admin, l.mint]);
  const userBase = t.buy(l),
    userQuote = spl.getAssociatedTokenAddressSync(quote, owner);
  const ordered = [base, quote].sort((a, b) =>
      Buffer.compare(a.toBuffer(), b.toBuffer()),
    ),
    baseFirst = ordered[0].equals(base);
  const keys = sdk.getCreatePoolKeys({
    programId: c.CPMM,
    configId: t.cpConfig,
    mintA: ordered[0],
    mintB: ordered[1],
  });
  const userLp = spl.getAssociatedTokenAddressSync(keys.lpMint, owner);
  const amountBase = t.balance(userBase, spl.TOKEN_2022_PROGRAM_ID) / 2n,
    amountQuote = 1_000_000_000n;
  t.send([
    SystemProgram.transfer({
      fromPubkey: owner,
      toPubkey: userQuote,
      lamports: amountQuote,
    }),
    spl.createSyncNativeInstruction(userQuote),
    sdk.makeCreateCpmmPoolInInstruction(
      c.CPMM,
      owner,
      t.cpConfig,
      keys.authority,
      keys.poolId,
      ordered[0],
      ordered[1],
      keys.lpMint,
      baseFirst ? userBase : userQuote,
      baseFirst ? userQuote : userBase,
      userLp,
      keys.vaultA,
      keys.vaultB,
      sdk.CREATE_CPMM_POOL_FEE_ACC,
      baseFirst ? spl.TOKEN_2022_PROGRAM_ID : spl.TOKEN_PROGRAM_ID,
      baseFirst ? spl.TOKEN_PROGRAM_ID : spl.TOKEN_2022_PROGRAM_ID,
      keys.observationId,
      new BN((baseFirst ? amountBase : amountQuote).toString()),
      new BN((baseFirst ? amountQuote : amountBase).toString()),
      new BN(0),
    ),
  ]);
  const clock = t.svm.getClock();
  t.svm.setClock(
    new Clock(
      clock.slot,
      clock.epochStartTimestamp,
      clock.epoch,
      clock.leaderScheduleEpoch,
      clock.unixTimestamp + 5n,
    ),
  );
  t.send(
    [c.collect(t.program, t.operator.publicKey, base, [userBase])],
    [t.operator],
  );
  const amount = t.balance(l.a.baseVault, spl.TOKEN_2022_PROGRAM_ID);
  const { PublicKey } = require("@solana/web3.js");
  const info = key => {
    const a = t.get(key), data = Buffer.from(a.data);
    // Quote fixture only: the actual privileged graduation service is not run.
    if (key.equals(l.pool)) data[sdk.LaunchpadPool.offsetOf("status")] = 2;
    return { ...a, owner: new PublicKey(a.programAddress), data };
  };
  const rpc = { getAccountInfo: async key => info(key), getMultipleAccountsInfo: async keys => keys.map(info),
    getEpochInfo: async () => ({ epoch: Number(t.svm.getClock().epoch), absoluteSlot: Number(t.svm.getClock().slot) }) };
  const quoted = await require("../../worker/quotes.cjs").raydiumQuote(rpc, {
    state: t.launchState(base), addresses: l.a,
    baseMint: spl.unpackMint(base, info(base), spl.TOKEN_2022_PROGRAM_ID),
    quoteMint: spl.unpackMint(quote, info(quote), spl.TOKEN_PROGRAM_ID),
  }, { platform: t.platform, cpConfig: t.cpConfig }, amount, 100, 0);
  const minOut = BigInt(quoted.minOut), swap = require("../../worker/common.cjs").decodeInstruction(quoted.swap);
  assert.equal(quoted.route, "cpmm"); assert(minOut > 1n);
  const ix = c.convert(
    t.program,
    t.operator.publicKey,
    base,
    quote,
    spl.TOKEN_PROGRAM_ID,
    swap,
    { amount, minOut, deadline: t.svm.getClock().unixTimestamp + 60n },
  );
  const wrong = c.convert(
    t.program,
    t.operator.publicKey,
    base,
    quote,
    spl.TOKEN_PROGRAM_ID,
    swap,
    { amount, minOut, deadline: t.svm.getClock().unixTimestamp + 60n },
  );
  wrong.keys[7 + 3].pubkey = l.pool;
  t.send([wrong], [t.operator], false);
  t.send([ix], [t.operator]);
  assert(t.launchState(base).credited >= minOut);
});
test("launch rejects wrong tax, extra platform fees and wrong collector atomically", () => {
  const t = setup({ raydium: true });
  for (const kind of ["tax", "fee", "authority"]) {
    const l = t.launch(),
      before = t.get(t.platform),
      original = Buffer.from(before.data);
    if (kind === "tax")
      l.instruction.data.writeUInt16LE(100, l.instruction.data.length - 10);
    else {
      const data = Buffer.from(original);
      if (kind === "fee") data.writeBigUInt64LE(1n, 104);
      else t.admin.publicKey.toBuffer().copy(data, 728);
      t.set(t.platform, c.LAUNCHLAB, data, before.lamports);
    }
    t.send([l.instruction], [t.admin, l.mint], false);
    assert.equal(t.get(l.a.launch).exists, false);
    assert.equal(t.get(l.mint.publicKey).exists, false);
    t.set(t.platform, c.LAUNCHLAB, original, before.lamports);
  }
});
test("bad slippage and cross-token tax sources roll back balances", () => {
  const t = setup({ raydium: true }),
    a = t.launch(),
    b = t.launch();
  t.send([a.instruction], [t.admin, a.mint]);
  t.send([b.instruction], [t.admin, b.mint]);
  const aa = t.buy(a),
    bb = t.buy(b);
  t.send(
    [c.collect(t.program, t.operator.publicKey, a.mint.publicKey, [aa, bb])],
    [t.operator],
    false,
  );
  assert.equal(t.balance(a.a.baseVault, spl.TOKEN_2022_PROGRAM_ID), 0n);
  t.send(
    [c.collect(t.program, t.operator.publicKey, a.mint.publicKey, [aa])],
    [t.operator],
  );
  const raw = t.balance(a.a.baseVault, spl.TOKEN_2022_PROGRAM_ID);
  t.send([t.convert(a, raw, 2n ** 63n)], [t.operator], false);
  assert.equal(t.balance(a.a.baseVault, spl.TOKEN_2022_PROGRAM_ID), raw);
  assert.equal(t.launchState(a.mint.publicKey).credited, 0n);
});
test("real buy → withheld tax collection → conversion → 75/25 native payouts, without double payment", () => {
  const t = setup({ raydium: true }),
    l = t.launch(),
    base = l.mint.publicKey;
  t.send([l.instruction], [t.admin, l.mint]);
  const userAta = t.buy(l);
  t.send(
    [c.collect(t.program, t.operator.publicKey, base, [userAta])],
    [t.operator],
  );
  const tax = t.balance(l.a.baseVault, spl.TOKEN_2022_PROGRAM_ID);
  assert(tax > 0n);
  t.send([t.convert(l, tax)], [t.operator]);
  const s = t.launchState(base);
  assert(s.credited > 0n);
  assert.equal(s.platformAvailable, s.credited / 4n);
  assert.equal(s.holderAvailable, s.credited - s.platformAvailable);
  const recipient = Keypair.generate().publicKey;
  t.svm.airdrop(recipient.toBase58(), 1_000_000n);
  const r = c.merkleRound(t.program, base, 1, [
    { recipient, amount: s.holderAvailable },
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
  const before = t.svm.getBalance(recipient.toBase58()),
    pay = c.pay(
      t.program,
      t.operator.publicKey,
      base,
      l.quote,
      spl.TOKEN_PROGRAM_ID,
      r.entries[0],
    );
  t.send([pay], [t.operator]);
  assert.equal(
    t.svm.getBalance(recipient.toBase58()) - before,
    s.holderAvailable,
  );
  t.send([pay], [t.operator], false);
  const beforeFee = t.svm.getBalance(t.fee.publicKey.toBase58());
  t.send(
    [
      c.payPlatform(
        t.program,
        t.operator.publicKey,
        base,
        l.quote,
        spl.TOKEN_PROGRAM_ID,
        t.fee.publicKey,
        s.platformAvailable,
      ),
    ],
    [t.operator],
  );
  assert.equal(
    t.svm.getBalance(t.fee.publicKey.toBase58()) - beforeFee,
    s.platformAvailable,
  );
  assert.equal(t.balance(l.a.quoteVault), 0n);
  t.send([c.closeRound(t.program, base)]);
  assert.equal(t.launchState(base).remaining, 0n);
});
