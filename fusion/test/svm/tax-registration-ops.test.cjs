const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path");
const { LiteSVM, FailedTransactionMetadata, Clock } = require("litesvm");
const { getTransactionDecoder } = require("@solana/kit");
const web3 = require("@solana/web3.js");
const { PINS, INITIALIZE, TAX_REGISTRATION, taxAuthorityInstruction, checkTaxAuthorityChange } = require("../../ops/deploy-inactive-vps.cjs");
const fixture = require("../fixtures/accounts.json");
test("real Raydium bytecode applies only the intended tax-authority and epoch changes within the capped transaction", () => {
  const svm = new LiteSVM().withSigverify(false).withTransactionHistory(0n);
  svm.addProgramFromFile(INITIALIZE.launchlab, path.join(__dirname, "../fixtures/launchlab.so"));
  svm.airdrop(PINS.admin, 2000000000n);
  for (const address of [INITIALIZE.platform, INITIALIZE.cpConfig]) {
    const a = fixture.accounts.find(a => a.address === address);
    svm.setAccount({ address, programAddress: a.owner, lamports: BigInt(a.lamports), executable: false, data: Buffer.from(a.data, "base64") });
  }
  const account = svm.getAccount(INITIALIZE.platform), before = { owner: new web3.PublicKey(account.programAddress),
    data: Buffer.from(account.data), executable: account.executable, lamports: account.lamports };
  const clock = svm.getClock();
  svm.setClock(new Clock(clock.slot, clock.epochStartTimestamp, before.data.readBigUInt64LE(8) + 1n,
    clock.leaderScheduleEpoch, clock.unixTimestamp));
  const make = ix => new web3.VersionedTransaction(new web3.TransactionMessage({
    payerKey: new web3.PublicKey(PINS.admin), recentBlockhash: svm.latestBlockhash(), instructions: [
      web3.ComputeBudgetProgram.setComputeUnitLimit({ units: TAX_REGISTRATION.computeUnits }),
      web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: TAX_REGISTRATION.microLamportsPerCu }), ix,
    ] }).compileToV0Message());
  const instruction = taxAuthorityInstruction(web3, before.data);
  const wrong = taxAuthorityInstruction(web3, before.data); wrong.keys[0].pubkey = web3.Keypair.generate().publicKey;
  const denied = svm.sendTransaction(getTransactionDecoder().decode(make(wrong).serialize()));
  assert(denied instanceof FailedTransactionMetadata, "Another signer cannot change this platform");
  assert.deepEqual(Buffer.from(svm.getAccount(INITIALIZE.platform).data), before.data);
  const result = svm.sendTransaction(getTransactionDecoder().decode(make(instruction).serialize()));
  assert(!(result instanceof FailedTransactionMetadata), result instanceof FailedTransactionMetadata ? result.meta().logs().join("\n") : "");
  assert(result.computeUnitsConsumed() < BigInt(TAX_REGISTRATION.computeUnits));
  const next = svm.getAccount(INITIALIZE.platform);
  const checked = checkTaxAuthorityChange(before, { owner: new web3.PublicKey(next.programAddress), data: Buffer.from(next.data),
    executable: next.executable, lamports: next.lamports }, web3.PublicKey);
  assert.equal(checked.platformTaxAuthorityReady, true);
  assert.equal(checked.otherPlatformSettingsUnchanged, true);
});
