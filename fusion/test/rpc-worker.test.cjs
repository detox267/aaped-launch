"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { Keypair, TransactionMessage, TransactionInstruction, VersionedTransaction } = require("@solana/web3.js");
const bs58 = require("bs58").default;
const { Prices, usdMicros } = require("../worker/prices.cjs");
const { RpcAdapter, receipt } = require("../worker/rpc-adapter.cjs");
const { digest, safeRpc, loadSigner } = require("../worker/common.cjs");
const { configFile } = require("../worker/run.cjs");

function wireFixture() {
  const operator = Keypair.generate(), mint = Keypair.generate().publicKey, quote = Keypair.generate().publicKey;
  const baseVault = Keypair.generate().publicKey, quoteVault = Keypair.generate().publicKey, launch = Keypair.generate().publicKey, program = Keypair.generate().publicKey;
  const message = new TransactionMessage({ payerKey: operator.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [
    new TransactionInstruction({ programId: program, keys: [baseVault, quoteVault].map(pubkey => ({ pubkey, isSigner: false, isWritable: true })), data: Buffer.from([6]) })
  ] }).compileToV0Message();
  const signed = new VersionedTransaction(message); signed.sign([operator]);
  const op = { kind: "sell", mint: mint.toBase58(), amount: "10", signature: bs58.encode(signed.signatures[0]),
    wire: Buffer.from(signed.serialize()).toString("base64"), messageHash: digest(message.serialize()), feeCapLamports: 10000, lastValidBlockHeight: 100,
    deadline: 50, settlement: { baseVault: baseVault.toBase58(), quoteVault: quoteVault.toBase58(), quoteMint: quote.toBase58(), quoteDecimals: 9, launch: launch.toBase58(), minOut: "20" } };
  const row = (key, mint, value, decimals) => ({ accountIndex: message.staticAccountKeys.findIndex(k => k.equals(key)), mint: mint.toBase58(),
    owner: launch.toBase58(), uiTokenAmount: { amount: String(value), decimals } });
  const tx = { slot: 8, transaction: { message, signatures: [op.signature] }, meta: { err: null, fee: 5000,
    preBalances: [100000], postBalances: [95000], loadedAddresses: { writable: [], readonly: [] },
    preTokenBalances: [row(baseVault, mint, 50, 6), row(quoteVault, quote, 100, 9)],
    postTokenBalances: [row(baseVault, mint, 40, 6), row(quoteVault, quote, 125, 9)] } };
  return { operator, program, op, tx };
}
function adapterFixture(t, rpc = {}) {
  const f = wireFixture(), dir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-rpc-")), binaryPath = path.join(dir, "program.so");
  fs.writeFileSync(binaryPath, "test fixture, not an executable");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const adapter = new RpcAdapter({ binaryPath, programId: f.program.toBase58(), operator: f.operator.publicKey.toBase58(), live: false },
    { connection: rpc, now: () => 10_000 });
  return { ...f, adapter };
}

test("USD floor uses integer precision and the real paired price, including depegs", () => {
  assert.equal(usdMicros(30_000_000n, 6, "1"), 30_000_000n);
  assert.equal(usdMicros(30_000_000n, 6, "0.99999999"), 29_999_999n);
  assert.equal(usdMicros(30_000_000n, 6, "0.98"), 29_400_000n);
  assert.equal(usdMicros(150_000_000n, 9, "2e2"), 30_000_000n);
  for (const value of ["NaN", "-1", "Infinity", "0", "1e1000"]) assert.throws(() => usdMicros(1n, 6, value));
});

test("price freshness uses the on-chain observation time, not a new HTTP timestamp", async () => {
  const mint = Keypair.generate().publicKey.toBase58(); let time = 1000, blockTime = 1, calls = 0;
  const prices = new Prices({ connection: { getBlockTime: async () => blockTime }, apiKey: "test-key", now: () => time,
    fetchJson: async () => { calls++; return { [mint]: { usdPrice: 200, decimals: 9, blockId: 7 } }; } });
  assert.equal((await prices.quote(mint, 9, 150_000_000n)).usdMicros, "30000000");
  await prices.quote(mint, 9, 1n); assert.equal(calls, 1);
  time = 40_000; await assert.rejects(prices.quote(mint, 9, 1n), /stale/);
  time = 42_000; blockTime = 43; await assert.rejects(prices.quote(mint, 9, 1n), /stale/);
});

