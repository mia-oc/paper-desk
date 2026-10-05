// Pure helpers (no DOM) - unit-tested with node, shared with app.js.
export const SALT = "oandabot-dash/v1";
export const ROUNDS = 600000;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** PBKDF2-SHA256 -> 64 hex chars. Must equal livebot.auth.derive_token(). */
export async function deriveToken(password, rounds = ROUNDS) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(SALT), iterations: rounds }, key, 256);
  return hex(bits);
}

const nf = (dp) => new Intl.NumberFormat("en-GB", { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const num = (x, dp = 2) => (x === null || x === undefined || Number.isNaN(x) ? "-" : nf(dp).format(x));
export function gbp(x, dp = 0, sign = false) {
  if (x === null || x === undefined || Number.isNaN(x)) return "-";
  const s = x < 0 ? "-" : sign && x > 0 ? "+" : "";
  return `${s}£${nf(dp).format(Math.abs(x))}`;
}
export function pct(x, dp = 2, sign = true) {
  if (x === null || x === undefined || Number.isNaN(x)) return "-";
  return `${sign && x > 0 ? "+" : ""}${nf(dp).format(x)}%`;
}
export const sgn = (x) => (x > 0 ? "pos" : x < 0 ? "neg" : "flat");
export const price = (x, dp) => (x === null || x === undefined ? "-" : Number(x).toFixed(dp ?? 5));
export const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");

export function ago(ts, now = Date.now() / 1000) {
  if (!ts) return "-";
  const d = Math.max(0, now - ts);
  if (d < 90) return `${Math.round(d)}s ago`;
  if (d < 5400) return `${Math.round(d / 60)}m ago`;
  if (d < 172800) return `${(d / 3600).toFixed(1)}h ago`;
  return `${Math.round(d / 86400)}d ago`;
}
export function dur(min) {
  if (min === null || min === undefined) return "-";
  if (min < 90) return `${Math.round(min)}m`;
  return `${(min / 60).toFixed(1)}h`;
}
export function clock(ts, withDate = false) {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  const t = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  return withDate ? `${d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })} ${t}` : t;
}

/** Map points [{ts, nav}] into SVG coordinates. Returns null if there is nothing to draw. */
export function chartGeometry(points, w, h, pad = { l: 56, r: 12, t: 12, b: 24 }, ref = null) {
  if (!points || points.length < 2) return null;
  const xs = points.map((p) => p.ts), ys = points.map((p) => p.nav);
  let lo = Math.min(...ys, ...(ref ? [ref] : [])), hi = Math.max(...ys, ...(ref ? [ref] : []));
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const margin = (hi - lo) * 0.08; lo -= margin; hi += margin;
  const x0 = xs[0], x1 = xs[xs.length - 1] || x0 + 1;
  const X = (t) => pad.l + ((t - x0) / (x1 - x0 || 1)) * (w - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);
  const pts = points.map((p) => [X(p.ts), Y(p.nav)]);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
  const base = h - pad.b;
  const area = `${line}L${pts[pts.length - 1][0].toFixed(1)},${base}L${pts[0][0].toFixed(1)},${base}Z`;
  const ticks = [0, 1, 2, 3].map((i) => { const v = lo + ((hi - lo) * i) / 3; return { v, y: Y(v) }; });
  return { line, area, ticks, X, Y, pts, lo, hi, x0, x1, pad, refY: ref ? Y(ref) : null };
}

/** Nearest point by x (for the hover crosshair). */
export function nearest(points, ts) {
  let best = 0;
  for (let i = 1; i < points.length; i++) if (Math.abs(points[i].ts - ts) < Math.abs(points[best].ts - ts)) best = i;
  return best;
}

export const OUTCOME_CLASS = {
  executed: "good", applied: "good", skip: "muted", no_options: "muted", rejected: "warn", exec_rejected: "warn",
  exec_ambiguous: "warn", model_error: "bad", invalid_output: "bad", failed: "bad", executing: "warn",
};

/** Calibration curve as a step chart: raw P(win) on x (0..1), expected R after spread on y. `edges` split [0,1] into values.length bins. */
export function stepGeometry(edges, values, w, h, minEv = 0, pad = { l: 44, r: 12, t: 12, b: 26 }) {
  if (!values || !values.length || edges.length !== values.length - 1) return null;
  const cuts = [0, ...edges.map((e) => Math.min(1, Math.max(0, e))), 1];
  let lo = Math.min(0, ...values), hi = Math.max(0, minEv, ...values);
  if (hi - lo < 0.2) { lo -= 0.1; hi += 0.1; }
  const m = (hi - lo) * 0.1; lo -= m; hi += m;
  const X = (p) => pad.l + p * (w - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);
  const segments = values.map((v, i) => ({ x1: X(cuts[i]), x2: X(cuts[i + 1]), y: Y(v), v, p1: cuts[i], p2: cuts[i + 1] }));
  const path = segments.map((s, i) => `${i ? "L" : "M"}${s.x1.toFixed(1)},${s.y.toFixed(1)}L${s.x2.toFixed(1)},${s.y.toFixed(1)}`).join("");
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((p) => ({ p, x: X(p) }));
  const yticks = [lo + m, 0, hi - m].map((v) => ({ v, y: Y(v) }));
  return { segments, path, zeroY: Y(0), evY: Y(minEv), X, Y, ticks, yticks, lo, hi, pad, eligible: segments.filter((s) => s.v >= minEv && minEv > 0).map((s) => s.p1) };
}

/** Daily AUC bars (0.5 = coin flip). */
export function aucBars(items, w, h, pad = { l: 40, r: 12, t: 12, b: 26 }, lo = 0.4, hi = 0.7) {
  if (!items || !items.length) return null;
  const vals = items.map((i) => i.auc);
  lo = Math.min(lo, ...vals) - 0.01; hi = Math.max(hi, ...vals) + 0.01;
  const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);
  const slot = (w - pad.l - pad.r) / items.length, bw = Math.min(40, slot * 0.64);
  const bars = items.map((it, i) => {
    const cx = pad.l + slot * (i + 0.5), top = Y(Math.max(it.auc, 0.5)), bottom = Y(Math.min(it.auc, 0.5));
    return { x: cx - bw / 2, w: bw, y: top, h: Math.max(1.5, bottom - top), cx, auc: it.auc, n: it.n, day: it.day, above: it.auc >= 0.5 };
  });
  return { bars, refY: Y(0.5), Y, pad, lo, hi };
}

/** Progress 0..1 toward a threshold (never NaN, clamped). */
export const progress = (have, need) => (need > 0 ? Math.max(0, Math.min(1, (have || 0) / need)) : 1);

/** One-line plain-English status for the learning loop, from the /v1/learning payload. */
export function learningHeadline(d) {
  if (!d || !d.calibration || !d.calibration.present) return { cls: "muted", text: "COLLECTING: no calibration yet. The model scores everything and every outcome is recorded." };
  const qs = Object.entries(d.calibration.questions || {});
  const t = qs.filter(([, q]) => q.trusted).map(([k]) => k.replace("win_", "").replace("_", " ").toLowerCase());
  if (t.length) return { cls: "good", text: `EARNING: ${t.join(", ")} passed held-out validation and trades at full size. Trust is re-tested every ${d.settings.learn_interval_min} minutes and withdrawn if it fades.` };
  return { cls: "muted", text: "PROVING: nothing has earned trust yet. The system keeps learning from every scan and only risks smallest-size exploration trades." };
}
