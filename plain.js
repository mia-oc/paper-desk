// Plain-English wording for everything the engine writes in trader/ML shorthand. Pure functions (no DOM), unit-tested with node.
// The database keeps the machine ids (LONG_SWING, unvalidated, ...) so filters and history never change; only the screen is translated.
// Unknown text always falls through unchanged: a missing translation is ugly, never wrong.

const SIDE = { LONG: "Buy", SHORT: "Sell" };
const STYLE = { SCALP: "short hold", SWING: "longer hold" };
const SPECIAL = { SKIP: "Skip", HOLD: "Keep holding", CLOSE: "Close now", BREAKEVEN: "Move stop to break-even", TRAIL: "Trail the stop" };
const humanise = (s) => String(s || "").replace(/_/g, " ").trim();
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** "LONG_SWING" -> "Buy · longer hold". */
export function choiceName(id) {
  if (!id) return "-";
  if (SPECIAL[id]) return SPECIAL[id];
  const m = /^(LONG|SHORT)_(SCALP|SWING)$/.exec(id);
  return m ? `${SIDE[m[1]]} · ${STYLE[m[2]]}` : cap(humanise(id).toLowerCase());
}
/** "win_LONG_SWING" -> "Buy · longer hold" (the model's question: will this trade reach its target before its stop?). */
export const questionName = (k) => choiceName(String(k || "").replace(/^win_/, ""));
/** "swing" -> "longer hold". */
export const styleName = (pb) => (pb ? STYLE[String(pb).toUpperCase()] || humanise(pb) : "-");
export const sideName = (side) => (side === "long" ? "Buy" : side === "short" ? "Sell" : cap(String(side || "")));
export const decisionType = (kind) => ({ entry: "New trade", manage: "Open position" }[kind] || cap(humanise(kind)));

export const OUTCOME_TEXT = {
  executed: "traded", applied: "done", skip: "skipped", no_options: "nothing to offer", rejected: "blocked", exec_rejected: "refused by broker",
  exec_ambiguous: "unconfirmed", model_error: "model error", invalid_output: "bad model answer", failed: "failed", executing: "placing order",
};
export const outcomeText = (o) => OUTCOME_TEXT[o] || humanise(o) || "-";

const CLOSE_TEXT = { TP: "Target hit", SL: "Stop hit", external: "Closed outside the bot", model: "Model closed it", time_stop: "Time limit", session_close: "Market closing", flatten: "Emergency close-all" };
export const closeReasonText = (r) => (r ? CLOSE_TEXT[r] || humanise(r) : "-");

const RISK_TEXT = {
  daily_loss_limit: "daily loss limit reached", market_closed: "market is closed", stale_quote: "price data too old", unresolved_order: "an earlier order is still unconfirmed",
  already_in_position: "already in a position here", instrument_cooldown: "traded this recently, resting", max_open_positions: "already at the limit of open positions",
  entries_per_hour: "hourly limit on new trades reached", below_min_size: "too small for the broker's minimum", spread_too_wide: "trading cost (spread) too high for this stop",
  rr_too_low: "reward not big enough for the risk", total_risk_limit: "total risk limit reached", margin_limit: "margin limit reached", insufficient_margin: "not enough free margin",
  option_no_longer_available: "price moved and the trade was no longer available",
};
export function rejectText(r) {
  if (!r) return "";
  if (RISK_TEXT[r]) return RISK_TEXT[r];
  let m = /^currency_concentration_(\w+)$/.exec(r);
  if (m) return `too much exposure to ${m[1]}`;
  m = /^cluster_concentration_(\w+)$/.exec(r);
  if (m) return `too many similar positions (${humanise(m[1])})`;
  m = /^cluster_risk_limit_(\w+)$/.exec(r);
  if (m) return `risk limit for similar positions reached (${humanise(m[1])})`;
  return r;
}

const TAG_TEXT = {
  breakout_up_20: "breaking out upward", breakout_down_20: "breaking out downward", squeeze: "unusually quiet range", overbought: "pushed up hard (overbought)",
  oversold: "pushed down hard (oversold)", pullback_in_uptrend: "dip in an uptrend", pullback_in_downtrend: "bounce in a downtrend", vol_expansion: "moves getting bigger",
};
export const tagText = (t) => TAG_TEXT[t] || humanise(t);

const CLASS_TEXT = { fx: "currency", index: "stock-index", metal: "metal", energy: "energy", bond: "bond", share: "share" };
export const className = (c) => CLASS_TEXT[c] || c || "";

