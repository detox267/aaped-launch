const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { VersionedTransaction } = require("@solana/web3.js"),
  bs58 = require("bs58").default,
  { getTransactionDecoder } = require("@solana/kit");
const { FailedTransactionMetadata } = require("litesvm");
const {
  setup,
  Keypair,
  PublicKey,
  SystemProgram,
  spl,
  c,
} = require("./helpers.cjs");
const {
  r,
  loadMoonz,
  rewardsState,
  buyMoonz,
} = require("./rewards-helpers.cjs");
const { RpcAdapter, GENESIS } = require("../../worker/rpc-adapter.cjs");
const { hash } = require("../../ops/check-verification.cjs");
const {
  DistributionFeeStore,
  PlatformDistributionSender,
  receipt,
} = require("../../worker/distribution-fees.cjs");
function fixture() {
  const t = setup({ raydium: true }),
    market = loadMoonz(t),
    l = t.launch(),
    base = l.mint.publicKey;
  t.send([l.instruction], [t.admin, l.mint]);
  t.send([
    SystemProgram.transfer({
      fromPubkey: t.admin.publicKey,
      toPubkey: l.a.quoteVault,
      lamports: 200_000_000n,
    }),
    spl.createSyncNativeInstruction(l.a.quoteVault),
  ]);
  t.send(
    [
      c.creditDonation(
        t.program,
        t.operator.publicKey,
        base,
        spl.NATIVE_MINT,
        spl.TOKEN_PROGRAM_ID,
      ),
    ],
    [t.operator],
  );
  t.send([r.initialize(t.program, t.operator.publicKey, base)], [t.operator]);
  t.send(
    [buyMoonz(t, base, t.launchState(base).holderAvailable, market)],
    [t.operator],
  );
  t.set(
    t.operator.publicKey,
    SystemProgram.programId,
    Buffer.alloc(0),
    20_000_000n,
  );
  return { t, l, base };
}
test("funding distribution SOL debits only the platform 25%, with operator/amount/reserve caps", () => {
  const { t, l, base } = fixture(),
    before = rewardsState(t, base),
    launch = t.launchState(base),
    operatorBefore = t.svm.getBalance(t.operator.publicKey.toBase58());
  t.send(
    [
      c.fundDistributionFees(
        t.program,
        t.operator.publicKey,
        base,
        10_000_000n,
      ),
    ],
    [t.operator],
  );
  assert.equal(
    t.launchState(base).platformAvailable,
    launch.platformAvailable - 10_000_000n,
  );
  assert.equal(t.launchState(base).paidPlatform, 10_000_000n);
  assert.equal(t.balance(l.a.quoteVault), 40_000_000n);
  assert.deepEqual(rewardsState(t, base), before);
  assert.equal(t.launchState(base).holderAvailable, launch.holderAvailable);
  assert.equal(
    t.svm.getBalance(t.operator.publicKey.toBase58()) - operatorBefore,
    9_995_000n,
  );
  const wrong = c.fundDistributionFees(
    t.program,
    t.operator.publicKey,
    base,
    1n,
  );
  wrong.keys[5].pubkey = t.fee.publicKey;
  t.send([wrong], [t.operator], false);
  const unauthorized = c.fundDistributionFees(
    t.program,
    t.admin.publicKey,
    base,
    1n,
  );
  t.send([unauthorized], [t.admin], false);
  t.send(
    [
      c.fundDistributionFees(
        t.program,
        t.operator.publicKey,
        base,
        40_000_001n,
      ),
    ],
    [t.operator],
    false,
  );
  t.send([t.controls(true)]);
  t.send(
    [c.fundDistributionFees(t.program, t.operator.publicKey, base, 1n)],
    [t.operator],
    false,
  );
  t.send([t.controls(false)]);
  t.set(
    t.operator.publicKey,
    SystemProgram.programId,
    Buffer.alloc(0),
    95_000_000n,
  );
  t.send(
    [
      c.fundDistributionFees(
        t.program,
        t.operator.publicKey,
        base,
        10_000_000n,
      ),
    ],
    [t.operator],
    false,
  );
  assert.deepEqual(rewardsState(t, base), before);
  assert.equal(t.launchState(base).platformAvailable, 40_000_000n);
});
test("a non-SOL platform pot cannot withdraw the paired holder budget as distribution gas", () => {
  const t = setup(),
    l = t.tokenFixture(),
    d = Buffer.from(t.get(l.a.launch).data);
  d[0] = 2;
  t.set(l.a.launch, t.program, d);
  t.set(
    t.operator.publicKey,
    SystemProgram.programId,
    Buffer.alloc(0),
    20_000_000n,
  );
  t.send(
    [c.fundDistributionFees(t.program, t.operator.publicKey, l.base, 100n)],
    [t.operator],
    false,
  );
  assert.equal(t.launchState(l.base).holderAvailable, 750n);
  assert.equal(t.launchState(l.base).platformAvailable, 250n);
});
test("verified sender recovers a timed-out platform top-up, sponsors full holder payouts and accounts failed fees", async () => {
  const { t, l, base } = fixture(),
    receipts = new Map();
  let loseResponse = false,
    forceFailure = false,
    height = 1000;
  const info = (k) => {
    const a = t.get(k);
    return a.exists
      ? {
          data: Buffer.from(a.data),
          owner: new PublicKey(a.programAddress),
          executable: a.executable,
          lamports: Number(a.lamports),
          rentEpoch: 0,
        }
      : null;
  };
  const tokenRows = (keys) =>
    keys.flatMap((key, accountIndex) => {
      const a = info(key);
      if (
        !a ||
        ![spl.TOKEN_PROGRAM_ID, spl.TOKEN_2022_PROGRAM_ID].some((p) =>
          p.equals(a.owner),
        )
      )
        return [];
      try {
        const token = spl.unpackAccount(key, a, a.owner),
          m = info(token.mint),
          mint = spl.unpackMint(token.mint, m, m.owner);
        return [
          {
            accountIndex,
            mint: token.mint.toBase58(),
            owner: token.owner.toBase58(),
            uiTokenAmount: {
              amount: String(token.amount),
              decimals: mint.decimals,
            },
          },
        ];
      } catch {
        return [];
      }
    });
  const rpc = {
    getGenesisHash: async () => GENESIS,
    getAccountInfo: async (k) => info(k),
    getMultipleAccountsInfo: async (keys) => keys.map(info),
    getBalance: async (k) => Number(t.svm.getBalance(k.toBase58())),
    getLatestBlockhash: async () => ({
      blockhash: t.svm.latestBlockhash(),
      lastValidBlockHeight: 2000,
    }),
    getBlockHeight: async () => height,
    getMinimumBalanceForRentExemption: async (n) =>
      Number(t.svm.minimumBalanceForRentExemption(BigInt(n))),
    getFeeForMessage: async () => ({ value: 5250 }),
    simulateTransaction: async (tx) => {
      const result = t.svm.simulateTransaction(
        getTransactionDecoder().decode(tx.serialize()),
      );
      if (result instanceof FailedTransactionMetadata)
        throw Error(result.meta().logs().join("\n"));
      return { value: { err: null } };
    },
    sendRawTransaction: async (wire) => {
      const tx = VersionedTransaction.deserialize(wire),
        signature = bs58.encode(tx.signatures[0]);
      if (!receipts.has(signature)) {
        if (forceFailure) {
          forceFailure = false;
          t.send([t.controls(true)]);
        }
        const keys = tx.message.staticAccountKeys,
          preBalances = keys.map((k) => info(k)?.lamports || 0),
          preTokenBalances = tokenRows(keys);
        const result = t.svm.sendTransaction(
            getTransactionDecoder().decode(wire),
          ),
          postBalances = keys.map((k) => info(k)?.lamports || 0);
        const fee = Number(
          preBalances.reduce((sum, n) => sum + BigInt(n), 0n) -
            postBalances.reduce((sum, n) => sum + BigInt(n), 0n),
        );
        receipts.set(signature, {
          slot: 1000,
          transaction: { message: tx.message, signatures: [signature] },
          meta: {
            err:
              result instanceof FailedTransactionMetadata
                ? { failed: true }
                : null,
            fee,
            preBalances,
            postBalances,
            preTokenBalances,
            postTokenBalances: tokenRows(keys),
            loadedAddresses: { writable: [], readonly: [] },
          },
        });
      }
      if (loseResponse) {
        loseResponse = false;
        throw Error("lost response after execution");
      }
      return signature;
    },
    getSignatureStatuses: async (signatures) => ({
      value: signatures.map((s) =>
        receipts.has(s)
          ? {
              confirmationStatus: "finalized",
              err: receipts.get(s).meta.err,
              slot: 1000,
            }
          : null,
      ),
    }),
    getTransaction: async (signature) => receipts.get(signature) || null,
  };
  const binaryPath = path.join(
      __dirname,
      "../../target/deploy/moonz_fusion.so",
    ),
    binaryHash = hash(fs.readFileSync(binaryPath));
  const config = {
    live: true,
    programId: t.program.toBase58(),
    operator: t.operator.publicKey.toBase58(),
    admin: t.admin.publicKey.toBase58(),
    upgradeAuthority: t.admin.publicKey.toBase58(),
    feeWallet: t.fee.publicKey.toBase58(),
    platform: t.platform.toBase58(),
    cpConfig: t.cpConfig.toBase58(),
    maxSwapRaw: "1000000000000",
    minSolLamports: "5000000",
    priorityMicroLamports: 1000,
    maxFeeLamports: 25000,
    binaryPath,
    releaseCommit: "1".repeat(40),
  };
  const adapter = new RpcAdapter(config, {
    connection: rpc,
    signer: t.operator,
    verification: async () => ({
      is_verified: true,
      is_frozen: false,
      is_closed: false,
      commit: config.releaseCommit,
      repo_url: "https://github.com/detox267/aaped-launch",
      on_chain_hash: binaryHash,
      executable_hash: binaryHash,
    }),
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-sponsored-")),
    file = path.join(dir, "distribution.sqlite");
  let store = new DistributionFeeStore(file, config.programId, config.operator),
    sender = new PlatformDistributionSender({ adapter, store });
  try {
    const budget = rewardsState(t, base).available,
      recipient = Keypair.generate().publicKey,
      ata = spl.getAssociatedTokenAddressSync(r.MOONZ, recipient);
    t.send([
      spl.createAssociatedTokenAccountIdempotentInstruction(
        t.admin.publicKey,
        ata,
        recipient,
        r.MOONZ,
      ),
    ]);
    const round = r.merkleRound(t.program, base, 1, [
      { recipient, amount: budget },
    ]);
    const open = {
      id: "round/1/open",
      kind: "open",
      mint: base.toBase58(),
      round: { ...round, deadline: t.svm.getClock().unixTimestamp + 3600n },
    };
    await assert.rejects(sender.prepare(open), /Platform fee reserve/);
    const funded = await sender.prepare({
      id: "fund/1",
      kind: "fund",
      mint: base.toBase58(),
      amount: "10000000",
    });
    loseResponse = true;
    await assert.rejects(sender.broadcast(funded.id));
    assert(receipts.has(funded.signature));
    store.close();
    store = new DistributionFeeStore(file, config.programId, config.operator);
    sender = new PlatformDistributionSender({ adapter, store });
    assert.equal((await sender.reconcile(funded.id)).status, "finalized");
    await sender.reconcile(funded.id);
    assert.equal(store.balance().funded, 10_000_000n);
    assert.equal(store.balance().spent, 5250n);
    await sender.prepare(open);
    await sender.broadcast(open.id);
    await sender.reconcile(open.id);
    const pay = {
      id: "round/1/pay/0",
      kind: "pay",
      mint: base.toBase58(),
      payment: round.entries[0],
    };
    await sender.prepare(pay);
    await assert.rejects(
      sender.prepare({
        ...pay,
        payment: { ...pay.payment, amount: budget - 1n },
      }),
      /different instructions/,
    );
    const recipientSol = t.svm.getBalance(recipient.toBase58()) || 0n;
    forceFailure = true;
    await sender.broadcast(pay.id);
    assert.equal((await sender.reconcile(pay.id)).status, "failed");
    assert.equal(t.balance(ata), 0n);
    assert.equal(rewardsState(t, base).remaining, budget);
    assert.equal(store.balance().spent, 15750n);
    t.send([t.controls(false)]);
    const retry = { ...pay, id: "round/1/pay/0/reviewed-retry" };
    await sender.prepare(retry);
    await sender.broadcast(retry.id);
    assert.equal((await sender.reconcile(retry.id)).status, "finalized");
    assert.equal(t.balance(ata), budget);
    assert.equal(t.svm.getBalance(recipient.toBase58()) || 0n, recipientSol);
    assert.equal(t.launchState(base).platformAvailable, 40_000_000n);
    assert.equal(rewardsState(t, base).paid, budget);
    assert.equal(store.balance().spent, 21000n);
    assert.equal(store.balance().reserved, 0n);
    const future = await sender.prepare({
      id: "round/1/close",
      kind: "close",
      mint: base.toBase58(),
    });
    height = 2001;
    assert.equal((await sender.reconcile(future.id)).status, "review");
    assert.equal(store.balance().reserved, 25000n);
    await assert.rejects(
      sender.prepare({
        id: "new-signature",
        kind: "close",
        mint: base.toBase58(),
      }),
      /Reconcile/,
    );
    const good = receipts.get(store.get(retry.id).signature),
      tampered = {
        ...good,
        meta: { ...good.meta, postBalances: [...good.meta.postBalances] },
      };
    const index = good.transaction.message.staticAccountKeys.findIndex((k) =>
      k.equals(recipient),
    );
    tampered.meta.postBalances[index]++;
    assert.throws(
      () =>
        receipt(
          store.get(retry.id),
          tampered,
          adapter.program,
          adapter.operator,
        ),
      /Unexpected SOL/,
    );
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
