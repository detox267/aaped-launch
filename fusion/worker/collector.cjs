"use strict";
const { DatabaseSync } = require("node:sqlite");

// Wall-clock collection slots. Payout thresholds do not control this timer.
const INTERVAL_MS = 300_000;
const MIN_SALE_USD_MICROS = 30_000_000n;
const MAX_VALUATION_AGE_MS = 30_000;
const nextSlot = (now) => (Math.floor(now / INTERVAL_MS) + 1) * INTERVAL_MS;
const encode = (value) => JSON.stringify(value);

function validateSaleQuote(quote, request, now) {
  const raw = value => typeof value === "string" && /^(0|[1-9]\d*)$/.test(value);
  const fresh = value => Number.isSafeInteger(value) && value >= 0 && value <= now
    && now - value <= MAX_VALUATION_AGE_MS;
  if (!quote || quote.mint !== request.mint || quote.amount !== request.amount
    || typeof quote.quoteMint !== "string" || !quote.quoteMint
    || !raw(quote.minOut) || BigInt(quote.minOut) <= 0n
    || !raw(quote.minOutUsdMicros) || !fresh(quote.quotedAt) || !fresh(quote.priceAt))
    throw new Error("Missing, stale or mismatched sale valuation");
  return BigInt(quote.minOutUsdMicros);
}

