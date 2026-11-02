"use strict";
const fs = require("node:fs");
const { Connection, VersionedTransaction, TransactionMessage, TransactionInstruction, ComputeBudgetProgram } = require("@solana/web3.js");
const bs58 = require("bs58").default, spl = require("@solana/spl-token"), sdk = require("@raydium-io/raydium-sdk-v2");
const c = require("../client/index.cjs"), { check } = require("../ops/check-verification.cjs");
const { Prices } = require("./prices.cjs"), { raydiumQuote } = require("./quotes.cjs");
const { need, digest, pk, raw, safeRpc, decodeInstruction } = require("./common.cjs");
const GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const COMMITMENT = "finalized";

function vault(key, info, mint, owner, program) {
  const account = spl.unpackAccount(key, info, program);
  need(account.mint.equals(mint) && account.owner.equals(owner) && account.isInitialized && !account.isFrozen
    && !account.delegate && !account.closeAuthority, "Invalid PDA vault");
  return account;
}
function tokenDelta(tx, key, mint, owner, decimals) {
  const keys = [...tx.transaction.message.staticAccountKeys,
    ...(tx.meta.loadedAddresses?.writable || []), ...(tx.meta.loadedAddresses?.readonly || [])];
  const index = keys.findIndex(k => k.equals(pk(key))); need(index >= 0, "Receipt vault missing");
  const value = rows => {
    need(Array.isArray(rows), "Missing receipt balances");
    const found = rows.filter(row => row.accountIndex === index);
    need(found.length === 1 && found[0].mint === mint && found[0].owner === owner
      && found[0].uiTokenAmount?.decimals === decimals, "Receipt token binding mismatch");
    return raw(found[0].uiTokenAmount.amount, "receipt balance");
  };
  return value(tx.meta.postTokenBalances) - value(tx.meta.preTokenBalances);
}
function receipt(op, tx) {
  need(tx?.meta && !tx.meta.err && Number.isSafeInteger(tx.slot) && tx.slot >= 0, "Invalid finalized receipt");
  need(tx.transaction.signatures[0] === op.signature && digest(tx.transaction.message.serialize()) === op.messageHash,
    "Finalized message differs from journal");
  need(Number.isSafeInteger(tx.meta.fee) && tx.meta.fee >= 0 && tx.meta.fee <= op.feeCapLamports, "Receipt fee exceeds cap");
  const before = tx.meta.preBalances?.[0], after = tx.meta.postBalances?.[0];
  need(Number.isSafeInteger(before) && Number.isSafeInteger(after) && before - after === tx.meta.fee,
    "Unexpected operator debit");
  const e = op.settlement;
  const baseDelta = tokenDelta(tx, e.baseVault, op.mint, e.launch, 6);
  let quoteDelta = 0n;
  if (op.kind === "collect") need(baseDelta >= 0n, "Collection debited base vault");
  else {
    quoteDelta = tokenDelta(tx, e.quoteVault, e.quoteMint, e.launch, e.quoteDecimals);
    need(baseDelta === -raw(op.amount) && quoteDelta >= raw(e.minOut), "Sale receipt amount mismatch");
  }
  return { status: "finalized", slot: tx.slot, baseDelta: String(baseDelta), quoteDelta: String(quoteDelta), feeLamports: tx.meta.fee };
}

