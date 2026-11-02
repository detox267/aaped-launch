"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { Collector, CollectorStore, INTERVAL_MS } = require("../worker/collector.cjs");

function fixture(t, options = {}) {
  let now = 1_000, signature = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-collector-"));
  const file = path.join(dir, "collector.sqlite");
  let store = new CollectorStore(file, "test-program");
  const calls = [], sent = new Set(), vault = new Map(), receipts = new Map();
  const adapter = {
    ready: async () => {},
    snapshot: async (mint, slot) => {
      calls.push(["snapshot", mint, slot]);
      return { sources: options.sources || [mint + "/tax"], mintWithheld: "0" };
    },
    baseBalance: async (mint, slot) => { calls.push(["balance", mint, slot]); return vault.get(mint) || 0n; },
    quoteSale: async request => ({
      mint: request.mint, amount: request.amount, quoteMint: "paired-asset",
      minOut: request.amount, minOutUsdMicros: String(BigInt(request.amount) * 10_000_000n),
      quotedAt: now, priceAt: now,
    }),
    prepare: async request => {
      calls.push(["prepare", request]);
      return { wire: JSON.stringify(request), signature: String(++signature) };
    },
    broadcast: async op => {
      assert.deepEqual(store.get(op.mint).pending, op, "journal must precede broadcast");
      calls.push(["broadcast", op.id]);
      if (sent.has(op.signature)) return;
      sent.add(op.signature);
      vault.set(op.mint, op.kind === "collect" ? (vault.get(op.mint) || 0n) + 25n
        : vault.get(op.mint) - BigInt(op.amount));
      receipts.set(op.signature, { status: "finalized", slot: sent.size });
    },
    reconcile: async op => receipts.get(op.signature) || { status: "pending", rebroadcast: true },
  };
  const make = () => new Collector({ store, adapter, maxSwapRaw: options.maxSwapRaw || 10n, enabled: true, clock: () => now });
  let worker = make();
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return {
    adapter, calls, sent, vault, receipts, file,
    get store() { return store; }, get worker() { return worker; },
    time: value => { now = value; },
    restart: () => { store.close(); store = new CollectorStore(file, "test-program"); worker = make(); },
    drain: async mint => {
      for (let i = 0; i < 200; i++) {
        await worker.tick(mint);
        if (store.get(mint).phase === "idle") return;
      }
      throw new Error("Cycle did not finish");
    },
  };
}

test("fixed five-minute slots collect then sell all chunks without another timer", async t => {
  const f = fixture(t); f.worker.register("A");
  f.time(INTERVAL_MS - 1); await f.worker.tick("A");
  assert.equal(f.calls.length, 0);
  f.time(INTERVAL_MS); await f.drain("A");
  const requests = f.calls.filter(c => c[0] === "prepare").map(c => c[1]);
  assert.deepEqual(requests.map(r => r.kind), ["collect", "sell", "sell", "sell"]);
  assert.deepEqual(requests.slice(1).map(r => r.amount), ["10", "10", "5"]);
  assert.equal(f.vault.get("A"), 0n);
  assert.equal(f.store.get("A").completedAt, INTERVAL_MS);
  assert.equal(f.store.get("A").nextDueAt, 2 * INTERVAL_MS);
  assert.equal(f.store.receipts().length, 4);
  assert.equal(f.calls.find(c => c[0] === "balance")[2], 1, "balance must observe finalized collection");
});

test("empty cycles cost no transactions, while existing vault inventory still sells", async t => {
  const f = fixture(t, { sources: [] }); f.worker.register("A");
  f.time(INTERVAL_MS); await f.drain("A");
  assert.equal(f.sent.size, 0);
  f.vault.set("A", 7n); f.time(INTERVAL_MS * 2); await f.drain("A");
  assert.equal(f.sent.size, 1);
  assert.equal(f.store.receipts()[0].operation.kind, "sell");
});

test("restart after ambiguous broadcast reconciles original bytes without a duplicate sale", async t => {
  const f = fixture(t, { sources: [] }); f.worker.register("A"); f.vault.set("A", 7n);
  const broadcast = f.adapter.broadcast;
  f.adapter.broadcast = async op => { await broadcast(op); throw new Error("RPC timeout after execution"); };
  f.time(INTERVAL_MS); await f.worker.tick("A");
  const pending = f.store.get("A").pending;
  assert(pending);
  assert.equal(f.vault.get("A"), 0n);
  f.restart(); f.time(INTERVAL_MS + 30_000); await f.drain("A");
  assert.equal(f.calls.filter(c => c[0] === "prepare").length, 1);
  assert.equal(f.store.receipts()[0].operation.signature, pending.signature);
  assert.equal(f.store.get("A").pending, null);
});