const EVENT_TEXT = {
  candles_failed: "Price history request failed", stream_error: "Price feed hiccup", loop_error: "Background task error", trade_closed: "Trade closed", trade_adopted: "Trade picked up",
  order_ambiguous: "Order result unclear", order_unconfirmed: "Order not confirmed", order_reconciled: "Order matched up", close_failed: "Could not close a trade", close_ambiguous: "Close not confirmed",
  stop_move_failed: "Could not move a stop", calibration_loaded: "Model track record loaded", calibration_invalid: "Track record unreadable", calibration_mismatch: "Track record out of date",
  calibration_model_mismatch: "Track record belongs to another model", model_swapped: "Switched to a new model", model_swap_failed: "New model failed to load", model_recovered: "Model back online",
  model_unhealthy: "Model offline", model_warmup: "Model warm-up failed", engine_stop: "Engine stopped", drawdown_halt: "Stopped trading: losses hit the limit", trust_changed: "Model trust changed",
  paused: "Paused", resumed: "Resumed", flatten: "Close-all requested", universe: "Watch-list updated", instrument_unavailable: "Instrument not available", currency: "Currency notice",
  worker_error: "Background task error", card_failed: "Could not build market view", finalize_failed: "Could not finish a trade record",
};
export const eventText = (k) => EVENT_TEXT[k] || cap(humanise(k));

export const RUN_KIND_TEXT = { online: "Quick update", retrain: "Overnight retrain" };
export const RUN_ACTION_TEXT = {
  promoted: "new model adopted", adopted: "adopted", refreshed: "re-checked", collecting: "gathering data", demoted: "trust withdrawn", rejected: "not good enough", failed: "failed", skipped: "skipped",
};
export const runKindText = (k) => RUN_KIND_TEXT[k] || cap(humanise(k));
export const runActionText = (a) => RUN_ACTION_TEXT[a] || humanise(a);

/** What the status pill beside a desk says. */
export function engineMode(trusted, explore) { return trusted ? "Live" : explore ? "Trial trades" : "Watch only"; }

// ---------------------------------------------------------------------------------------------- the decision sentence
const STATS = /^([a-z_]+): ((?:LONG|SHORT)_(?:SCALP|SWING)) P\(win\)=([\d.]+) -> E\[R\]=([+-]?[\d.]+)( \(unvalidated\))?\s*$/;
const THROTTLE = /^explore throttled \((\w+)\); (.*)$/s;
const SHADOW = /^shadow: (\w+) is scored and labelled but not traded yet\s*$/;
const THROTTLE_TEXT = { max_open: "too many trial trades are already open", hourly_cap: "enough trial trades this hour", cooldown: "this one was traded recently" };
const VERDICT = {
  entry: {
    unvalidated: "Skipped: the model has not proven itself yet and this was not one of its strongest picks.",
    no_edge: "Skipped: the expected profit is too small to be worth the risk.",
    no_calibration: "Skipped: the model has no track record yet.",
    explore_rank: "Trial trade: one of the model's strongest picks, taken at the smallest size to gather real results.",
    explore: "Trial trade: the expected profit clears the bar, taken at the smallest size because the model is not proven yet.",
    edge: "Trade: the model has proven itself on this kind of trade and the expected profit clears the bar.",
  },
  manage: {
    unvalidated: "Left alone: the model is not proven at managing open trades, so the stop and target do the work.",
    hold: "Keep holding: nothing says the position needs changing.",
    protect: "Protect: moving the stop to break-even.",
    reversal: "Close: the model now expects the opposite move.",
    momentum: "Trail the stop: the trade is still moving our way.",
  },
};
const signed = (x) => `${x >= 0 ? "+" : "-"}${Math.abs(x)}`;
function statsText(q, p, ev) {
  const win = Math.round(Number(p) * 100), avg = Math.round(Number(ev) * 100);
  return `${choiceName(q)}: ${win}% chance of winning, average result ${signed(avg)}% of the amount risked`;
}

