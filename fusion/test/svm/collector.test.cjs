"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { Transaction, ComputeBudgetProgram, PublicKey } = require("@solana/web3.js");
const { getTransactionDecoder } = require("@solana/kit");
const { FailedTransactionMetadata } = require("litesvm");
const { setup, spl, c } = require("./helpers.cjs");
const { Collector, CollectorStore, INTERVAL_MS } = require("../../worker/collector.cjs");

test("five-minute engine runs real tax collection and paired sale, preserving separate net pots", async () => {
  const t = setup({ raydium: true }), a = t.launch(), b = t.launch();
  t.send([a.instruction], [t.admin, a.mint]);
  t.send([b.instruction], [t.admin, b.mint]);
  const sources = new Map([[a.mint.publicKey.toBase58(), t.buy(a)], [b.mint.publicKey.toBase58(), t.buy(b)]]);
  const launches = new Map([a, b].map(l => [l.mint.publicKey.toBase58(), l]));
  const store = new CollectorStore(":memory:", t.program.toBase58());
  let now = 0;
  const executed = new Map();
  // LiteSVM-only adapter. It deliberately has no RPC, key loader, public verification
  // bypass usable in a daemon, or claim to test production quote/receipt recovery.
  const adapter = {
    ready: async () => {},
    snapshot: async mint => ({ sources: [sources.get(mint).toBase58()], mintWithheld: "0" }),
    baseBalance: async mint => t.balance(launches.get(mint).a.baseVault, spl.TOKEN_2022_PROGRAM_ID),
    prepare: async request => {
      const l = launches.get(request.mint);
      const instruction = request.kind === "collect"
        ? c.collect(t.program, t.operator.publicKey, l.mint.publicKey, request.sources.map(s => new PublicKey(s)))
        : t.convert(l, BigInt(request.amount));
      const tx = new Transaction({ feePayer: t.operator.publicKey, recentBlockhash: t.svm.latestBlockhash() })
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), instruction);
      tx.sign(t.operator);
      return { wire: tx.serialize().toString("base64"), signature: tx.signature.toString("base64") };
    },
    broadcast: async op => {
      assert.equal(store.get(op.mint).pending.wire, op.wire);
      if (executed.has(op.signature)) return;
      const result = t.svm.sendTransaction(getTransactionDecoder().decode(Buffer.from(op.wire, "base64")));
      if (result instanceof FailedTransactionMetadata) throw new Error(result.meta().logs().join("\n"));
      executed.set(op.signature, { status: "finalized", slot: executed.size + 1 });
    },
    reconcile: async op => executed.get(op.signature) || { status: "pending", rebroadcast: true },
  };
  const worker = new Collector({ store, adapter, maxSwapRaw: 1_000_000_000_000n, enabled: true, clock: () => now });
  const mint = a.mint.publicKey.toBase58(); worker.register(mint);
  try {
    now = INTERVAL_MS - 1; await worker.tick(mint); assert.equal(executed.size, 0);
    now = INTERVAL_MS;
    for (let i = 0; i < 30; i++) {
      await worker.tick(mint);
      if (store.get(mint).phase === "idle") break;
    }
    assert.equal(store.get(mint).phase, "idle", store.get(mint).issue);
    assert(executed.size >= 2);
    const state = t.launchState(a.mint.publicKey);
    assert(state.credited > 0n);
    assert.equal(t.balance(a.a.baseVault, spl.TOKEN_2022_PROGRAM_ID), 0n);
    assert.equal(t.balance(a.a.quoteVault), state.credited);
    assert.equal(state.platformAvailable, state.credited / 4n);
    assert.equal(state.holderAvailable, state.credited - state.platformAvailable);
    assert.equal(t.launchState(b.mint.publicKey).credited, 0n, "same SOL pair must not share pots");
    assert.equal(t.balance(b.a.baseVault, spl.TOKEN_2022_PROGRAM_ID), 0n);
    assert.equal(state.paidHolders, 0n, "collection timer must not force holder payouts");
    assert.equal(state.paidPlatform, 0n);
    const count = executed.size; now = INTERVAL_MS * 2 - 1; await worker.tick(mint);
    assert.equal(executed.size, count);
  } finally { store.close(); }
});