test("price provider failure, missing tokens, wrong decimals and absent key fail closed", async () => {
  const mint = Keypair.generate().publicKey.toBase58();
  for (const result of [{}, { [mint]: { usdPrice: 2, decimals: 6, blockId: 1 } }]) {
    const prices = new Prices({ connection: { getBlockTime: async () => 0 }, apiKey: "test", now: () => 1000, fetchJson: async () => result });
    await assert.rejects(prices.quote(mint, 9, 1n));
  }
  const prices = new Prices({ connection: {}, apiKey: "", fetchJson: async () => { throw new Error("must not request"); } });
  await assert.rejects(prices.quote(mint, 9, 1n), /key/);
});

test("settlement verifies exact debit, paired credit, account owner, message and gas-only spending", () => {
  const good = wireFixture(); assert.equal(receipt(good.op, good.tx).quoteDelta, "25");
  const mutations = [
    ({ tx }) => { tx.meta.postTokenBalances[0].uiTokenAmount.amount = "41"; },
    ({ tx }) => { tx.meta.postTokenBalances[1].uiTokenAmount.amount = "119"; },
    ({ tx }) => { tx.meta.postTokenBalances[1].owner = Keypair.generate().publicKey.toBase58(); },
    ({ tx }) => { tx.meta.postTokenBalances[1].mint = Keypair.generate().publicKey.toBase58(); },
    ({ tx }) => { tx.meta.postTokenBalances.push(tx.meta.postTokenBalances[1]); },
    ({ tx }) => { tx.meta.postBalances[0]--; },
    ({ tx }) => { tx.meta.fee = 10001; },
    ({ op }) => { op.messageHash = "wrong"; },
    ({ tx }) => { tx.meta.err = { failed: true }; },
  ];
  for (const change of mutations) { const f = wireFixture(); change(f); assert.throws(() => receipt(f.op, f.tx)); }
});

test("confirmed signatures wait; finalized receipts settle; missing expired history requires review", async t => {
  let status = { confirmationStatus: "confirmed" }, height = 10, tx = null;
  const f = adapterFixture(t, { getSignatureStatuses: async () => ({ value: [status] }), getBlockHeight: async () => height, getTransaction: async () => tx });
  assert.deepEqual(await f.adapter.reconcile(f.op), { status: "pending", rebroadcast: false });
  status = null; assert.equal((await f.adapter.reconcile(f.op)).rebroadcast, true);
  height = 101; assert.equal((await f.adapter.reconcile(f.op)).status, "review");
  tx = f.tx; assert.equal((await f.adapter.reconcile(f.op)).status, "finalized", "archival receipt can settle missing status");
  status = { confirmationStatus: "finalized", err: { failed: true } };
  assert.equal((await f.adapter.reconcile(f.op)).status, "review");
  status = { confirmationStatus: "finalized", err: null }; tx.meta.postTokenBalances[1].uiTokenAmount.amount = "101";
  assert.equal((await f.adapter.reconcile(f.op)).status, "review");
});

test("readonly adapter cannot sign or send, and stored wire mutation is detected", async t => {
  let sends = 0; const f = adapterFixture(t, { sendRawTransaction: async () => sends++ });
  await assert.rejects(f.adapter.prepare({}), /disabled/);
  await assert.rejects(f.adapter.broadcast(f.op), /disabled/);
  f.adapter.validateWire(f.op);
  assert.throws(() => f.adapter.validateWire({ ...f.op, signature: "altered" }));
  assert.throws(() => f.adapter.validateWire({ ...f.op, kind: "collect" }), /unexpected program or operation/);
  assert.equal(sends, 0);
});

test("RPC errors are scrubbed before they reach durable worker status", async () => {
  const rpc = safeRpc({ getBalance: async () => { throw new Error("https://rpc.invalid/?api-key=PRIVATE"); } });
  await assert.rejects(rpc.getBalance(), error => !error.message.includes("PRIVATE") && error.message.includes("getBalance"));
});

test("signer loader rejects wrong identities and permissive files without printing key material", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-signer-")), file = path.join(dir, "key.json"), signer = Keypair.generate();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(file, JSON.stringify([...signer.secretKey]), { mode: 0o600 });
  assert(loadSigner(file, signer.publicKey).publicKey.equals(signer.publicKey));
  assert.throws(() => loadSigner(file, Keypair.generate().publicKey), /identity/);
  fs.chmodSync(file, 0o644); assert.throws(() => loadSigner(file, signer.publicKey), /permissions/);
  assert.throws(() => configFile(file), /owner-only/);
});
