"use strict";
const { DatabaseSync } = require("node:sqlite");

// Wall-clock collection slots. Payout thresholds do not control this timer.
const INTERVAL_MS = 300_000;
const nextSlot = (now) => (Math.floor(now / INTERVAL_MS) + 1) * INTERVAL_MS;
const encode = (value) => JSON.stringify(value);

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
        startedAt: now, nextDueAt: nextSlot(now), retryAt: 0, issue: null };
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
      state.phase = "idle";
      state.completedAt = this.clock();
      state.batches = [];
      state.issue = null;
      this.store.save(state);
      return;
    }
    const request = state.phase === "collect"
      ? { kind: "collect", sources: state.batches[state.batch], ordinal: state.batch }
      : { kind: "sell", amount: String(BigInt(state.remaining) < this.maxSwapRaw
          ? BigInt(state.remaining) : this.maxSwapRaw), ordinal: state.sale };
    const id = `${mint}/${state.cycle}/${request.kind}/${request.ordinal}`;
    const prepared = await this.adapter.prepare({ ...request, mint, id, minContextSlot: state.lastSettledSlot });
    if (!prepared?.wire || !prepared.signature) throw new Error("Missing signed transaction");
    const operation = { ...prepared, ...request, mint, id };
    state.pending = operation;
    if (request.kind === "sell") state.sale++;
    // Commit signed bytes before any call capable of broadcasting them.
    this.store.save(state);
    await this.adapter.ready();
    if (this.enabled) await this.adapter.broadcast(operation);
  }
}

module.exports = { Collector, CollectorStore, INTERVAL_MS, nextSlot };
