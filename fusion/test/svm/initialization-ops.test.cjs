const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path");
const { LiteSVM, FailedTransactionMetadata } = require("litesvm");
const { getTransactionDecoder } = require("@solana/kit");
const web3 = require("@solana/web3.js"), { PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } = web3;
const { PINS, INITIALIZE, initializeInstruction, checkInitializedConfig } = require("../../ops/deploy-inactive-vps.cjs");
const c = require("../../client/index.cjs");
test("the exact deployed artifact executes the bootstrap within its CU cap, stays paused, and retains loader authority", () => {
  // Local VM only: production private keys are neither available nor needed.
  const svm = new LiteSVM().withSigverify(false).withTransactionHistory(0n);
  const program = new PublicKey(PINS.program), admin = new PublicKey(PINS.admin), a = c.addresses(program);
  svm.addProgramFromFile(PINS.program, path.join(__dirname, "../../target/deploy/moonz_fusion.so"));
  svm.airdrop(PINS.admin, 2000000000n);
  const original = svm.getAccount(a.programData.toBase58()), bytes = Buffer.from(original.data);
  bytes[12] = 1; admin.toBuffer().copy(bytes, 13);
  svm.setAccount({ address: a.programData.toBase58(), programAddress: PINS.loader,
    data: bytes, lamports: original.lamports, executable: false });
  const message = new TransactionMessage({ payerKey: admin, recentBlockhash: svm.latestBlockhash(),
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: INITIALIZE.computeUnits }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: INITIALIZE.microLamportsPerCu }),
      initializeInstruction(web3)] }).compileToV0Message();
  const tx = new VersionedTransaction(message), decoded = getTransactionDecoder().decode(tx.serialize());
  const outcome = svm.sendTransaction(decoded);
  assert(!(outcome instanceof FailedTransactionMetadata), outcome instanceof FailedTransactionMetadata ? outcome.meta().logs().join("\n") : "");
  assert(outcome.computeUnitsConsumed() < BigInt(INITIALIZE.computeUnits));
  const account = svm.getAccount(a.config.toBase58());
  const cfg = checkInitializedConfig({ owner: new PublicKey(account.programAddress), executable: account.executable,
    data: Buffer.from(account.data) }, PublicKey);
  assert.equal(cfg.paused, true);
  assert.equal(cfg.maxSwapRaw, "1");
  assert.deepEqual(Buffer.from(svm.getAccount(a.programData.toBase58()).data), bytes);
  const repeat = svm.sendTransaction(decoded);
  assert(repeat instanceof FailedTransactionMetadata, "A second initialization must not overwrite config");
  assert.deepEqual(Buffer.from(svm.getAccount(a.config.toBase58()).data), Buffer.from(account.data));
});