/** The engine's one-line reason, in plain English. `kind` is the decision kind ("entry" | "manage"). Unknown text passes through, with the worst jargon swapped. */
export function whyText(raw, kind = "entry") {
  const s = String(raw || "").trim();
  if (!s) return "";
  const sh = SHADOW.exec(s);
  if (sh) return `Watch only: ${className(sh[1])} markets are not traded yet. The model still scores them so it can learn.`;
  const th = THROTTLE.exec(s);
  if (th) {
    const inner = STATS.exec(th[2]);
    const cause = THROTTLE_TEXT[th[1]] || humanise(th[1]);
    return `Trial trade held back (${cause}).` + (inner ? ` It was one of the model's strongest picks (${statsText(inner[2], inner[3], inner[4])}).` : "");
  }
  const m = STATS.exec(s);
  if (m) {
    const verdict = (VERDICT[kind === "manage" ? "manage" : "entry"][m[1]]) || (VERDICT.entry[m[1]]) || cap(humanise(m[1]));
    return `${verdict} (${statsText(m[2], m[3], m[4])}).`;
  }
  const part = /^([a-z_]+): ((?:LONG|SHORT)_(?:SCALP|SWING))\b/.exec(s);                // the engine cut a long line short: keep what is readable
  if (part) return `${VERDICT[kind === "manage" ? "manage" : "entry"][part[1]] || cap(humanise(part[1]))} (${choiceName(part[2])}).`;
  const bare = /^([a-z_]+)$/.exec(s);
  if (bare) return (VERDICT[kind === "manage" ? "manage" : "entry"][s]) || s;
  return s.replace(/P\(win\)/g, "chance of winning").replace(/E\[R\]/g, "expected result").replace(/\(unvalidated\)/g, "(not yet proven)").replace(/\bunvalidated\b/g, "not yet proven");
}

// ---------------------------------------------------------------------------------------------- verdict lines from the API
export function edgeVerdictText(v) {
  const s = String(v || "");
  let m = /^insufficient data \((\d+)\/(\d+) labelled picks\)/.exec(s);
  if (m) return `Too early to tell: ${m[1]} of the ${m[2]} judged picks needed so far.`;
  if (s.startsWith("positive")) return "Yes: its picks moved the right way by more than luck can explain.";
  if (s.startsWith("NEGATIVE")) return "No: its picks are doing worse than random, so the model is hurting.";
  if (s.startsWith("no demonstrable")) return "Not proven yet: the results could still be down to luck.";
  return s;
}
export function skillVerdictText(v) {
  const s = String(v || "");
  if (s === "collecting data") return "Still collecting data.";
  const m = /^mean AUC ([\d.]+) over (\d+) question\(s\): (.*)$/.exec(s);
  if (!m) return s;
  const tail = m[3].startsWith("some skill") ? "showing some skill" : m[3].startsWith("no skill") ? "no better than chance so far" : m[3] === "inverted" ? "worse than chance" : m[3];
  return `Average accuracy score ${m[1]} across ${m[2]} kinds of trade: ${tail}.`;
}

/** The learner's / nightly retrain's one-line explanation, in plain English. Unknown text passes through. */
export function learnReasonText(r) {
  const s = String(r || "");
  if (!s) return "";
  if (s === "no question earned trust on held-out data") return "No kind of trade passed the test on data the model had not seen.";
  if (s === "earned trust but is not better than the current champion") return "Passed the test, but is not better than the current model.";
  if (s === "another retrain is running") return "Another retrain is already running.";
  let m = /^challenger probe AUC ([\d.]+) < ([\d.]+): no learnable signal found$/.exec(s);
  if (m) return `The new candidate model found nothing learnable (accuracy score ${m[1]}; it needed ${m[2]}).`;
  m = /^earned trust on (\d+) question\(s\): (.*)$/.exec(s);
  if (m) return `Passed the test on ${m[1]} kind(s) of trade: ${m[2].split(",").map((k) => questionName(k.trim())).join(", ")}.`;
  m = /^beats the champion \((\d+) vs (\d+) trusted, mean t ([\d.]+) vs ([\d.]+)\)$/.exec(s);
  if (m) return `Beats the current model (${m[1]} proven kinds of trade against ${m[2]}, with stronger evidence).`;
  m = /^only ([\d.]+) GB memory free/.exec(s);
  if (m) return `Skipped: the Mac only had ${m[1]} GB of memory free. It will try again tomorrow.`;
  m = /^only (\d+) new labelled scans since the last run \(([\d.]+) days ago\)$/.exec(s);
  if (m) return `Skipped: only ${m[1]} new results since the last run, ${m[2]} days ago.`;
  m = /^(\d+) new labelled scans \(>= (\d+)\)$/.exec(s);
  if (m) return `Enough new results (${m[1]}).`;
  m = /^(fine-tune|backfill) failed \(exit (\d+)\)$/.exec(s);
  if (m) return `${m[1] === "backfill" ? "Fetching history" : "Training"} failed (code ${m[2]}). The current model keeps running.`;
  return s;
}
