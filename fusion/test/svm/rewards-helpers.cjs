const fs = require("node:fs"),
  path = require("node:path");
const { PublicKey, spl } = require("./helpers.cjs");
const r = require("../../client/rewards.cjs"),
  { decodeMarket, quoteBuy } = require("../../worker/moonz-market.cjs");
function loadMoonz(t) {
  t.svm.addProgramFromFile(
    r.OG.toBase58(),
    path.join(__dirname, "../fixtures/moonz-og.so"),
  );
  const f = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../fixtures/accounts.json")),
  );
  for (const a of f.accounts)
    if (
      a.owner === r.OG.toBase58() ||
      a.address === r.MOONZ.toBase58() ||
      a.owner === spl.TOKEN_PROGRAM_ID.toBase58()
    )
      t.set(
        new PublicKey(a.address),
        new PublicKey(a.owner),
        Buffer.from(a.data, "base64"),
        BigInt(a.lamports),
      );
  const state = PublicKey.findProgramAddressSync(
      [Buffer.from("launch_state"), r.MOONZ.toBuffer()],
      r.OG,
    )[0],
    s = decodeMarket(t.get(state).data),
    m = r.market(s.creator, s.quote);
  const x =
      s.phase === 1 ? 117_000_000_000n + s.solCollected : t.balance(m.treasury),
    y =
      s.phase === 1
        ? 760_000_000_000_000n + s.saleRemaining
        : t.balance(m.lpVault);
  for (const [owner, ata] of [
    [m.creatorAuthority, m.creatorFeeVault],
    [r.OG_FEES, m.platformFeeVault],
  ])
    if (!t.get(ata))
      t.send([
        spl.createAssociatedTokenAccountIdempotentInstruction(
          t.admin.publicKey,
          ata,
          owner,
          s.quote,
        ),
      ]);
  return { ...s, x, y, market: m, observedAt: Date.now(), slot: 0 };
}
function rewardsState(t, base) {
  return r.decodeRewards(t.get(r.addresses(t.program, base).rewards).data);
}
function buyMoonz(t, base, amount, market, overrides = {}) {
  const s = t.launchState(base),
    q = quoteBuy({ ...market, observedAt: Date.now() }, amount, {
      maxPriceImpactBps: 1000,
    });
  return r.buy(t.program, t.operator.publicKey, base, s.quote, s.quoteProgram, {
    amount,
    minMoonzOut: q.minOut,
    deadline: t.svm.getClock().unixTimestamp + 60n,
    creator: market.creator,
    marketQuote: market.quote,
    ...overrides,
  });
}
module.exports = { r, loadMoonz, rewardsState, buyMoonz };
