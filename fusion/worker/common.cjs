"use strict";
const crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path");
const { PublicKey, Keypair, TransactionInstruction } = require("@solana/web3.js");
const need = (ok, message) => { if (!ok) throw new Error(message); };
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const pk = value => new PublicKey(value);
function raw(value, name = "amount") {
  need(typeof value === "string" && /^(0|[1-9]\d*)$/.test(value), `Invalid ${name}`);
  const n = BigInt(value); need(n <= 0xffffffffffffffffn, `${name} exceeds u64`); return n;
}
function encodeInstruction(ix) {
  return { programId: ix.programId.toBase58(), keys: ix.keys.map(k => ({ ...k, pubkey: k.pubkey.toBase58() })), data: ix.data.toString("base64") };
}
function decodeInstruction(ix) {
  return new TransactionInstruction({ programId: pk(ix.programId), keys: ix.keys.map(k => ({ ...k, pubkey: pk(k.pubkey) })), data: Buffer.from(ix.data, "base64") });
}
function privateFile(filename) {
  need(path.isAbsolute(filename), "Use an absolute private file path");
  const stat = fs.lstatSync(filename);
  need(stat.isFile() && !(stat.mode & 0o077) && stat.uid === process.getuid() && stat.size <= 64 * 1024,
    "Private file must be a regular owner-only file owned by this user");
  return fs.readFileSync(filename, "utf8");
}
function loadSigner(filename, expected) {
  let bytes, key;
  try {
    const values = JSON.parse(privateFile(filename));
    need(Array.isArray(values) && values.length === 64 && values.every(n => Number.isInteger(n) && n >= 0 && n <= 255), "Invalid key file");
    bytes = Uint8Array.from(values); values.fill(0); key = Keypair.fromSecretKey(bytes);
    need(key.publicKey.equals(pk(expected)), "Signing key does not match the configured operator");
    return key;
  } catch { key?.secretKey.fill(0); throw new Error("Signer identity or file permissions failed verification"); }
  finally { bytes?.fill(0); }
}
// Never persist RPC URLs/provider error payloads, which may contain credentials.
function safeRpc(connection) {
  return new Proxy(connection, { get(target, name) {
    const value = Reflect.get(target, name);
    if (typeof value !== "function") return value;
    return async (...args) => { try { return await value.apply(target, args); }
      catch { throw new Error(`RPC ${String(name)} failed; inspect provider health locally`); } };
  } });
}
function layoutAccount(info, owner, layout, name) {
  need(info && info.owner.equals(owner) && !info.executable && info.data.length === layout.span
    && info.data.subarray(0, 8).equals(crypto.createHash("sha256").update(`account:${name}`).digest().subarray(0, 8)),
  `Invalid ${name} account`);
  return layout.decode(info.data);
}
module.exports = { need, digest, pk, raw, encodeInstruction, decodeInstruction, privateFile, loadSigner, safeRpc, layoutAccount };
