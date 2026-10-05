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