class RpcAdapter {
  constructor(config, { connection, signer = null, prices, verification, now = Date.now } = {}) {
    this.config = config; this.program = pk(config.programId); this.operator = pk(config.operator);
    this.signer = signer; this.now = now; this.stopping = false;
    if (signer) need(signer.publicKey.equals(this.operator), "Operator signer mismatch");
    this.rpc = safeRpc(connection || new Connection(config.rpcUrl, { commitment: COMMITMENT, disableRetryOnRateLimit: true,
      fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }) }));
    this.binary = fs.readFileSync(config.binaryPath);
    this.prices = prices || new Prices({ connection: this.rpc, apiKey: config.priceApiKey, now });
    this.verification = verification || (async () => {
      const response = await fetch(`https://verify.osec.io/status/${this.program.toBase58()}`,
        { redirect: "error", signal: AbortSignal.timeout(15_000) });
      need(response.ok, "Public source verification unavailable"); return response.json();
    });
    this.issuedQuotes = new Map(); this.lastSent = new Map(); this.verified = null;
  }
  async ready() {
    need(!this.stopping, "Worker is stopping");
    if (!this.genesisChecked) { need(await this.rpc.getGenesisHash() === GENESIS, "RPC is not mainnet-beta"); this.genesisChecked = true; }
    const a = c.addresses(this.program);
    const [program, programData, account] = await this.rpc.getMultipleAccountsInfo([this.program, a.programData, a.config], COMMITMENT);
    let verification = this.verified?.value;
    if (!verification || this.now() - this.verified.at > 30_000 || this.now() < this.verified.at) {
      try { verification = await this.verification(); } catch { throw new Error("Public source verification unavailable"); }
      this.verified = { at: this.now(), value: verification };
    }
    check({ programId: this.program.toBase58(), expectedAuthority: this.config.upgradeAuthority,
      expectedCommit: this.config.releaseCommit, binary: this.binary, program, programData, verification });
    need(account?.owner.equals(this.program), "Fusion config missing or wrong owner");
    const cfg = c.decodeConfig(account.data);
    for (const key of ["admin", "operator", "feeWallet", "platform", "cpConfig"])
      need(cfg[key].equals(pk(this.config[key])), `Fusion ${key} changed`);
    need(!cfg.paused, "Fusion is paused");
    need(raw(this.config.maxSwapRaw) <= cfg.maxSwapRaw, "Local swap cap exceeds on-chain cap");
    const platform = await this.rpc.getAccountInfo(cfg.platform, COMMITMENT), d = platform?.data;
    need(platform?.owner.equals(c.LAUNCHLAB) && d.length === 944
      && d.subarray(0, 8).toString("hex") === digest(Buffer.from("account:PlatformConfig")).slice(0, 16)
      && [80, 88, 104, 720].every(i => d.readBigUInt64LE(i) === 0n) && d.readBigUInt64LE(96) === 1_000_000n
      && pk(d.subarray(688, 720)).equals(cfg.cpConfig) && pk(d.subarray(728, 760)).equals(a.taxAuthority),
    "Platform fee, migration or tax-authority configuration differs");
    const balance = await this.rpc.getBalance(this.operator, COMMITMENT);
    need(Number.isSafeInteger(balance) && BigInt(balance) >= raw(this.config.minSolLamports), "Operator SOL reserve is too low");
    this.onchain = cfg; return cfg;
  }
  async discover() {
    const result = await this.rpc.getProgramAccounts(this.program, { commitment: COMMITMENT, withContext: true, filters: [{ dataSize: 393 }] });
    need(Array.isArray(result.value), "Incomplete launch discovery");
    return result.value.map(({ pubkey, account }) => {
      const state = c.decodeLaunch(account.data);
      need(account.owner.equals(this.program) && pubkey.equals(c.addresses(this.program, state.base).launch), "Invalid discovered launch");
      return state.base.toBase58();
    });
  }
  async inspect(mint, minContextSlot = 0) {
    const base = pk(mint), options = { commitment: COMMITMENT, minContextSlot };
    const launch = c.addresses(this.program, base).launch;
    const info = await this.rpc.getAccountInfo(launch, options);
    need(info?.owner.equals(this.program), "Launch PDA missing");
    const state = c.decodeLaunch(info.data);
    need(state.base.equals(base), "Launch mint mismatch");
    const a = c.addresses(this.program, base, state.quote, state.quoteProgram);
    need(state.pool.equals(sdk.getPdaLaunchpadPoolId(c.LAUNCHLAB, base, state.quote).publicKey), "Launch pool PDA mismatch");
    const data = await this.rpc.getMultipleAccountsInfo([base, state.quote, a.baseVault, a.quoteVault], options);
    const baseMint = spl.unpackMint(base, data[0], spl.TOKEN_2022_PROGRAM_ID);
    need(baseMint.isInitialized && baseMint.decimals === 6 && !baseMint.mintAuthority && !baseMint.freezeAuthority, "Base mint authority changed");
    const metadata = [spl.ExtensionType.MetadataPointer, spl.ExtensionType.TokenMetadata];
    need(spl.getExtensionTypes(baseMint.tlvData).every(type => [...metadata, spl.ExtensionType.TransferFeeConfig].includes(type)), "Unsupported base extension");
    const fee = spl.getTransferFeeConfig(baseMint);
    need(fee?.withdrawWithheldAuthority.equals(c.addresses(this.program).taxAuthority)
      && [fee.olderTransferFee, fee.newerTransferFee].every(f => f.transferFeeBasisPoints === 300 && f.maximumFee === 0xffffffffffffffffn), "Base tax configuration changed");
    need([spl.TOKEN_PROGRAM_ID, spl.TOKEN_2022_PROGRAM_ID].some(p => p.equals(state.quoteProgram)), "Unsupported paired token program");
    const quoteMint = spl.unpackMint(state.quote, data[1], state.quoteProgram);
    need(quoteMint.isInitialized && spl.getExtensionTypes(quoteMint.tlvData).every(type => metadata.includes(type)), "Unsupported paired token extension");
    const baseVault = vault(a.baseVault, data[2], base, launch, spl.TOKEN_2022_PROGRAM_ID);
    vault(a.quoteVault, data[3], state.quote, launch, state.quoteProgram);
    return { state, addresses: a, baseMint, quoteMint, baseVault };
  }
  async snapshot(mint, minContextSlot) {
    const inspected = await this.inspect(mint, minContextSlot);
    const response = await this.rpc.getProgramAccounts(spl.TOKEN_2022_PROGRAM_ID, { commitment: COMMITMENT,
      minContextSlot, withContext: true, filters: [{ memcmp: { offset: 0, bytes: mint } }] });
    need(Array.isArray(response.value) && response.context.slot >= minContextSlot, "Incomplete tax account scan");
    const sources = [], seen = new Set();
    for (const { pubkey, account } of response.value) {
      need(!seen.has(pubkey.toBase58()), "Duplicate tax account from RPC"); seen.add(pubkey.toBase58());
      const token = spl.unpackAccount(pubkey, account, spl.TOKEN_2022_PROGRAM_ID);
      need(token.mint.equals(pk(mint)), "Foreign mint in tax scan");
      if ((spl.getTransferFeeAmount(token)?.withheldAmount || 0n) > 0n) sources.push(pubkey.toBase58());
    }
    return { sources, mintWithheld: String(spl.getTransferFeeConfig(inspected.baseMint).withheldAmount) };
  }
  async baseBalance(mint, minContextSlot) { return (await this.inspect(mint, minContextSlot)).baseVault.amount; }
  async quoteSale(request) {
    const inspected = await this.inspect(request.mint, request.minContextSlot);
    const amount = raw(request.amount); need(amount > 0n && amount <= raw(this.config.maxSwapRaw), "Invalid sale cap");
    need(inspected.baseVault.amount >= amount && this.onchain, "Sale balance or readiness missing");
    const quotedAt = this.now();
    const route = await raydiumQuote(this.rpc, inspected, this.onchain, amount, this.config.slippageBps, request.minContextSlot);
    const price = await this.prices.quote(inspected.state.quote, inspected.quoteMint.decimals, BigInt(route.minOut));
    const quote = { mint: request.mint, amount: request.amount, quoteMint: inspected.state.quote.toBase58(),
      quoteDecimals: inspected.quoteMint.decimals, ...route, minOutUsdMicros: price.usdMicros, quotedAt, priceAt: price.priceAt, priceBlock: price.priceBlock };
    // Signing accepts only a quote produced by this adapter, not injected JSON.
    this.issuedQuotes.set(request.id, { hash: digest(Buffer.from(JSON.stringify(quote))), at: quotedAt });
    for (const [id, item] of this.issuedQuotes) if (this.now() - item.at > 60_000) this.issuedQuotes.delete(id);
    return quote;
  }
  async prepare(request) {
    need(this.config.live === true && this.signer && !this.stopping, "Signing is disabled");
    await this.ready();
    const inspected = await this.inspect(request.mint, request.minContextSlot), { state, addresses: a } = inspected;
    let instruction, deadline = null;
    if (request.kind === "collect") instruction = c.collect(this.program, this.operator, state.base, request.sources.map(pk));
    else {
      const q = request.quote, issued = this.issuedQuotes.get(request.id), now = this.now();
      need(issued && issued.hash === digest(Buffer.from(JSON.stringify(q))) && now >= q.quotedAt && now - q.quotedAt <= 30_000
        && now >= q.priceAt && now - q.priceAt <= 30_000 && raw(q.minOutUsdMicros) >= 30_000_000n
        && q.mint === request.mint && q.amount === request.amount && q.quoteMint === state.quote.toBase58(), "Sale quote expired or changed");
      need(raw(request.amount) <= raw(this.config.maxSwapRaw) && raw(request.amount) <= this.onchain.maxSwapRaw, "Sale exceeds swap cap");
      deadline = Math.floor(now / 1000) + 60;
      instruction = c.convert(this.program, this.operator, state.base, state.quote, state.quoteProgram, decodeInstruction(q.swap),
        { amount: request.amount, minOut: q.minOut, deadline });
    }
    const block = await this.rpc.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({ payerKey: this.operator, recentBlockhash: block.blockhash, instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.priorityMicroLamports }),
      new TransactionInstruction({ programId: sdk.MEMO_PROGRAM_ID, keys: [], data: Buffer.from(request.id) }), instruction,
    ] }).compileToV0Message();
    const fee = (await this.rpc.getFeeForMessage(message, "confirmed")).value;
    need(Number.isSafeInteger(fee) && fee > 0 && fee <= this.config.maxFeeLamports, "Transaction fee exceeds configured cap");
    const balance = await this.rpc.getBalance(this.operator, COMMITMENT);
    need(Number.isSafeInteger(balance) && BigInt(balance) - BigInt(fee) >= raw(this.config.minSolLamports), "Fee would consume operator reserve");
    const tx = new VersionedTransaction(message); tx.sign([this.signer]);
    const bytes = Buffer.from(tx.serialize()); need(bytes.length <= 1232, "Transaction exceeds packet limit");
    const simulation = await this.rpc.simulateTransaction(tx, { sigVerify: true, commitment: "confirmed", minContextSlot: request.minContextSlot });
    need(!simulation.value.err, "Collector transaction simulation failed");
    return { wire: bytes.toString("base64"), signature: bs58.encode(tx.signatures[0]), messageHash: digest(message.serialize()),
      lastValidBlockHeight: block.lastValidBlockHeight, deadline, feeCapLamports: this.config.maxFeeLamports, createdAt: this.now(),
      settlement: { baseVault: a.baseVault.toBase58(), quoteVault: a.quoteVault.toBase58(), launch: a.launch.toBase58(),
        quoteMint: state.quote.toBase58(), quoteDecimals: inspected.quoteMint.decimals, minOut: request.quote?.minOut || null } };
  }
  validateWire(op) {
    const tx = VersionedTransaction.deserialize(Buffer.from(op.wire, "base64"));
    need(tx.signatures.length === 1 && tx.message.staticAccountKeys[0].equals(this.operator)
      && bs58.encode(tx.signatures[0]) === op.signature && digest(tx.message.serialize()) === op.messageHash,
    "Stored transaction differs from signature or message hash");
    need(op.kind === "collect" || op.kind === "sell", "Invalid collector operation");
    const calls = tx.message.compiledInstructions.filter(ix => tx.message.staticAccountKeys[ix.programIdIndex].equals(this.program));
    need(calls.length === 1 && calls[0].data[0] === (op.kind === "collect" ? 5 : 6)
      && tx.message.compiledInstructions.every(ix => [this.program, ComputeBudgetProgram.programId, sdk.MEMO_PROGRAM_ID]
        .some(program => program.equals(tx.message.staticAccountKeys[ix.programIdIndex]))),
    "Stored transaction contains an unexpected program or operation");
  }
  async broadcast(op) {
    need(this.config.live === true && !this.stopping, "Broadcasting is disabled");
    this.validateWire(op); await this.ready();
    if (this.stopping) return;
    const now = this.now();
    if (now - (this.lastSent.get(op.signature) ?? -Infinity) < 10_000) return;
    if (op.deadline !== null && Math.floor(now / 1000) >= op.deadline) return;
    if (await this.rpc.getBlockHeight("confirmed") > op.lastValidBlockHeight) return;
    this.lastSent.set(op.signature, now);
    const signature = await this.rpc.sendRawTransaction(Buffer.from(op.wire, "base64"), { skipPreflight: false, maxRetries: 0 });
    need(signature === op.signature, "RPC returned a different transaction signature");
  }
  async reconcile(op) {
    this.validateWire(op);
    const result = await this.rpc.getSignatureStatuses([op.signature], { searchTransactionHistory: true });
    need(Array.isArray(result.value) && result.value.length === 1, "Incomplete signature status");
    const status = result.value[0];
    if (status?.confirmationStatus === "finalized") {
      if (status.err) return { status: "review", reason: "Finalized transaction failed; inspect before retrying" };
      const tx = await this.rpc.getTransaction(op.signature, { commitment: COMMITMENT, maxSupportedTransactionVersion: 0 });
      if (!tx) return { status: "pending", rebroadcast: false };
      try { return receipt(op, tx); } catch { return { status: "review", reason: "Finalized transaction does not match the recorded vault movement" }; }
    }
    if (status) return { status: "pending", rebroadcast: false };
    const height = await this.rpc.getBlockHeight(COMMITMENT);
    if (height > op.lastValidBlockHeight) {
      const tx = await this.rpc.getTransaction(op.signature, { commitment: COMMITMENT, maxSupportedTransactionVersion: 0 });
      if (tx) { try { return receipt(op, tx); } catch { return { status: "review", reason: "Expired signature has an invalid receipt" }; } }
      return { status: "review", reason: "Expired signature has no verifiable history; reconcile with an archival RPC, never re-sign blindly" };
    }
    return { status: "pending", rebroadcast: op.deadline === null || Math.floor(this.now() / 1000) < op.deadline };
  }
}
module.exports = { RpcAdapter, receipt, tokenDelta, vault, GENESIS };
