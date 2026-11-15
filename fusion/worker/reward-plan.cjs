"use strict";
// Read-only planning boundary for the backend's existing eligibility/tier policy.
// It does not sign or submit transactions, and it never infers recipient eligibility.
const r = require("../client/rewards.cjs"),
  market = require("./moonz-market.cjs");
const { need, raw, pk } = require("./common.cjs");
const spl = require("@solana/spl-token");
async function planPurchase({
  rpc,
  prices,
  program,
  operator,
  base,
  minimumPayoutUsdMicros = "500000000",
  slippageBps = 100,
  maxPriceImpactBps = 500,
  minContextSlot = 0,
  now = Date.now,
}) {
  program = pk(program);
  base = pk(base);
  const launch = require("../client/index.cjs").addresses(program, base).launch;
  const info = await rpc.getAccountInfo(launch, {
    commitment: "finalized",
    minContextSlot,
  });
  need(info?.owner.equals(program), "Fusion launch missing");
  const state = require("../client/index.cjs").decodeLaunch(info.data);
  need(
    state.version === 2 && state.base.equals(base),
    "MOONZ reward launch required",
  );
  const threshold = raw(minimumPayoutUsdMicros);
  need(
    threshold >= 500_000_000n,
    "Holder threshold must be the reviewed net tier, starting at $500",
  );
  const m = await market.snapshot(rpc, minContextSlot, now),
    a = r.addresses(program, base, state.quote, state.quoteProgram, m.quote);
  const rewardAccount = await rpc.getAccountInfo(a.rewards, {
    commitment: "finalized",
    minContextSlot: m.slot,
  });
  if (!rewardAccount)
    return {
      status: "needs_initialization",
      instruction: r.initialize(program, operator, base),
    };
  need(rewardAccount.owner.equals(program), "Reward PDA owner changed");
  const rewards = r.decodeRewards(rewardAccount.data);
  need(rewards.launch.equals(launch), "Foreign reward PDA");
  if (rewards.deadline !== 0n) return { status: "round_active" };
  // Keep unallocated MOONZ for the next reviewed holder snapshot. Do not buy again on a restart.
  if (rewards.available > 0n)
    return {
      status: "moonz_ready",
      available: rewards.available.toString(),
      rewardMint: r.MOONZ.toBase58(),
    };
  if (state.holderAvailable === 0n) return { status: "accumulating" };
  const direct = state.quote.equals(r.MOONZ);
  if (!direct && !state.quote.equals(m.quote))
    return {
      status: "bridge_review_required",
      pairMint: state.quote.toBase58(),
      marketQuote: m.quote.toBase58(),
    };
  // Non-direct pairs are deliberately held until a real Jupiter route, ALT packing and receipts are reviewed.
  const quoted = direct
    ? {
        minOut: state.holderAvailable.toString(),
        expectedOut: state.holderAvailable.toString(),
      }
    : market.quoteBuy(m, state.holderAvailable, {
        slippageBps,
        maxPriceImpactBps,
        now: now(),
      });
  const valueRaw = market.quoteRawForMoonz(m, BigInt(quoted.minOut));
  const value = await prices.quote(
    m.quote,
    m.quote.equals(spl.NATIVE_MINT) ? 9 : 6,
    valueRaw,
  );
  const time = now();
  need(
    Number.isSafeInteger(value.priceAt) &&
      value.priceAt <= time &&
      time - value.priceAt <= 30_000 &&
      time - m.observedAt <= 30_000,
    "Stale reward USD valuation",
  );
  if (BigInt(value.usdMicros) < threshold)
    return {
      status: "accumulating",
      netMoonzValueUsdMicros: value.usdMicros,
      minimumPayoutUsdMicros: String(threshold),
    };
  const deadline = Math.floor(time / 1000) + 60;
  return {
    status: "purchase_ready",
    rewardMint: r.MOONZ.toBase58(),
    pairAmount: state.holderAvailable.toString(),
    minMoonzOut: quoted.minOut,
    estimatedMoonzValueUsdMicros: value.usdMicros,
    quotedAt: m.observedAt,
    priceAt: value.priceAt,
    slot: m.slot,
    deadline,
    instruction: r.buy(
      program,
      operator,
      base,
      state.quote,
      state.quoteProgram,
      {
        amount: state.holderAvailable,
        minMoonzOut: quoted.minOut,
        deadline,
        creator: m.creator,
        marketQuote: m.quote,
      },
    ),
  };
}
// Proportional allocation of an already-reviewed snapshot. Missing MOONZ ATAs are excluded;
// their weights remain in the denominator so their allocation stays in this CA's MOONZ pot.
function planRound(program, base, round, budget, holders) {
  budget = raw(typeof budget === "bigint" ? String(budget) : budget);
  need(
    budget > 0n &&
      Array.isArray(holders) &&
      holders.length > 0 &&
      holders.length <= 1024,
    "Invalid holder snapshot",
  );
  const seen = new Set();
  let weight = 0n;
  const rows = holders.map((row) => {
    const recipient = pk(row.recipient);
    need(
      !seen.has(recipient.toBase58()) && typeof row.hasMoonzAta === "boolean",
      "Duplicate holder or missing ATA check",
    );
    seen.add(recipient.toBase58());
    const balance = raw(row.balance);
    need(balance > 0n, "Zero holder weight");
    weight += balance;
    return { ...row, recipient, balance };
  });
  const payments = rows
    .filter((row) => row.hasMoonzAta)
    .map((row) => ({
      recipient: row.recipient,
      amount: (budget * row.balance) / weight,
    }))
    .filter((row) => row.amount > 0n);
  if (!payments.length)
    return { status: "no_payable_holders", unallocated: budget.toString() };
  const result = r.merkleRound(program, base, round, payments);
  return {
    status: "round_ready",
    ...result,
    unallocated: (budget - result.total).toString(),
  };
}
module.exports = { planPurchase, planRound };