class CollectorStore {
  constructor(filename, program) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS collector_identity (program TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collector_cycles (mint TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collector_receipts (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    `);
    const identity = this.db.prepare("SELECT program FROM collector_identity").get();
    if (identity && identity.program !== String(program)) {
      this.db.close();
      throw new Error("Collector database belongs to another program");
    }
    if (!identity) this.db.prepare("INSERT INTO collector_identity VALUES (?)").run(String(program));
  }
  get(mint) {
    const row = this.db.prepare("SELECT data FROM collector_cycles WHERE mint=?").get(mint);
    return row ? JSON.parse(row.data) : null;
  }
  all() {
    return this.db.prepare("SELECT data FROM collector_cycles ORDER BY mint").all().map(row => JSON.parse(row.data));
  }
  save(state) {
    this.db.prepare("INSERT INTO collector_cycles VALUES (?,?) ON CONFLICT(mint) DO UPDATE SET data=excluded.data")
      .run(state.mint, encode(state));
  }
  settled(state, operation, receipt) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO collector_receipts VALUES (?,?)")
        .run(operation.id, encode({ operation, receipt }));
      this.save(state);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  receipts() {
    return this.db.prepare("SELECT data FROM collector_receipts ORDER BY id").all().map(row => JSON.parse(row.data));
  }
  close() { this.db.close(); }
}

/**
 * Scheduling/settlement engine, NOT a live RPC adapter or deployment entrypoint.
 * See README.md for the mandatory adapter and single-process-lock contract.
 * Adapter.prepare must never broadcast; exact signed bytes are saved first.
 */
class Collector {
  constructor({ store, adapter, maxSwapRaw, enabled = false, clock = Date.now }) {
    this.store = store;
    this.adapter = adapter;
    this.maxSwapRaw = BigInt(maxSwapRaw);
    if (this.maxSwapRaw <= 0n) throw new Error("Positive swap cap required");
    this.enabled = enabled;
    this.clock = clock;
    this.busy = new Set();
  }
  register(mint) {
    mint = String(mint);
    if (!this.store.get(mint)) this.store.save({
      mint, nextDueAt: nextSlot(this.clock()), cycle: 0, phase: "idle", lastSlot: null,
      pending: null, lastSettledSlot: 0, retryAt: 0,
    });
  }
  async tick(mint) {
    mint = String(mint);
    if (!this.enabled || this.busy.has(mint)) return;
    this.busy.add(mint);
    try {
      await this.advance(mint);
    } catch (error) {
      const state = this.store.get(mint);
      if (state) {
        // No new signature is prepared while pending exists, even after a send timeout.
        state.retryAt = this.clock() + 30_000;
        state.issue = String(error.message || error);
        this.store.save(state);
      }
    } finally {
      this.busy.delete(mint);
    }
  }
  async advance(mint) {
    let state = this.store.get(mint);
    if (!state || state.phase === "review" || this.clock() < state.retryAt) return;
    if (state.pending) {
      const op = state.pending;
      const result = await this.adapter.reconcile(op);
      if (result.status === "review") {
        state.phase = "review";
        state.issue = result.reason;
        this.store.save(state);
        return;
      }
      if (result.status === "pending") {
        // RPC adapter alone determines whether the original bytes remain valid.
        if (result.rebroadcast === true) {
          await this.adapter.ready();
          if (this.enabled) await this.adapter.broadcast(op);
        }
        return;
      }
      if (result.status !== "finalized" || !Number.isSafeInteger(result.slot) || result.slot < 0)
        throw new Error("Unverified collector receipt");
      state.pending = null;
      state.lastSettledSlot = Math.max(state.lastSettledSlot, result.slot);
      state.retryAt = 0;
      state.issue = null;
      if (op.kind === "collect") state.batch++;
      else state.remaining = (BigInt(state.remaining) - BigInt(op.amount)).toString();
      this.store.settled(state, op, result);
      return;
    }
    const now = this.clock();
    if (state.phase === "idle") {
      if (now < state.nextDueAt) return;
      const slot = Math.floor(now / INTERVAL_MS);
      if (state.lastSlot !== null && slot <= state.lastSlot) return;
      // Coalesce missed slots into one current cycle; never queue a burst of old sells.
      state = { ...state, cycle: state.cycle + 1, phase: "snapshot", lastSlot: slot,
        startedAt: now, nextDueAt: nextSlot(now), retryAt: 0, issue: null,
        outcome: null, saleValuation: null };
      this.store.save(state);
    }
    await this.adapter.ready();
    if (!this.enabled) return;
    if (state.phase === "snapshot") {
      const snapshot = await this.adapter.snapshot(mint, state.lastSettledSlot);
      if (!Array.isArray(snapshot.sources) || BigInt(snapshot.mintWithheld) < 0n)
        throw new Error("Invalid tax snapshot");
      const sources = [...new Set(snapshot.sources.map(String))].sort();
      state.batches = [];
      for (let i = 0; i < sources.length; i += 16) state.batches.push(sources.slice(i, i + 16));
      if (!state.batches.length && BigInt(snapshot.mintWithheld) > 0n) state.batches.push([]);
      state.batch = 0;
      state.phase = "collect";
      this.store.save(state);
    }
    if (state.phase === "collect" && state.batch >= state.batches.length) {
      const balance = BigInt(await this.adapter.baseBalance(mint, state.lastSettledSlot));
      if (balance < 0n) throw new Error("Invalid base vault balance");
      // Freeze this cycle's sell budget. New tax from these sales waits until next cycle.
      state.remaining = balance.toString();
      state.sale = 0;
      state.phase = "sell";
      this.store.save(state);
    }
    if (state.phase === "sell" && BigInt(state.remaining) === 0n) {
      this.finishCycle(state, "complete");
      return;
    }
    const request = state.phase === "collect"
      ? { kind: "collect", sources: state.batches[state.batch], ordinal: state.batch }
      : { kind: "sell", amount: String(BigInt(state.remaining) < this.maxSwapRaw
          ? BigInt(state.remaining) : this.maxSwapRaw), ordinal: state.sale };
    request.mint = mint;
    request.id = `${mint}/${state.cycle}/${request.kind}/${request.ordinal}`;
    request.minContextSlot = state.lastSettledSlot;
    if (request.kind === "sell") {
      let value;
      try {
        request.quote = await this.adapter.quoteSale(request);
        value = validateSaleQuote(request.quote, request, this.clock());
      } catch {
        this.finishCycle(state, "valuation_unavailable", "Sale held: a fresh paired-asset USD quote is unavailable");
        return;
      }
      state.saleValuation = request.quote;
      if (value < MIN_SALE_USD_MICROS) {
        this.finishCycle(state, BigInt(request.amount) < BigInt(state.remaining)
          ? "swap_cap_below_sale_minimum" : "accumulating");
        return;
      }
    }
    const prepared = await this.adapter.prepare(request);
    if (!prepared?.wire || !prepared.signature) throw new Error("Missing signed transaction");
    // Revalidate after asynchronous simulation/signing; never save a stale new sale.
    if (request.kind === "sell" && validateSaleQuote(request.quote, request, this.clock()) < MIN_SALE_USD_MICROS)
      throw new Error("Sale value fell below the minimum during preparation");
    const operation = { ...prepared, ...request };
    state.pending = operation;
    if (request.kind === "sell") state.sale++;
    // Commit signed bytes before any call capable of broadcasting them.
    this.store.save(state);
    await this.adapter.ready();
    if (this.enabled) await this.adapter.broadcast(operation);
  }
  finishCycle(state, outcome, issue = null) {
    state.phase = "idle";
    state.completedAt = this.clock();
    state.batches = [];
    state.outcome = outcome;
    state.issue = issue;
    state.retryAt = 0;
    // Unsold raw balance stays in this CA's on-chain vault for the next cycle.
    this.store.save(state);
  }
}

module.exports = { Collector, CollectorStore, INTERVAL_MS, nextSlot,
  MIN_SALE_USD_MICROS, MAX_VALUATION_AGE_MS };
