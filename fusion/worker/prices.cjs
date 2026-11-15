"use strict";
const { need, pk } = require("./common.cjs");
const AGE_MS = 30_000;

function usdMicros(amount, decimals, price) {
  // Integer rational arithmetic; round DOWN rather than letting a float cross $30.
  const text = String(price);
  need(text.length <= 80 && /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text), "Invalid USD price");
  const [mantissa, exponentText = "0"] = text.toLowerCase().split("e");
  const exponent = Number(exponentText), [whole, fraction = ""] = mantissa.split(".");
  need(Number.isInteger(exponent) && Math.abs(exponent) <= 36 && Number.isInteger(decimals) && decimals >= 0 && decimals <= 18,
    "Unsupported price precision");
  const numerator = BigInt((whole || "0") + fraction);
  need(numerator > 0n, "Nonpositive USD price");
  const scale = decimals + fraction.length - exponent - 6;
  return scale >= 0 ? BigInt(amount) * numerator / (10n ** BigInt(scale))
    : BigInt(amount) * numerator * 10n ** BigInt(-scale);
}

class Prices {
  constructor({ connection, apiKey, fetchJson, now = Date.now }) {
    this.connection = connection; this.apiKey = apiKey; this.now = now;
    this.fetchJson = fetchJson || (async (url, headers) => {
      const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
      need(response.ok, "USD price provider unavailable"); return response.json();
    });
    this.cache = new Map(); this.pending = new Map(); this.nextRequest = 0;
  }
  async quote(mint, decimals, amount) {
    mint = pk(mint).toBase58();
    let item = this.cache.get(mint), now = this.now();
    if (!item || item.decimals !== decimals || now < item.priceAt || now - item.priceAt > AGE_MS || now - item.fetchedAt > 15_000) {
      if (!this.pending.has(mint)) this.pending.set(mint, this.fetchPrice(mint, decimals).finally(() => this.pending.delete(mint)));
      item = await this.pending.get(mint);
    }
    now = this.now();
    need(now >= item.priceAt && now - item.priceAt <= AGE_MS, "USD price is stale");
    return { usdMicros: usdMicros(amount, decimals, item.usdPrice).toString(), priceAt: item.priceAt, priceBlock: item.blockId };
  }
  async fetchPrice(mint, decimals) {
    // Dedicated key is an operational requirement for this runner. Do not share
    // the existing API's allowance without coordinating its rate limiter.
    need(typeof this.apiKey === "string" && this.apiKey.trim(), "Configure a dedicated Jupiter price API key");
    need(this.now() >= this.nextRequest, "Price requests paced; retry next collection cycle");
    this.nextRequest = this.now() + 1500;
    let body;
    try { body = await this.fetchJson(`https://api.jup.ag/price/v3?ids=${mint}`, { "x-api-key": this.apiKey }); }
    catch { throw new Error("USD price request failed"); }
    const row = body?.[mint];
    need(row && row.decimals === decimals && Number.isSafeInteger(row.blockId) && row.blockId > 0
      && !row.scaledUiConfig && !row.stockData, "No supported USD price for paired mint");
    usdMicros(1n, decimals, row.usdPrice);
    const timestamp = await this.connection.getBlockTime(row.blockId), now = this.now();
    need(Number.isSafeInteger(timestamp) && timestamp * 1000 <= now && now - timestamp * 1000 <= AGE_MS,
      "USD price observation is stale or missing");
    const item = { usdPrice: String(row.usdPrice), decimals, blockId: row.blockId, priceAt: timestamp * 1000, fetchedAt: now };
    this.cache.set(mint, item); return item;
  }
}
module.exports = { Prices, usdMicros };
