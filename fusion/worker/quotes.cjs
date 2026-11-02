"use strict";
const sdk = require("@raydium-io/raydium-sdk-v2"), spl = require("@solana/spl-token"), BN = require("bn.js");
const c = require("../client/index.cjs");
const { need, pk, layoutAccount, encodeInstruction } = require("./common.cjs");
const bn = n => new BN(String(n));

async function raydiumQuote(rpc, { state, addresses: a, baseMint, quoteMint }, cfg, amount, slippageBps, minContextSlot) {
  const options = { commitment: "finalized", minContextSlot };
  const poolAccount = await rpc.getAccountInfo(state.pool, options);
  const pool = layoutAccount(poolAccount, c.LAUNCHLAB, sdk.LaunchpadPool, "PoolState");
  need(pool.mintA.equals(state.base) && pool.mintB.equals(state.quote) && pool.platformId.equals(cfg.platform), "Launch pool binding changed");
  need(pool.status === 0 || pool.status === 2, "Pool graduation or trading is not ready");
  const epoch = await rpc.getEpochInfo("confirmed");
  const fees = spl.getTransferFeeConfig(baseMint);
  const active = BigInt(epoch.epoch) < fees.newerTransferFee.epoch ? fees.olderTransferFee : fees.newerTransferFee;
  let output, swap;
  if (pool.status === 0) {
    const global = layoutAccount(await rpc.getAccountInfo(pool.configId, options), c.LAUNCHLAB, sdk.LaunchpadConfig, "GlobalConfig");
    const result = sdk.Curve.sellExactIn({ poolInfo: pool, curveType: global.curveType,
      protocolFeeRate: global.tradeFeeRate, platformFeeRate: bn(0), creatorFeeRate: bn(0), shareFeeRate: bn(0),
      transferFeeConfigA: { ...fees, olderTransferFee: active, newerTransferFee: active },
      slot: epoch.absoluteSlot, amountA: bn(amount) });
    output = BigInt(result.amountB.toString());
    const minOut = output * BigInt(10000 - slippageBps) / 10000n;
    swap = sdk.sellExactInInstruction(c.LAUNCHLAB, a.launch, sdk.getPdaLaunchpadAuth(c.LAUNCHLAB).publicKey,
      pool.configId, pool.platformId, state.pool, a.baseVault, a.quoteVault, pool.vaultA, pool.vaultB,
      state.base, state.quote, spl.TOKEN_2022_PROGRAM_ID, state.quoteProgram,
      sdk.getPdaPlatformVault(c.LAUNCHLAB, cfg.platform, state.quote).publicKey,
      sdk.getPdaCreatorVault(c.LAUNCHLAB, pool.creator, state.quote).publicKey, bn(amount), bn(minOut), bn(0));
  } else {
    const ordered = [state.base, state.quote].sort((x, y) => Buffer.compare(x.toBuffer(), y.toBuffer()));
    const keys = sdk.getCreatePoolKeys({ programId: c.CPMM, configId: cfg.cpConfig, mintA: ordered[0], mintB: ordered[1] });
    const cp = layoutAccount(await rpc.getAccountInfo(keys.poolId, options), c.CPMM, sdk.CpmmPoolInfoLayout, "PoolState");
    need(cp.configId.equals(cfg.cpConfig) && cp.mintA.equals(ordered[0]) && cp.mintB.equals(ordered[1])
      && cp.vaultA.equals(keys.vaultA) && cp.vaultB.equals(keys.vaultB) && cp.observationId.equals(keys.observationId), "CPMM bindings changed");
    const infos = await rpc.getMultipleAccountsInfo([cfg.cpConfig, cp.vaultA, cp.vaultB], options);
    const config = layoutAccount(infos[0], c.CPMM, sdk.CpmmConfigInfoLayout, "AmmConfig");
    const baseFirst = cp.mintA.equals(state.base), programs = baseFirst
      ? [spl.TOKEN_2022_PROGRAM_ID, state.quoteProgram] : [state.quoteProgram, spl.TOKEN_2022_PROGRAM_ID];
    const accounts = [spl.unpackAccount(cp.vaultA, infos[1], programs[0]), spl.unpackAccount(cp.vaultB, infos[2], programs[1])];
    need(accounts.every((v, i) => v.mint.equals(ordered[i]) && v.owner.equals(keys.authority) && !v.isFrozen), "Invalid CPMM reserves");
    const reserves = [bn(accounts[0].amount).sub(cp.protocolFeesMintA).sub(cp.fundFeesMintA).sub(cp.creatorFeesMintA),
      bn(accounts[1].amount).sub(cp.protocolFeesMintB).sub(cp.fundFeesMintB).sub(cp.creatorFeesMintB)];
    need(reserves.every(v => v.gt(bn(0))), "Empty CPMM reserves");
    const inputFee = spl.calculateFee(active, amount), netIn = bn(amount - inputFee);
    const creatorOnInput = cp.feeOn === sdk.FeeOn.BothToken || (baseFirst ? cp.feeOn === sdk.FeeOn.OnlyTokenA : cp.feeOn === sdk.FeeOn.OnlyTokenB);
    const result = sdk.CurveCalculator.swapBaseInput(netIn, reserves[baseFirst ? 0 : 1], reserves[baseFirst ? 1 : 0],
      config.tradeFeeRate, cp.enableCreatorFee ? config.creatorFeeRate : bn(0), config.protocolFeeRate, config.fundFeeRate, creatorOnInput);
    output = BigInt(result.outputAmount.toString());
    const minOut = output * BigInt(10000 - slippageBps) / 10000n;
    swap = sdk.makeSwapCpmmBaseInInstruction(c.CPMM, a.launch, keys.authority, cfg.cpConfig, keys.poolId, a.baseVault, a.quoteVault,
      baseFirst ? cp.vaultA : cp.vaultB, baseFirst ? cp.vaultB : cp.vaultA, spl.TOKEN_2022_PROGRAM_ID, state.quoteProgram,
      state.base, state.quote, keys.observationId, bn(amount), bn(minOut));
  }
  const minOut = output * BigInt(10000 - slippageBps) / 10000n;
  need(minOut > 0n && quoteMint.decimals <= 18, "Sale is too small to quote");
  return { minOut: minOut.toString(), expectedOut: output.toString(), swap: encodeInstruction(swap), route: pool.status === 0 ? "launchlab" : "cpmm" };
}
module.exports = { raydiumQuote };
