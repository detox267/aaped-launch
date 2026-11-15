"use strict";
// Platform-funded distribution sender. Policy/tier selection stays with the backend.
// Every signed wire and fee reservation is committed before broadcasting. A payout
// cannot borrow from the holder pot or from an unverified operator-wallet deposit.
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs"),
  path = require("node:path");
const {
  VersionedTransaction,
  TransactionMessage,
  TransactionInstruction,
  ComputeBudgetProgram,
} = require("@solana/web3.js");
const spl = require("@solana/spl-token"),
  sdk = require("@raydium-io/raydium-sdk-v2"),
  bs58 = require("bs58").default;
const c = require("../client/index.cjs"),
  r = require("../client/rewards.cjs");
const { need, pk, raw, digest, encodeInstruction } = require("./common.cjs");
const { tokenDelta } = require("./rpc-adapter.cjs");
const tags = { fund: 17, open: 14, pay: 15, close: 16 };
const exact = (n) => raw(typeof n === "bigint" ? String(n) : n);

function requestInstruction(adapter, request) {
  const { program, operator } = adapter;
  if (request.kind === "fund")
    return c.fundDistributionFees(
      program,
      operator,
      request.mint,
      request.amount,
    );
  if (request.kind === "open")
    return r.openRound(program, operator, request.mint, request.round);
  if (request.kind === "pay")
    return r.pay(program, request.mint, request.payment);
  return r.closeRound(program, request.mint);
}