test("a journalled but unsent transaction is rebroadcast unchanged after restart", async t => {
  const f = fixture(t, { sources: [] }); f.worker.register("A"); f.vault.set("A", 7n);
  const broadcast = f.adapter.broadcast;
  f.adapter.broadcast = async () => { throw new Error("network unavailable"); };
  f.time(INTERVAL_MS); await f.worker.tick("A");
  const pending = f.store.get("A").pending;
  f.restart(); f.adapter.broadcast = broadcast; f.time(INTERVAL_MS + 30_000);
  await f.drain("A");
  assert.equal(f.calls.filter(c => c[0] === "prepare").length, 1);
  assert.equal(f.store.receipts()[0].operation.wire, pending.wire);
});

test("pending work blocks only its CA and missed slots coalesce into one catch-up cycle", async t => {
  const f = fixture(t); f.worker.register("A"); f.worker.register("B");
  const reconcile = f.adapter.reconcile;
  f.adapter.reconcile = async op => op.mint === "A" ? { status: "pending", rebroadcast: false } : reconcile(op);
  f.time(INTERVAL_MS); await f.worker.tick("A");
  f.time(12 * INTERVAL_MS); await f.worker.tick("A"); await f.drain("B");
  assert.equal(f.store.get("A").cycle, 1);
  assert.equal(f.store.get("B").cycle, 1);
  assert.equal(f.store.get("B").nextDueAt, 13 * INTERVAL_MS);
  f.adapter.reconcile = reconcile; await f.drain("A"); await f.drain("A");
  assert.equal(f.store.get("A").cycle, 2);
  await f.worker.tick("A"); assert.equal(f.store.get("A").cycle, 2);
  f.time(2 * INTERVAL_MS); await f.worker.tick("A");
  assert.equal(f.store.get("A").cycle, 2, "clock rollback must not repeat a slot");
});

test("unverifiable expiry holds the CA for review, without replacing its signature", async t => {
  const f = fixture(t); f.worker.register("A"); f.time(INTERVAL_MS); await f.worker.tick("A");
  const original = f.store.get("A").pending;
  f.adapter.reconcile = async () => ({ status: "review", reason: "expired without archival history" });
  await f.worker.tick("A"); f.restart(); f.time(INTERVAL_MS * 50); await f.worker.tick("A");
  assert.equal(f.store.get("A").phase, "review");
  assert.deepEqual(f.store.get("A").pending, original);
  assert.equal(f.calls.filter(c => c[0] === "prepare").length, 1);
});

test("collection deduplicates accounts and batches at 16 before selling", async t => {
  const sources = Array.from({ length: 35 }, (_, i) => `tax-${i}`);
  const f = fixture(t, { sources: [...sources, ...sources] });
  f.worker.register("A"); f.time(INTERVAL_MS); await f.drain("A");
  const operations = f.calls.filter(c => c[0] === "prepare").map(c => c[1]);
  assert.deepEqual(operations.slice(0, 3).map(o => o.sources.length), [16, 16, 3]);
  assert.equal(operations[3].kind, "sell");
  assert.equal(new Set(operations.slice(0, 3).flatMap(o => o.sources)).size, 35);
});

test("disabled, unready and concurrent ticks cannot create overlapping sends", async t => {
  const f = fixture(t); f.worker.register("A"); f.time(INTERVAL_MS);
  f.worker.enabled = false; await f.worker.tick("A"); assert.equal(f.calls.length, 0);
  f.worker.enabled = true;
  f.adapter.ready = async () => { throw new Error("release verification missing"); };
  await f.worker.tick("A"); assert.equal(f.sent.size, 0);
  f.adapter.ready = async () => {}; f.time(INTERVAL_MS + 30_000);
  await Promise.all(Array.from({ length: 20 }, () => f.worker.tick("A")));
  assert.equal(f.sent.size, 1);
  assert.equal(f.calls.filter(c => c[0] === "prepare").length, 1);
  assert.throws(() => new CollectorStore(f.file, "wrong-program"), /another program/);
});

test("tax accumulates across five-minute cycles and restart until its own sale clears $30", async t => {
  const f = fixture(t, { maxSwapRaw: 100n }); f.worker.register("A"); f.worker.register("B");
  const quote = f.adapter.quoteSale;
  f.adapter.quoteSale = async request => ({ ...await quote(request), minOutUsdMicros: String(BigInt(request.amount) * 1_000_000n) });
  f.time(INTERVAL_MS); await f.drain("A"); await f.drain("B");
  assert.equal(f.store.get("A").outcome, "accumulating");
  assert.equal(f.vault.get("A"), 25n); assert.equal(f.vault.get("B"), 25n);
  assert(f.store.receipts().every(r => r.operation.kind === "collect"), "same pair must not pool CA values");
  f.restart(); f.time(INTERVAL_MS * 2); await f.drain("A");
  assert.equal(f.vault.get("A"), 0n); assert.equal(f.vault.get("B"), 25n);
  const sale = f.store.receipts().find(r => r.operation.kind === "sell").operation;
  assert.equal(sale.amount, "50"); assert.equal(sale.quote.minOutUsdMicros, "50000000");
});

