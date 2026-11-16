"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { PublicKey, VersionedTransaction } = require("@solana/web3.js"), bs58 = require("bs58").default;
const { FailedTransactionMetadata } = require("litesvm"), { getTransactionDecoder } = require("@solana/kit");
const { setup, spl, c, sdk, Clock } = require("./helpers.cjs");
const { RpcAdapter, GENESIS } = require("../../worker/rpc-adapter.cjs");
const { Collector, CollectorStore } = require("../../worker/collector.cjs");
const { hash } = require("../../ops/check-verification.cjs");
const { usdMicros } = require("../../worker/prices.cjs");

test("production adapter validates release, signs, simulates and reconciles real PDA/Raydium sales", async () => {
  const t = setup({ raydium: true }), l = t.launch();
  t.send([l.instruction], [t.admin, l.mint]); const userBase = t.buy(l);
  const mint = l.mint.publicKey.toBase58(), receipts = new Map(); let now = 0, failAfterSend = false;
  const info = key => {
    const account = t.get(key);
    return account.exists ? { data: Buffer.from(account.data), owner: new PublicKey(account.programAddress),
      executable: account.executable, lamports: Number(account.lamports), rentEpoch: 0 } : null;
  };
  const clock = value => {
    now = value; const old = t.svm.getClock();
    t.svm.setClock(new Clock(old.slot + 1n, old.epochStartTimestamp, old.epoch, old.leaderScheduleEpoch, BigInt(Math.floor(now / 1000))));
  };
  const tokenRows = keys => keys.flatMap((key, accountIndex) => {
    const a = info(key);
    if (!a || ![spl.TOKEN_PROGRAM_ID, spl.TOKEN_2022_PROGRAM_ID].some(p => p.equals(a.owner))) return [];
    try {
      const account = spl.unpackAccount(key, a, a.owner), mintInfo = info(account.mint);
      const mintData = spl.unpackMint(account.mint, mintInfo, mintInfo.owner);
      return [{ accountIndex, mint: account.mint.toBase58(), owner: account.owner.toBase58(),
        uiTokenAmount: { amount: String(account.amount), decimals: mintData.decimals } }];
    } catch { return []; }
  });
  const connection = {
    getGenesisHash: async () => GENESIS,
    getMultipleAccountsInfo: async keys => keys.map(info), getAccountInfo: async key => info(key),
    getBalance: async key => Number(t.svm.getBalance(key.toBase58())),
    getEpochInfo: async () => ({ epoch: Number(t.svm.getClock().epoch), absoluteSlot: Number(t.svm.getClock().slot) }),
    getProgramAccounts: async program => ({ context: { slot: 1000 }, value: (program.equals(t.program)
      ? [l.a.launch] : [userBase, l.a.baseVault, sdk.getPdaLaunchpadVaultId(c.LAUNCHLAB, l.pool, l.mint.publicKey).publicKey])
      .map(pubkey => ({ pubkey, account: info(pubkey) })) }),
    getLatestBlockhash: async () => ({ blockhash: t.svm.latestBlockhash(), lastValidBlockHeight: 2000 }),
    getBlockHeight: async () => 1000, getFeeForMessage: async () => ({ value: 6000 }),
    simulateTransaction: async tx => {
      const result = t.svm.simulateTransaction(getTransactionDecoder().decode(tx.serialize()));
      if (result instanceof FailedTransactionMetadata) throw new Error(result.meta().logs().join("\n"));
      return { value: { err: null } };
    },
    sendRawTransaction: async bytes => {
      const tx = VersionedTransaction.deserialize(bytes), signature = bs58.encode(tx.signatures[0]);
      if (!receipts.has(signature)) {
        const keys = tx.message.staticAccountKeys;
        const preBalances = keys.map(k => info(k)?.lamports || 0), preTokenBalances = tokenRows(keys);
        const result = t.svm.sendTransaction(getTransactionDecoder().decode(bytes));
        if (result instanceof FailedTransactionMetadata) throw new Error(result.meta().logs().join("\n"));
        const postBalances = keys.map(k => info(k)?.lamports || 0);
        receipts.set(signature, { slot: 1000, transaction: { message: tx.message, signatures: [signature] }, meta: {
          err: null, fee: preBalances[0] - postBalances[0], preBalances, postBalances, preTokenBalances,
          postTokenBalances: tokenRows(keys), loadedAddresses: { writable: [], readonly: [] },
        } });
      }
      if (failAfterSend) { failAfterSend = false; throw new Error("simulated lost response after execution"); }
      return signature;
    },
    getSignatureStatuses: async signatures => ({ value: signatures.map(s => receipts.has(s) ? { confirmationStatus: "finalized", err: null, slot: 1000 } : null) }),
    getTransaction: async signature => receipts.get(signature) || null,
  };
  const binaryPath = path.join(__dirname, "../../target/deploy/moonz_fusion.so"), binaryHash = hash(fs.readFileSync(binaryPath));
  const config = { live: true, programId: t.program.toBase58(), operator: t.operator.publicKey.toBase58(),
    admin: t.admin.publicKey.toBase58(), upgradeAuthority: t.admin.publicKey.toBase58(), feeWallet: t.fee.publicKey.toBase58(),
    platform: t.platform.toBase58(), cpConfig: t.cpConfig.toBase58(), maxSwapRaw: "1000000000000", minSolLamports: "5000000",
    slippageBps: 100, priorityMicroLamports: 1000, maxFeeLamports: 25000, binaryPath, releaseCommit: "1".repeat(40) };
  const makeAdapter = () => new RpcAdapter(config, { connection, signer: t.operator, now: () => now,
    verification: async () => ({ is_verified: true, is_frozen: false, is_closed: false, commit: config.releaseCommit,
      repo_url: "https://github.com/detox267/aaped-launch", on_chain_hash: binaryHash, executable_hash: binaryHash }),
    prices: { quote: async (_, decimals, amount) => ({ usdMicros: String(usdMicros(amount, decimals, "200")), priceAt: now, priceBlock: 1000 }) } });
  let adapter = makeAdapter();
  const store = new CollectorStore(":memory:", config.programId);
  let worker = new Collector({ store, adapter, maxSwapRaw: config.maxSwapRaw, enabled: true, clock: () => now });
  const drain = async () => {
    for (let i = 0; i < 200; i++) {
      await worker.tick(mint); const state = store.get(mint);
      assert(!state.issue, state.issue); if (state.phase === "idle") return;
    }
    assert.fail("cycle did not finish");
  };
  try {
    await adapter.ready(); assert.deepEqual(await adapter.discover(), [mint]); worker.register(mint);
    clock(300_000); await drain();
    assert.equal(store.get(mint).outcome, "accumulating"); assert.equal(t.launchState(l.mint.publicKey).credited, 0n);
    t.buy(l, 50_000_000_000n); clock(600_000); failAfterSend = true;
    await worker.tick(mint); assert(store.get(mint).pending); const original = store.get(mint).pending.signature;
    assert(receipts.has(original), "simulated timeout must happen after the actual chain change");
    adapter = makeAdapter(); worker = new Collector({ store, adapter, maxSwapRaw: config.maxSwapRaw, enabled: true, clock: () => now });
    clock(630_000); await drain();
    assert.equal(store.receipts().filter(r => r.operation.signature === original).length, 1);
    const state = t.launchState(l.mint.publicKey); assert(state.credited > 0n);
    assert.equal(state.platformAvailable, state.credited / 4n); assert.equal(state.holderAvailable, state.credited - state.platformAvailable);
    assert(store.receipts().filter(r => r.operation.kind === "sell").every(r => BigInt(r.receipt.quoteDelta) >= BigInt(r.operation.quote.minOut)));
    t.send([t.controls(true)]); await assert.rejects(adapter.ready(), /paused/);
    t.send([t.controls(false)]);
    const data = t.get(t.cfg.programData), changed = Buffer.from(data.data); changed[changed.length - 20] ^= 1;
    t.set(t.cfg.programData, c.LOADER, changed, data.lamports);
    await assert.rejects(adapter.ready(), /binary differs/);
  } finally { store.close(); }
});
