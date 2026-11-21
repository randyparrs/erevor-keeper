// Veto pass of the Erevor guardian, independent of the relayer: every pending VOID proposed to GuardianReceiver must
// be backed by a FINALIZED VOID review on GenLayer for exactly the recorded round, or it is vetoed. No network here:
// the chain and GenLayer access are passed in, so the decision logic is tested on its own.

export const VERDICT_VOID = 1;
export const PRICE_DECIMALS = 18;

/** Decodes a left aligned bytes32 ticker such as bytes32("BTC") into "BTC". */
export function assetSymbol(assetId) {
  const hex = assetId.slice(2).replace(/(00)+$/, "");
  let s = "";
  for (let i = 0; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return s;
}

export function direction(lock, close) {
  return close > lock ? "UP" : close < lock ? "DOWN" : "TIE";
}

/**
 * Why a pending VOID must be vetoed, or undefined when the review stored on GenLayer backs it: a FINALIZED review
 * for this round with verdict VOID and exactly the recorded asset, timestamps, prices and outcome.
 */
export function vetoReason(review, roundId, asset, round) {
  if (!review) return "no finalized review for this round on GenLayer";
  if (String(review.round_id).toLowerCase() !== roundId.toLowerCase()) return "review is for another round";
  if (review.result?.verdict !== "VOID") return `the review verdict is ${review.result?.verdict}, not VOID`;
  const i = review.inputs ?? {};
  const lockTs = Number(round.start);
  if (i.asset !== asset) return `asset ${i.asset} differs from ${asset}`;
  if (i.lock_ts !== lockTs || i.close_ts !== lockTs + Number(round.interval)) return "timestamps differ from the round";
  if (i.lock_price !== round.lockPrice.toString() || i.close_price !== round.closePrice.toString()) return "prices differ from the recorded ones";
  if (i.outcome !== direction(round.lockPrice, round.closePrice) || i.price_decimals !== PRICE_DECIMALS) return "outcome or decimals differ";
  return undefined;
}

/**
 * One pass. `chain` gives: voidProposals() -> [{ roundId, genlayerTxRef }] of recent VOID proposals,
 * pendingVoid(roundId) -> executeAfter (0n when none), round(roundId), assetOf(round), veto(roundId) -> tx hash.
 * `readReview(roundId)` returns the parsed FINALIZED review or undefined. Returns a summary.
 */
export async function vetoPass({ chain, readReview, log }) {
  const proposals = await chain.voidProposals();
  const seen = new Set();
  const summary = { voidProposals: 0, pending: 0, backed: 0, vetoed: 0, errors: 0, vetoes: [] };
  for (const p of proposals) {
    const roundId = p.roundId.toLowerCase();
    if (seen.has(roundId)) continue;
    seen.add(roundId);
    summary.voidProposals++;
    try {
      const executeAfter = await chain.pendingVoid(p.roundId);
      if (executeAfter === 0n) continue;
      summary.pending++;
      const round = await chain.round(p.roundId);
      const asset = await chain.assetOf(round);
      const reason = vetoReason(await readReview(p.roundId), p.roundId, asset, round);
      if (reason === undefined) {
        summary.backed++;
        log("info", "pending VOID backed by the GenLayer review", { roundId: p.roundId, genlayerTxRef: p.genlayerTxRef, executeAfter: executeAfter.toString() });
        continue;
      }
      const tx = await chain.veto(p.roundId);
      summary.vetoed++;
      summary.vetoes.push({ roundId: p.roundId, reason, tx });
      log("error", "VETO", { roundId: p.roundId, reason, genlayerTxRef: p.genlayerTxRef, tx });
    } catch (err) {
      summary.errors++;
      log("error", "veto check failed", { roundId: p.roundId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return summary;
}

/**
 * Health from the last recorded state: 200 while passes run (last one under `staleSeconds` ago) without errors and
 * no veto happened in the last `vetoAlertSeconds`; 503 otherwise, so an external monitor raises an alert.
 */
export function health(state, nowSeconds, { staleSeconds = 600, vetoAlertSeconds = 3600 } = {}) {
  if (!state || !state.lastPassAt) return { ok: false, status: "no pass recorded yet" };
  if (nowSeconds - state.lastPassAt > staleSeconds) return { ok: false, status: `last pass ${nowSeconds - state.lastPassAt} s ago` };
  if (state.lastError) return { ok: false, status: `last pass failed: ${state.lastError}` };
  if (state.lastVetoAt && nowSeconds - state.lastVetoAt < vetoAlertSeconds) return { ok: false, status: `VETO at ${state.lastVetoAt}` };
  return { ok: true, status: "ok" };
}