test("$29.999999 waits, exactly $30 sells before the holder/platform split", async t => {
  const f = fixture(t, { sources: [], maxSwapRaw: 100n }); f.worker.register("A"); f.vault.set("A", 10n);
  const quote = f.adapter.quoteSale;
  let value = "29999999";
  f.adapter.quoteSale = async request => ({ ...await quote(request), minOutUsdMicros: value });
  f.time(INTERVAL_MS); await f.drain("A"); assert.equal(f.sent.size, 0);
  value = "30000000"; f.time(INTERVAL_MS * 2); await f.drain("A");
  assert.equal(f.sent.size, 1); assert.equal(f.vault.get("A"), 0n);
});

test("a small remainder waits for accumulation, and a raw swap cap cannot bypass $30", async t => {
  const f = fixture(t, { sources: [], maxSwapRaw: 30n }); f.worker.register("A"); f.vault.set("A", 50n);
  const quote = f.adapter.quoteSale;
  f.adapter.quoteSale = async request => ({ ...await quote(request), minOutUsdMicros: String(BigInt(request.amount) * 1_000_000n) });
  f.time(INTERVAL_MS); await f.drain("A");
  assert.equal(f.sent.size, 1); assert.equal(f.vault.get("A"), 20n);
  assert.equal(f.store.get("A").outcome, "accumulating");
  f.vault.set("A", 100n); f.worker.maxSwapRaw = 20n; f.time(INTERVAL_MS * 2); await f.drain("A");
  assert.equal(f.sent.size, 1);
  assert.equal(f.store.get("A").outcome, "swap_cap_below_sale_minimum");
});

test("stale, missing, future, mismatched or malformed valuation never sells and collection continues", async t => {
  const f = fixture(t, { maxSwapRaw: 10_000n }); f.worker.register("A");
  const quote = f.adapter.quoteSale;
  const bad = [
    q => ({ ...q, quotedAt: q.quotedAt - 30_001 }),
    q => ({ ...q, priceAt: q.priceAt - 30_001 }),
    q => ({ ...q, priceAt: q.priceAt + 1 }),
    q => ({ ...q, mint: "B" }), q => ({ ...q, amount: "1" }),
    q => ({ ...q, minOutUsdMicros: 30_000_000 }), q => ({ ...q, minOut: "0" }),
    q => ({ ...q, minOutUsdMicros: "NaN" }), () => null,
    () => { throw new Error("price feed offline"); },
  ];
  for (let i = 0; i < bad.length; i++) {
    f.adapter.quoteSale = async request => bad[i](await quote(request));
    f.time((i + 1) * INTERVAL_MS); await f.drain("A");
    assert.equal(f.store.get("A").outcome, "valuation_unavailable");
    assert.equal(f.vault.get("A"), BigInt(i + 1) * 25n);
  }
  assert(f.store.receipts().every(r => r.operation.kind === "collect"));
});

test("each new chunk gets a fresh value check when prices fall, while pending signatures stay fixed", async t => {
  const f = fixture(t, { sources: [], maxSwapRaw: 30n }); f.worker.register("A"); f.vault.set("A", 60n);
  const quote = f.adapter.quoteSale;
  let valuations = 0;
  f.adapter.quoteSale = async request => ({ ...await quote(request), minOutUsdMicros: ++valuations === 1 ? "30000000" : "29000000" });
  f.time(INTERVAL_MS); await f.worker.tick("A");
  const first = f.store.get("A").pending.signature;
  f.restart(); await f.drain("A");
  assert.equal(f.sent.size, 1); assert.equal(f.vault.get("A"), 30n);
  assert.equal(f.store.receipts()[0].operation.signature, first);
  assert.equal(valuations, 2);
});

test("a quote that ages during preparation cannot be journalled or broadcast", async t => {
  const f = fixture(t, { sources: [] }); f.worker.register("A"); f.vault.set("A", 10n);
  const prepare = f.adapter.prepare;
  f.adapter.prepare = async request => { const result = await prepare(request); f.time(INTERVAL_MS + 30_001); return result; };
  f.time(INTERVAL_MS); await f.worker.tick("A");
  assert.equal(f.sent.size, 0); assert.equal(f.store.get("A").pending, null);
  assert.equal(f.vault.get("A"), 10n);
});
