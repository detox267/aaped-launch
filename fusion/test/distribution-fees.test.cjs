const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { Keypair } = require("@solana/web3.js");
const { DistributionFeeStore } = require("../worker/distribution-fees.cjs");
const c = require("../client/index.cjs");
const key = () => Keypair.generate().publicKey.toBase58();
const op = (id, kind = "pay", amount = "10") => ({
  id,
  kind,
  amount,
  mint: "fixture-ca/" + id,
  signature: id,
  status: "pending",
  feeCapLamports: 25000,
});
const receipt = (fee = 5000, status = "finalized") => ({
  status,
  slot: 123,
  feeLamports: fee,
  expenseSource: "platform-share",
});
test("only settled platform funding authorizes gas; pending payout fees are reserved atomically", () => {
  const s = new DistributionFeeStore(":memory:", key(), key());
  try {
    assert.throws(() => s.savePrepared(op("a")), /Platform fee reserve/);
    s.savePrepared(op("fund", "fund", "100000"));
    assert.equal(s.balance().available, 0n);
    s.settle("fund", receipt());
    assert.equal(s.balance().available, 95000n);
    s.savePrepared(op("one"));
    s.savePrepared(op("two"));
    s.savePrepared(op("three"));
    assert.throws(() => s.savePrepared(op("four")), /Platform fee reserve/);
    s.settle("one", receipt());
    assert.equal(s.balance().available, 40000n);
    assert.equal(s.balance().spent, 10000n);
    s.settle("one", receipt());
    assert.equal(s.balance().spent, 10000n);
    assert.throws(() => s.settle("one", receipt(6000)), /Conflicting/);
  } finally {
    s.close();
  }
});
test("failed sends still cost the platform; unknown history keeps its reservation", () => {
  const s = new DistributionFeeStore(":memory:", key(), key());
  try {
    s.savePrepared(op("fund", "fund", "100000"));
    s.settle("fund", receipt());
    s.savePrepared(op("failed"));
    s.settle("failed", receipt(6000, "failed"));
    assert.equal(s.balance().spent, 11000n);
    s.savePrepared(op("unknown"));
    s.review("unknown", "No verifiable history");
    assert.equal(s.balance().reserved, 25000n);
    assert.equal(s.balance().available, 64000n);
  } finally {
    s.close();
  }
});
test("fee journal survives restart, rejects duplicate signatures and binds operator/program", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moonz-fees-")),
    file = path.join(dir, "fees.sqlite"),
    program = key(),
    operator = key();
  let s = new DistributionFeeStore(file, program, operator);
  try {
    s.savePrepared(op("fund", "fund", "100000"));
    s.settle("fund", receipt());
    s.savePrepared(op("pay"));
    s.close();
    s = new DistributionFeeStore(file, program, operator);
    assert.equal(s.balance().available, 70000n);
    assert.equal(s.get("pay").status, "pending");
    assert.throws(() => s.savePrepared({ ...op("other"), signature: "pay" }));
    assert.equal(s.balance().reserved, 25000n);
    assert.throws(
      () => new DistributionFeeStore(file, program, key()),
      /another program/,
    );
  } finally {
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("platform top-ups are explicitly bounded, never a holder-fee parameter", () => {
  const program = key(),
    operator = key(),
    base = key();
  const instruction = c.fundDistributionFees(
    program,
    operator,
    base,
    "10000000",
  );
  assert.equal(instruction.data[0], 17);
  assert.equal(instruction.keys[0].pubkey.toBase58(), operator);
  assert.equal(instruction.keys[5].pubkey.toBase58(), operator);
  assert.throws(() => c.fundDistributionFees(program, operator, base, "0"));
  assert.throws(() =>
    c.fundDistributionFees(
      program,
      operator,
      base,
      String(c.MAX_DISTRIBUTION_TOPUP + 1n),
    ),
  );
});
