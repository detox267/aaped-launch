const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const { LiteSVM, FailedTransactionMetadata, Clock } = require("litesvm");
const { getTransactionDecoder } = require("@solana/kit");
const {
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  SystemProgram,
} = require("@solana/web3.js");
const spl = require("@solana/spl-token"),
  sdk = require("@raydium-io/raydium-sdk-v2"),
  BN = require("bn.js");
const c = require("../../client/index.cjs");
function setup({ raydium = false } = {}) {
  const svm = new LiteSVM().withNativeMints().withTransactionHistory(0n),
    program = Keypair.generate().publicKey,
    admin = Keypair.generate(),
    operator = Keypair.generate(),
    fee = Keypair.generate();
  svm.addProgramFromFile(
    program.toBase58(),
    path.join(__dirname, "../../target/deploy/moonz_fusion.so"),
  );
  for (const k of [admin, operator, fee])
    svm.airdrop(k.publicKey.toBase58(), 100_000_000_000n);
  const set = (
    key,
    owner,
    data,
    lamports = svm.minimumBalanceForRentExemption(BigInt(data.length)),
  ) =>
    svm.setAccount({
      address: key.toBase58(),
      programAddress: owner.toBase58(),
      data: Buffer.from(data),
      lamports,
      executable: false,
    });
  const get = (key) => svm.getAccount(key.toBase58());
  const cfg = c.addresses(program);
  const pd = get(cfg.programData);
  const d = Buffer.from(pd.data);
  d[12] = 1;
  admin.publicKey.toBuffer().copy(d, 13);
  set(cfg.programData, c.LOADER, d, pd.lamports);
  const send = (instructions, signers = [admin], ok = true) => {
    const tx = new Transaction({
      feePayer: signers[0].publicKey,
      recentBlockhash: svm.latestBlockhash(),
    }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ...instructions,
    );
    tx.sign(...signers);
    const result = svm.sendTransaction(
      getTransactionDecoder().decode(tx.serialize()),
    );
    if (ok && result instanceof FailedTransactionMetadata)
      throw new Error(
        JSON.stringify(result.err()) + "\n" + result.meta().logs().join("\n"),
      );
    if (!ok)
      assert(
        result instanceof FailedTransactionMetadata,
        "Expected transaction rejection",
      );
    return result;
  };
  const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../fixtures/accounts.json"), "utf8"),
  );
  const platform = new PublicKey(
      "3gJPDjVbPMM5pSDbWJfmx28QMtp8vaJeUkfneZ25jsdU",
    ),
    cpConfig = new PublicKey("D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2");
  if (raydium) {
    svm.addProgramFromFile(
      c.LAUNCHLAB.toBase58(),
      path.join(__dirname, "../fixtures/launchlab.so"),
    );
    svm.addProgramFromFile(
      c.CPMM.toBase58(),
      path.join(__dirname, "../fixtures/cpmm.so"),
    );
    for (const a of fixture.accounts)
      set(
        new PublicKey(a.address),
        new PublicKey(a.owner),
        Buffer.from(a.data, "base64"),
        BigInt(a.lamports),
      );
    // Local fixture only: point tax authority at Fusion and allow the SOL global config.
    // Live platform allow/curve-rule registration is a separate activation prerequisite.
    const a = get(platform),
      data = Buffer.from(a.data);
    cfg.taxAuthority.toBuffer().copy(data, 728);
    data[832] = 0;
    data[833] = 0;
    set(platform, c.LAUNCHLAB, data, a.lamports);
  }
  send([
    c.initialize(program, admin.publicKey, {
      operator: operator.publicKey,
      feeWallet: fee.publicKey,
      platform,
      cpConfig,
      maxSwapRaw: 1_000_000_000_000n,
    }),
  ]);
  const controls = (paused = false) =>
    c.controls(program, admin.publicKey, {
      operator: operator.publicKey,
      maxSwapRaw: 1_000_000_000_000n,
      paused,
    });
  send([controls()]);
  const launchState = (base) =>
    c.decodeLaunch(get(c.addresses(program, base).launch).data);
  function launch() {
    const mint = Keypair.generate(),
      quote = spl.NATIVE_MINT,
      global = sdk.getPdaLaunchpadConfigId(c.LAUNCHLAB, quote, 0, 0).publicKey,
      pool = sdk.getPdaLaunchpadPoolId(
        c.LAUNCHLAB,
        mint.publicKey,
        quote,
      ).publicKey;
    const r = sdk.initializeWithToken2022(
      c.LAUNCHLAB,
      admin.publicKey,
      admin.publicKey,
      global,
      platform,
      sdk.getPdaLaunchpadAuth(c.LAUNCHLAB).publicKey,
      pool,
      mint.publicKey,
      quote,
      sdk.getPdaLaunchpadVaultId(c.LAUNCHLAB, pool, mint.publicKey).publicKey,
      sdk.getPdaLaunchpadVaultId(c.LAUNCHLAB, pool, quote).publicKey,
      spl.TOKEN_PROGRAM_ID,
      6,
      "Fusion Test",
      "FTEST",
      "https://moonz.fun/test.json",
      {
        type: "ConstantCurve",
        supply: new BN("1000000000000000"),
        totalSellA: new BN("650000000000000"),
        totalFundRaisingB: new BN("85000000000"),
        migrateType: "cpmm",
      },
      new BN(0),
      new BN(0),
      new BN(0),
      sdk.CpmmCreatorFeeOn.OnlyTokenB,
      {
        transferFeeBasePoints: 300,
        maxinumFee: new BN("18446744073709551615"),
      },
      sdk.getPdaPlatformAllowConfig(c.LAUNCHLAB, platform, global).publicKey,
      sdk.getPdaPlatformCurveRule(c.LAUNCHLAB, platform, global).publicKey,
    );
    const instruction = c.launch(program, admin.publicKey, r);
    return {
      mint,
      quote,
      global,
      pool,
      instruction,
      raydiumInstruction: r,
      a: c.addresses(program, mint.publicKey, quote),
    };
  }
  function buy(l, raw = 1_000_000_000n) {
    const owner = admin.publicKey,
      base = l.mint.publicKey,
      quote = l.quote;
    const baseAta = spl.getAssociatedTokenAddressSync(
        base,
        owner,
        false,
        spl.TOKEN_2022_PROGRAM_ID,
      ),
      quoteAta = spl.getAssociatedTokenAddressSync(quote, owner);
    const swap = sdk.buyExactInInstruction(
      c.LAUNCHLAB,
      owner,
      sdk.getPdaLaunchpadAuth(c.LAUNCHLAB).publicKey,
      l.global,
      platform,
      l.pool,
      baseAta,
      quoteAta,
      sdk.getPdaLaunchpadVaultId(c.LAUNCHLAB, l.pool, base).publicKey,
      sdk.getPdaLaunchpadVaultId(c.LAUNCHLAB, l.pool, quote).publicKey,
      base,
      quote,
      spl.TOKEN_2022_PROGRAM_ID,
      spl.TOKEN_PROGRAM_ID,
      sdk.getPdaPlatformVault(c.LAUNCHLAB, platform, quote).publicKey,
      sdk.getPdaCreatorVault(c.LAUNCHLAB, owner, quote).publicKey,
      new BN(raw.toString()),
      new BN(1),
      new BN(0),
    );
    send([
      spl.createAssociatedTokenAccountIdempotentInstruction(
        owner,
        baseAta,
        owner,
        base,
        spl.TOKEN_2022_PROGRAM_ID,
      ),
      spl.createAssociatedTokenAccountIdempotentInstruction(
        owner,
        quoteAta,
        owner,
        quote,
      ),
      SystemProgram.transfer({
        fromPubkey: owner,
        toPubkey: quoteAta,
        lamports: raw,
      }),
      spl.createSyncNativeInstruction(quoteAta),
      swap,
    ]);
    return baseAta;
  }
  function convert(l, amount, minOut = 1n) {
    const base = l.mint.publicKey,
      quote = l.quote;
    const swap = sdk.sellExactInInstruction(
      c.LAUNCHLAB,
      l.a.launch,
      sdk.getPdaLaunchpadAuth(c.LAUNCHLAB).publicKey,
      l.global,
      platform,
      l.pool,
      l.a.baseVault,
      l.a.quoteVault,
      sdk.getPdaLaunchpadVaultId(c.LAUNCHLAB, l.pool, base).publicKey,
      sdk.getPdaLaunchpadVaultId(c.LAUNCHLAB, l.pool, quote).publicKey,
      base,
      quote,
      spl.TOKEN_2022_PROGRAM_ID,
      spl.TOKEN_PROGRAM_ID,
      sdk.getPdaPlatformVault(c.LAUNCHLAB, platform, quote).publicKey,
      sdk.getPdaCreatorVault(c.LAUNCHLAB, admin.publicKey, quote).publicKey,
      new BN(amount.toString()),
      new BN(minOut.toString()),
      new BN(0),
    );
    return c.convert(
      program,
      operator.publicKey,
      base,
      quote,
      spl.TOKEN_PROGRAM_ID,
      swap,
      { amount, minOut, deadline: svm.getClock().unixTimestamp + 60n },
    );
  }
  const balance = (address, tokenProgram = spl.TOKEN_PROGRAM_ID) => {
    const a = get(address);
    return spl.unpackAccount(
      address,
      { ...a, owner: tokenProgram, data: Buffer.from(a.data) },
      tokenProgram,
    ).amount;
  };
  function tokenFixture(existingQuote = null) {
    // Isolated payout tests seed a program-owned launch account. Real launch creation is tested separately.
    const mint = existingQuote || Keypair.generate(),
      base = Keypair.generate().publicKey,
      quote = mint.publicKey,
      a = c.addresses(program, base, quote);
    if (!existingQuote)
      send(
        [
          SystemProgram.createAccount({
            fromPubkey: admin.publicKey,
            newAccountPubkey: quote,
            space: spl.MINT_SIZE,
            lamports: Number(
              svm.minimumBalanceForRentExemption(BigInt(spl.MINT_SIZE)),
            ),
            programId: spl.TOKEN_PROGRAM_ID,
          }),
          spl.createInitializeMint2Instruction(
            quote,
            6,
            admin.publicKey,
            admin.publicKey,
          ),
        ],
        [admin, mint],
      );
    const d = Buffer.alloc(393);
    d[0] = 1;
    [
      base,
      quote,
      spl.TOKEN_PROGRAM_ID,
      admin.publicKey,
      Keypair.generate().publicKey,
    ].forEach((k, i) => k.toBuffer().copy(d, 1 + i * 32));
    set(a.launch, program, d);
    send([
      spl.createAssociatedTokenAccountIdempotentInstruction(
        admin.publicKey,
        a.quoteVault,
        a.launch,
        quote,
      ),
      spl.createMintToInstruction(quote, a.quoteVault, admin.publicKey, 1000n),
    ]);
    send(
      [
        c.creditDonation(
          program,
          operator.publicKey,
          base,
          quote,
          spl.TOKEN_PROGRAM_ID,
        ),
      ],
      [operator],
    );
    return { mint, base, quote, a };
  }
  return {
    svm,
    program,
    admin,
    operator,
    fee,
    cfg,
    platform,
    cpConfig,
    set,
    get,
    send,
    controls,
    launchState,
    launch,
    buy,
    convert,
    balance,
    tokenFixture,
  };
}
module.exports = {
  setup,
  Keypair,
  PublicKey,
  SystemProgram,
  spl,
  sdk,
  BN,
  c,
  Clock,
  FailedTransactionMetadata,
};
