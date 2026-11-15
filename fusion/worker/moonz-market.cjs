"use strict";
const { PublicKey } = require("@solana/web3.js"),
  spl = require("@solana/spl-token");
const r = require("../client/rewards.cjs"),
  { need } = require("./common.cjs");
const ceil = (a, b) => (a + b - 1n) / b;
function decodeMarket(data) {
  const d = Buffer.from(data);
  need(
    d.length === 386 && new PublicKey(d.subarray(15, 47)).equals(r.MOONZ),
    "Wrong MOONZ market",
  );
  need(
    [1, 2].includes(d[10]) && d[14] === 1 && d[13] === 1,
    "MOONZ trading is not ready",
  );
  const phase = d[10],
    quote = phase === 1 || d[303] === 0 ? spl.NATIVE_MINT : r.USDC;
  need(phase === 1 || d[303] <= 1, "Unsupported MOONZ market quote");
  const supply = d.readBigUInt64LE(271),
    sold = d.readBigUInt64LE(279);
  need(supply >= sold, "Invalid MOONZ curve inventory");
  return {
    phase,
    quote,
    creator: new PublicKey(d.subarray(47, 79)),
    saleRemaining: supply - sold,
    solCollected: d.readBigUInt64LE(287) + (d.readBigUInt64LE(295) << 64n),
  };
}
async function snapshot(rpc, minContextSlot = 0, now = Date.now) {
  const state = PublicKey.findProgramAddressSync(
    [Buffer.from("launch_state"), r.MOONZ.toBuffer()],
    r.OG,
  )[0];
  const initial = await rpc.getAccountInfo(state, {
    commitment: "finalized",
    minContextSlot,
  });
  need(initial?.owner.equals(r.OG), "MOONZ market missing");
  const chosen = decodeMarket(initial.data),
    m = r.market(chosen.creator, chosen.quote);
  const result = await rpc.getMultipleAccountsInfoAndContext(
    [state, r.MOONZ, m.saleVault, m.lpVault, m.treasury],
    { commitment: "finalized", minContextSlot },
  );
  const [account, mintInfo, ...reserves] = result.value;
  need(account?.owner.equals(r.OG), "MOONZ market owner changed");
  const s = decodeMarket(account.data);
  need(
    s.quote.equals(chosen.quote) && s.creator.equals(chosen.creator),
    "MOONZ market switched; requote",
  );
  const mint = spl.unpackMint(r.MOONZ, mintInfo, spl.TOKEN_PROGRAM_ID);
  need(
    mint.decimals === 6 && !mint.mintAuthority && !mint.freezeAuthority,
    "MOONZ mint changed",
  );
  const balances = reserves.map((info, i) => {
    const key = [m.saleVault, m.lpVault, m.treasury][i],
      a = spl.unpackAccount(key, info, spl.TOKEN_PROGRAM_ID);
    need(
      a.owner.equals(state) &&
        a.mint.equals(i === 2 ? s.quote : r.MOONZ) &&
        !a.isFrozen &&
        !a.delegate &&
        !a.closeAuthority,
      "Invalid MOONZ reserve",
    );
    return a.amount;
  });
  const [sale, lp, quote] = balances;
  need(
    s.phase !== 1 || sale >= s.saleRemaining,
    "MOONZ sale inventory insufficient",
  );
  const x = s.phase === 1 ? 117_000_000_000n + s.solCollected : quote;
  const y = s.phase === 1 ? 760_000_000_000_000n + s.saleRemaining : lp;
  need(x > 0n && y > 0n, "Empty MOONZ market");
  const blockTime = await rpc.getBlockTime(result.context.slot),
    time = now();
  need(
    Number.isSafeInteger(blockTime) &&
      blockTime * 1000 <= time &&
      time - blockTime * 1000 <= 30_000,
    "MOONZ RPC snapshot is stale",
  );
  return {
    ...s,
    x,
    y,
    slot: result.context.slot,
    observedAt: blockTime * 1000,
    market: m,
  };
}
function quoteBuy(
  market,
  amount,
  { slippageBps = 100, maxPriceImpactBps = 500, now = Date.now() } = {},
) {
  amount = BigInt(amount);
  need(
    amount > 0n &&
      Number.isSafeInteger(slippageBps) &&
      slippageBps >= 1 &&
      slippageBps <= 500 &&
      Number.isSafeInteger(maxPriceImpactBps) &&
      maxPriceImpactBps >= 1 &&
      maxPriceImpactBps <= 1000,
    "Invalid reward purchase limits",
  );
  need(
    Number.isSafeInteger(market.observedAt) &&
      now >= market.observedAt &&
      now - market.observedAt <= 30_000,
    "Stale MOONZ market",
  );
  const fee = (amount * 125n) / 10000n,
    net = amount - fee,
    output = market.y - ceil(market.x * market.y, market.x + net);
  need(output > 0n, "MOONZ purchase too small");
  need(
    market.phase !== 1 || output < market.saleRemaining,
    "Purchase crosses MOONZ graduation; requote with a smaller budget",
  );
  const impact = ceil(net * 10000n, market.x + net);
  need(
    impact <= BigInt(maxPriceImpactBps),
    "MOONZ purchase exceeds price impact limit",
  );
  const minOut = (output * BigInt(10000 - slippageBps)) / 10000n;
  need(minOut > 0n, "MOONZ minimum output is zero");
  return {
    amount: amount.toString(),
    expectedOut: output.toString(),
    minOut: minOut.toString(),
    tradeFee: fee.toString(),
    priceImpactBps: Number(impact),
    quoteMint: market.quote.toBase58(),
    creator: market.creator.toBase58(),
    observedAt: market.observedAt,
    slot: market.slot,
  };
}
// Marginal curve/reserve price for display; not a guaranteed liquidation value.
function quoteRawForMoonz(market, moonzRaw) {
  return (BigInt(moonzRaw) * market.x) / market.y;
}
module.exports = { decodeMarket, snapshot, quoteBuy, quoteRawForMoonz };
