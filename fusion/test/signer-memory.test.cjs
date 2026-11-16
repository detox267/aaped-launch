'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {Keypair, TransactionMessage, VersionedTransaction, SystemProgram} = require('@solana/web3.js');
const crypto = require('node:crypto'), common = require('../worker/common.cjs');
function fixture(t) {
  const original = Keypair.generate(), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-signer-'));
  const file = path.join(directory, 'generated-test-key.json'), contents = JSON.stringify([...original.secretKey]);
  fs.writeFileSync(file, contents, {mode: 0o600});
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return {original, file, contents};
}
test('file-loaded Fusion signer creates a valid transaction signature without altering its key file', t => {
  const f = fixture(t), loaded = common.loadSigner(f.file, f.original.publicKey);
  t.after(() => common.destroySigner(loaded));
  const tx = new VersionedTransaction(new TransactionMessage({payerKey: loaded.publicKey,
    recentBlockhash: String(Keypair.generate().publicKey), instructions: [SystemProgram.transfer({
      fromPubkey: loaded.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1})]}).compileToV0Message());
  tx.sign([loaded]);
  assert.equal(crypto.verify(null, tx.message.serialize(), crypto.createPublicKey({format: 'der', type: 'spki',
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), f.original.publicKey.toBuffer()])}), tx.signatures[0]), true);
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.contents);
});
test('signer disposal clears only its owned memory and preserves the file and other signer instances', t => {
  const f = fixture(t), first = common.loadSigner(f.file, f.original.publicKey), second = common.loadSigner(f.file, f.original.publicKey);
  t.after(() => common.destroySigner(second));
  common.destroySigner(first); common.destroySigner(first);
  assert(first.secretKey.every(byte => byte === 0));
  assert.deepEqual(second.secretKey, f.original.secretKey);
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.contents);
});
test('wrong signer, malformed key, symlink and public permissions stay rejected without leaking file contents', t => {
  const f = fixture(t), expected = 'Signer identity or file permissions failed verification';
  const fails = (file, key = f.original.publicKey) => assert.throws(() => common.loadSigner(file, key), {message: expected});
  fails(f.file, Keypair.generate().publicKey);
  fs.chmodSync(f.file, 0o644); fails(f.file); fs.chmodSync(f.file, 0o600);
  const link = f.file + '.link'; fs.symlinkSync(f.file, link); fails(link);
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.contents);
  fs.writeFileSync(f.file, '["generated malformed value"]'); fails(f.file);
});