class DistributionFeeStore {
  constructor(filename, program, operator) {
    if (filename !== ":memory:") {
      need(
        path.isAbsolute(filename),
        "Distribution journal needs an absolute private path",
      );
      const directory = fs.lstatSync(path.dirname(filename));
      need(
        directory.isDirectory() &&
          !(directory.mode & 0o077) &&
          directory.uid === process.getuid(),
        "Distribution journal directory must be owner-only",
      );
      try {
        fs.closeSync(fs.openSync(filename, "wx", 0o600));
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const stat = fs.lstatSync(filename);
      need(
        stat.isFile() && !(stat.mode & 0o077) && stat.uid === process.getuid(),
        "Distribution journal must be an owner-only regular file",
      );
    }
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS distribution_fee_identity(program TEXT NOT NULL, operator TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS distribution_fee_ops(id TEXT PRIMARY KEY, signature TEXT UNIQUE NOT NULL, data TEXT NOT NULL);`);
    const id = this.db.prepare("SELECT * FROM distribution_fee_identity").get();
    if (
      id &&
      (id.program !== String(program) || id.operator !== String(operator))
    ) {
      this.db.close();
      throw Error("Distribution journal belongs to another program/operator");
    }
    if (!id)
      this.db
        .prepare("INSERT INTO distribution_fee_identity VALUES (?,?)")
        .run(String(program), String(operator));
  }
  get(id) {
    const row = this.db
      .prepare("SELECT data FROM distribution_fee_ops WHERE id=?")
      .get(id);
    return row ? JSON.parse(row.data) : null;
  }
  all() {
    return this.db
      .prepare("SELECT data FROM distribution_fee_ops ORDER BY rowid")
      .all()
      .map((x) => JSON.parse(x.data));
  }
  balance() {
    let funded = 0n,
      spent = 0n,
      reserved = 0n;
    for (const op of this.all()) {
      if (op.receipt) {
        spent += BigInt(op.receipt.feeLamports);
        if (op.kind === "fund" && op.receipt.status === "finalized")
          funded += BigInt(op.amount);
      } else if (op.kind !== "fund") reserved += BigInt(op.feeCapLamports);
    }
    return { funded, spent, reserved, available: funded - spent - reserved };
  }
  savePrepared(op) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      need(
        !this.get(op.id),
        "Operation already recorded; reconcile the original signature",
      );
      need(
        Object.hasOwn(tags, op.kind) && op.status === "pending" && !op.receipt,
        "Invalid prepared distribution",
      );
      need(
        !this.all().some(
          (existing) =>
            existing.mint === op.mint &&
            ["pending", "review"].includes(existing.status),
        ),
        "Reconcile the pending distribution first",
      );
      if (op.kind !== "fund")
        need(
          this.balance().available >= BigInt(op.feeCapLamports),
          "Platform fee reserve is insufficient; holder funds remain untouched",
        );
      this.db
        .prepare("INSERT INTO distribution_fee_ops VALUES (?,?,?)")
        .run(op.id, op.signature, JSON.stringify(op));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  settle(id, receipt) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const op = this.get(id);
      need(op, "Unknown distribution operation");
      if (op.receipt) {
        need(
          JSON.stringify(op.receipt) === JSON.stringify(receipt),
          "Conflicting finalized receipt",
        );
        this.db.exec("COMMIT");
        return op;
      }
      need(
        ["finalized", "failed"].includes(receipt.status) &&
          Number.isSafeInteger(receipt.feeLamports) &&
          receipt.feeLamports >= 0 &&
          receipt.feeLamports <= op.feeCapLamports,
        "Invalid distribution fee receipt",
      );
      op.status = receipt.status;
      op.receipt = receipt;
      this.db
        .prepare("UPDATE distribution_fee_ops SET data=? WHERE id=?")
        .run(JSON.stringify(op), id);
      this.db.exec("COMMIT");
      return op;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  review(id, reason) {
    const op = this.get(id);
    need(op && !op.receipt, "Operation already settled");
    op.status = "review";
    op.issue = reason;
    this.db
      .prepare("UPDATE distribution_fee_ops SET data=? WHERE id=?")
      .run(JSON.stringify(op), id);
    return op; // Keep the reservation until the exact signature is reconciled.
  }
  close() {
    this.db.close();
  }
}
function validateWire(op, program, operator) {
  const tx = VersionedTransaction.deserialize(Buffer.from(op.wire, "base64"));
  need(
    tx.signatures.length === 1 &&
      tx.message.staticAccountKeys[0].equals(operator) &&
      bs58.encode(tx.signatures[0]) === op.signature &&
      digest(tx.message.serialize()) === op.messageHash,
    "Distribution wire does not match its journal",
  );
  need(
    Object.hasOwn(tags, op.kind) && !tx.message.addressTableLookups.length,
    "Unexpected distribution transaction",
  );
  const calls = tx.message.compiledInstructions.filter((ix) =>
    tx.message.staticAccountKeys[ix.programIdIndex].equals(program),
  );
  need(
    calls.length === 1 &&
      calls[0].data[0] === tags[op.kind] &&
      tx.message.compiledInstructions.every((ix) =>
        [program, ComputeBudgetProgram.programId, sdk.MEMO_PROGRAM_ID].some(
          (p) => p.equals(tx.message.staticAccountKeys[ix.programIdIndex]),
        ),
      ),
    "Unexpected distribution program/instruction",
  );
  return tx;
}
function receipt(op, tx, program, operator) {
  const original = validateWire(op, program, operator);
  need(
    tx?.meta &&
      Number.isSafeInteger(tx.slot) &&
      tx.slot >= 0 &&
      tx.transaction.signatures[0] === op.signature &&
      digest(tx.transaction.message.serialize()) === op.messageHash,
    "Unbound distribution receipt",
  );
  const keys = original.message.staticAccountKeys;
  const fee = tx.meta.fee,
    pre = tx.meta.preBalances,
    post = tx.meta.postBalances;
  need(
    Number.isSafeInteger(fee) &&
      fee >= 0 &&
      fee <= op.feeCapLamports &&
      Array.isArray(pre) &&
      Array.isArray(post) &&
      pre.length === keys.length &&
      post.length === keys.length &&
      [...pre, ...post].every((n) => Number.isSafeInteger(n) && n >= 0),
    "Invalid distribution fee or balances",
  );
  need(Object.hasOwn(tx.meta, "err"), "Missing finalized transaction status");
  const failed = tx.meta.err !== null;
  let credited = 0n;
  if (op.kind === "fund" && !failed) {
    credited = BigInt(op.amount);
    need(
      tokenDelta(
        tx,
        op.settlement.quoteVault,
        spl.NATIVE_MINT.toBase58(),
        op.settlement.launch,
        9,
      ) === -credited,
      "Funding did not debit the recorded platform vault",
    );
  } else if (!failed && op.kind === "pay") {
    const s = op.settlement,
      amount = BigInt(op.amount);
    need(
      tokenDelta(tx, s.moonzVault, r.MOONZ.toBase58(), s.rewards, 6) ===
        -amount &&
        tokenDelta(tx, s.destination, r.MOONZ.toBase58(), op.recipient, 6) ===
          amount,
      "Holder did not receive the full MOONZ reward",
    );
  }
  need(
    BigInt(post[0]) - BigInt(pre[0]) === credited - BigInt(fee),
    "Distribution sender debit differs from platform funding and network fee",
  );
  // No recipient or unrelated account can subsidize a payout or failed send.
  for (let i = 1; i < keys.length; i++) {
    const expected =
      op.kind === "fund" &&
      !failed &&
      keys[i].equals(pk(op.settlement.quoteVault))
        ? -credited
        : 0n;
    need(
      BigInt(post[i]) - BigInt(pre[i]) === expected,
      "Unexpected SOL movement during distribution",
    );
  }
  return {
    status: failed ? "failed" : "finalized",
    slot: tx.slot,
    feeLamports: fee,
    expenseSource: "platform-share",
  };
}

class PlatformDistributionSender {
  // Adapter is the same verified RpcAdapter used by the collector; do not pass an unverified RPC-only substitute in production.
  constructor({ adapter, store }) {
    this.adapter = adapter;
    this.store = store;
    this.rpc = adapter.rpc;
    this.lastSent = new Map();
    const identity = store.db
      .prepare("SELECT * FROM distribution_fee_identity")
      .get();
    need(
      identity.program === adapter.program.toBase58() &&
        identity.operator === adapter.operator.toBase58(),
      "Fee store identity differs from verified adapter",
    );
  }
  async prepare(request) {
    const a = this.adapter,
      cfg = a.config;
    need(
      cfg.live === true && a.signer && !a.stopping,
      "Distribution signing is disabled",
    );
    need(
      typeof request.id === "string" &&
        /^[A-Za-z0-9_:/.-]{1,160}$/.test(request.id) &&
        Object.hasOwn(tags, request.kind),
      "Invalid distribution request",
    );
    const intentHash = digest(
      Buffer.from(
        JSON.stringify(encodeInstruction(requestInstruction(a, request))),
      ),
    );
    const existing = this.store.get(request.id);
    if (existing) {
      need(
        existing.kind === request.kind &&
          existing.mint === pk(request.mint).toBase58() &&
          existing.intentHash === intentHash,
        "Distribution ID already belongs to different instructions",
      );
      return existing;
    }
    need(
      !this.store
        .all()
        .some(
          (op) =>
            op.mint === String(request.mint) &&
            ["pending", "review"].includes(op.status),
        ),
      "Reconcile the pending distribution first",
    );
    await a.ready();
    const base = pk(request.mint),
      addresses = r.addresses(a.program, base);
    const minContextSlot = request.minContextSlot || 0;
    const info = await this.rpc.getAccountInfo(addresses.launch, {
      commitment: "finalized",
      minContextSlot,
    });
    need(info?.owner.equals(a.program), "Distribution launch missing");
    const launch = c.decodeLaunch(info.data);
    need(launch.base.equals(base), "Distribution launch mint mismatch");
    let instruction,
      settlement,
      amount = null,
      recipient = null;
    if (request.kind === "fund") {
      amount = String(exact(request.amount));
      need(
        launch.quote.equals(spl.NATIVE_MINT) &&
          launch.quoteProgram.equals(spl.TOKEN_PROGRAM_ID),
        "Only platform SOL can fund the reserve; convert platform proceeds separately",
      );
      need(
        BigInt(amount) <= launch.platformAvailable,
        "Platform budget insufficient; never use holder rewards",
      );
      instruction = c.fundDistributionFees(a.program, a.operator, base, amount);
      settlement = {
        launch: addresses.launch.toBase58(),
        quoteVault: c
          .addresses(a.program, base, spl.NATIVE_MINT)
          .quoteVault.toBase58(),
      };
    } else {
      need(launch.version === 2, "MOONZ reward launch required");
      if (request.kind === "open")
        instruction = r.openRound(a.program, a.operator, base, request.round);
      if (request.kind === "close") instruction = r.closeRound(a.program, base);
      if (request.kind === "pay") {
        const p = request.payment;
        amount = String(exact(p.amount));
        recipient = pk(p.recipient).toBase58();
        instruction = r.pay(a.program, base, { ...p, amount });
        settlement = {
          rewards: addresses.rewards.toBase58(),
          moonzVault: addresses.moonzVault.toBase58(),
          destination: spl
            .getAssociatedTokenAddressSync(r.MOONZ, pk(recipient))
            .toBase58(),
        };
      }
      need(
        this.store.balance().available >= BigInt(cfg.maxFeeLamports),
        "Platform fee reserve is insufficient; distribution waits without reducing holder rewards",
      );
    }
    const block = await this.rpc.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: a.operator,
      recentBlockhash: block.blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 250000 }),
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: cfg.priorityMicroLamports,
        }),
        new TransactionInstruction({
          programId: sdk.MEMO_PROGRAM_ID,
          keys: [],
          data: Buffer.from(request.id),
        }),
        instruction,
      ],
    }).compileToV0Message();
    const fee = (await this.rpc.getFeeForMessage(message, "confirmed")).value;
    need(
      Number.isSafeInteger(fee) && fee > 0 && fee <= cfg.maxFeeLamports,
      "Distribution fee exceeds cap",
    );
    const balance = await this.rpc.getBalance(a.operator, "finalized");
    const rent =
      request.kind === "fund"
        ? await this.rpc.getMinimumBalanceForRentExemption(spl.ACCOUNT_SIZE)
        : 0;
    need(
      Number.isSafeInteger(balance) &&
        Number.isSafeInteger(rent) &&
        BigInt(balance) - BigInt(fee) - BigInt(rent) >= raw(cfg.minSolLamports),
      "Operator needs platform-funded SOL before distribution",
    );
    const tx = new VersionedTransaction(message);
    tx.sign([a.signer]);
    const wire = Buffer.from(tx.serialize());
    need(wire.length <= 1232, "Distribution exceeds packet limit");
    const simulation = await this.rpc.simulateTransaction(tx, {
      sigVerify: true,
      commitment: "confirmed",
      minContextSlot,
    });
    need(!simulation.value.err, "Distribution simulation failed; no broadcast");
    const op = {
      id: request.id,
      intentHash,
      kind: request.kind,
      mint: base.toBase58(),
      amount,
      recipient,
      settlement: !settlement ? null : settlement,
      status: "pending",
      wire: wire.toString("base64"),
      signature: bs58.encode(tx.signatures[0]),
      messageHash: digest(message.serialize()),
      feeCapLamports: cfg.maxFeeLamports,
      lastValidBlockHeight: block.lastValidBlockHeight,
      createdAt: a.now(),
    };
    this.store.savePrepared(op);
    return op;
  }
  async broadcast(id) {
    const a = this.adapter;
    need(
      a.config.live === true && !a.stopping,
      "Distribution broadcasting disabled",
    );
    const op = this.store.get(id);
    need(op && op.status === "pending", "No pending distribution");
    validateWire(op, a.program, a.operator);
    await a.ready();
    if (a.stopping) return;
    if ((await this.rpc.getBlockHeight("confirmed")) > op.lastValidBlockHeight)
      return;
    if (a.now() - (this.lastSent.get(op.signature) ?? -Infinity) < 10000)
      return;
    this.lastSent.set(op.signature, a.now());
    const signature = await this.rpc.sendRawTransaction(
      Buffer.from(op.wire, "base64"),
      { skipPreflight: false, maxRetries: 0 },
    );
    need(
      signature === op.signature,
      "Different distribution signature returned",
    );
  }
  async reconcile(id) {
    const a = this.adapter,
      op = this.store.get(id);
    need(op, "Unknown distribution operation");
    if (op.receipt) return op;
    validateWire(op, a.program, a.operator);
    const result = await this.rpc.getSignatureStatuses([op.signature], {
      searchTransactionHistory: true,
    });
    need(
      result.value?.length === 1,
      "Incomplete distribution signature status",
    );
    const status = result.value[0];
    if (
      status?.confirmationStatus === "finalized" ||
      (!status &&
        (await this.rpc.getBlockHeight("finalized")) > op.lastValidBlockHeight)
    ) {
      const tx = await this.rpc.getTransaction(op.signature, {
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) {
        if (status) return op;
        return this.store.review(
          id,
          "Expired signature has no verifiable history; do not re-sign",
        );
      }
      try {
        return this.store.settle(id, receipt(op, tx, a.program, a.operator));
      } catch {
        return this.store.review(
          id,
          "Finalized distribution receipt requires review; do not charge holders",
        );
      }
    }
    return op;
  }
}
module.exports = {
  DistributionFeeStore,
  PlatformDistributionSender,
  receipt,
  validateWire,
};
