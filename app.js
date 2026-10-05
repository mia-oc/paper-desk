// Paper Desk - static, read-only dashboard. SECURITY: every dynamic value is rendered with textContent / createTextNode.
// There is no innerHTML anywhere; the CSP additionally forbids inline script/style and third-party origins.
import { deriveToken, gbp, pct, num, sgn, price, trunc, ago, dur, clock, chartGeometry, nearest, OUTCOME_CLASS } from "./lib.js";

const API = (window.PAPERDESK && window.PAPERDESK.api) || "";
const REFRESH_MS = 5000;
const SVGNS = "http://www.w3.org/2000/svg";
const store = window.sessionStorage;           // per-tab session storage: cleared when the tab closes

const state = { token: store.getItem("pd.token") || "", tab: "overview", hours: 24, timer: null, busy: false, pages: {}, open: new Set(), details: {} };

/* ---------------- tiny DOM helpers ---------------- */
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
function svg(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}
const $ = (id) => document.getElementById(id);
const span = (cls, text) => h("span", { class: cls, text });
const pill = (cls, text, dot = false) => h("span", { class: `pill ${cls}` }, dot ? h("i") : null, text);
const num_td = (text, cls = "") => h("td", { class: `r num ${cls}`, text });

/* ---------------- API ---------------- */
class ApiError extends Error { constructor(status, retry) { super(`HTTP ${status}`); this.status = status; this.retry = retry; } }

async function api(path) {
  const r = await fetch(API + path, { headers: { Authorization: `Bearer ${state.token}` }, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
  if (r.status === 401) { logout("Session expired. Unlock again."); throw new ApiError(401); }
  if (r.status === 429) throw new ApiError(429, Number(r.headers.get("Retry-After") || 30));
  if (!r.ok) throw new ApiError(r.status);
  return r.json();
}

/* ---------------- auth gate ---------------- */
async function login(password) {
  const token = await deriveToken(password);
  const r = await fetch(`${API}/v1/overview`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
  if (r.status === 401) throw new ApiError(401);
  if (r.status === 429) throw new ApiError(429, Number(r.headers.get("Retry-After") || 60));
  if (!r.ok) throw new ApiError(r.status);
  state.token = token;
  store.setItem("pd.token", token);
}
function logout(msg = "") {
  state.token = "";
  store.removeItem("pd.token");
  clearInterval(state.timer);
  $("app").hidden = true;
  $("gate").hidden = false;
  $("pw").value = "";
  $("login-msg").textContent = msg;
}
function wireGate() {
  $("login").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = $("go"), msg = $("login-msg");
    btn.disabled = true; msg.textContent = "";
    try {
      await login($("pw").value);
      $("pw").value = "";
      startApp();
    } catch (e) {
      msg.textContent = e.status === 401 ? "That passphrase is not right." : e.status === 429 ? `Too many attempts. Try again in ${e.retry}s.` : "Cannot reach the data service. Is the Mac mini online?";
    } finally { btn.disabled = false; }
  });
}

/* ---------------- shell ---------------- */
const TABS = [["overview", "Overview"], ["positions", "Positions"], ["trades", "Trades"], ["decisions", "Decisions"], ["market", "Market"], ["system", "System"]];

function startApp() {
  $("gate").hidden = true;
  const app = $("app");
  app.hidden = false;
  app.replaceChildren(
    h("header", { class: "top" },
      h("div", { class: "brand" }, h("div", { class: "logo" }), "Paper Desk"),
      h("nav", { class: "tabs", role: "tablist" }, TABS.map(([id, label]) =>
        h("button", { class: "tab", role: "tab", id: `tab-${id}`, "aria-selected": String(id === state.tab), onclick: () => selectTab(id) }, label))),
      h("div", { class: "spacer" }),
      h("span", { id: "engine-pill" }),
      h("button", { class: "ghost", id: "lock", onclick: () => logout("") }, "Lock")),
    h("main", { class: "wrap", id: "view" }, h("div", { class: "skeleton" })),
    h("footer", { class: "foot", id: "foot" }, "Paper trading only · read-only view"));
  clearInterval(state.timer);
  state.timer = setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  refresh();
}
function selectTab(id) {
  state.tab = id;
  state.pages = {};
  for (const [t] of TABS) $(`tab-${t}`).setAttribute("aria-selected", String(t === id));
  refresh();
}
async function refresh() {
  if (state.busy || !state.token) return;
  state.busy = true;
  const view = $("view");
  try {
    const content = await VIEWS[state.tab]();
    view.replaceChildren(...content);
    if (state.tab === "decisions") loadDetails();
    $("foot").textContent = `Paper trading only · read-only view · updated ${clock(Date.now() / 1000)}`;
  } catch (e) {
    if (e.status === 401) return;
    const msg = e.status === 429 ? `Rate limited - retrying (${e.retry}s).` : "Data service unreachable - retrying.";
    const existing = view.querySelector(".banner");
    if (existing) existing.textContent = msg; else view.prepend(h("div", { class: "banner bad", role: "status", text: msg }));
  } finally { state.busy = false; }
}

/* ---------------- shared widgets ---------------- */
function kpi(label, value, sub, cls = "") {
  return h("div", { class: "card kpi" }, h("div", { class: "label", text: label }), h("div", { class: `value num ${cls}`, text: value }), sub ? h("div", { class: "sub muted num", text: sub }) : null);
}
function panel(title, ...body) { return h("section", { class: "card panel" }, h("h2", {}, title), ...body); }
function table(heads, rows, empty = "Nothing here yet.") {
  if (!rows.length) return h("div", { class: "empty", text: empty });
  return h("div", { class: "scroll" }, h("table", {}, h("thead", {}, h("tr", {}, heads.map(([t, r]) => h("th", { class: r ? "r" : "", text: t })))), h("tbody", {}, rows)));
}
function enginePill(e) {
  const map = { running: ["good", "Live"], paused: ["warn", "Paused"], halted: ["bad", "Halted"], kill_switch: ["bad", "Kill switch"], llm_unhealthy: ["warn", "Model offline"], down: ["bad", "Engine down"] };
  const [cls, txt] = map[e.state] || ["muted", e.state];
  const el = $("engine-pill");
  if (el) el.replaceChildren(pill(cls, txt, true));
}
function arrow(t) { return span(`arrow ${t === "UP" ? "up" : t === "DOWN" ? "down" : "flat"}`, t === "UP" ? "▲" : t === "DOWN" ? "▼" : "–"); }
function stat(rec) { return rec && rec.n ? `${rec.n} · ${num(rec.win_rate * 100, 0)}% · ${gbp(rec.expectancy, 0, true)}/tr` : "-"; }

/* ---------------- equity chart ---------------- */
function equityChart(points, ref) {
  const W = 800, H = 270;
  const g = chartGeometry(points, W, H, undefined, ref);
  if (!g) return h("div", { class: "empty", text: "Collecting equity data…" });
  const up = points[points.length - 1].nav >= points[0].nav;
  const col = up ? "#34d3a8" : "#ff6b81";
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Account value over time", preserveAspectRatio: "none" });
  const grad = svg("linearGradient", { id: "eqg", x1: 0, y1: 0, x2: 0, y2: 1 }, svg("stop", { offset: "0%", "stop-color": col, "stop-opacity": ".35" }), svg("stop", { offset: "100%", "stop-color": col, "stop-opacity": "0" }));
  root.append(svg("defs", {}, grad));
  for (const t of g.ticks) {
    root.append(svg("line", { class: "grid-line", x1: g.pad.l, x2: W - g.pad.r, y1: t.y, y2: t.y }));
    const lab = svg("text", { class: "axis", x: g.pad.l - 8, y: t.y + 4, "text-anchor": "end" }); lab.textContent = gbp(t.v, 0); root.append(lab);
  }
  if (g.refY !== null) root.append(svg("line", { class: "ref", x1: g.pad.l, x2: W - g.pad.r, y1: g.refY, y2: g.refY }));
  root.append(svg("path", { d: g.area, fill: "url(#eqg)" }), svg("path", { d: g.line, fill: "none", stroke: col, "stroke-width": 2, "stroke-linejoin": "round", "vector-effect": "non-scaling-stroke" }));
  for (const frac of [0, .25, .5, .75, 1]) {
    const ts = g.x0 + (g.x1 - g.x0) * frac, lab = svg("text", { class: "axis", x: g.X(ts), y: H - 6, "text-anchor": frac === 0 ? "start" : frac === 1 ? "end" : "middle" });
    lab.textContent = clock(ts, g.x1 - g.x0 > 86400); root.append(lab);
  }
  const cross = svg("line", { x1: 0, x2: 0, y1: g.pad.t, y2: H - g.pad.b, stroke: "rgba(230,236,248,.35)", visibility: "hidden" });
  const dot = svg("circle", { r: 4, fill: col, stroke: "#070c17", "stroke-width": 2, visibility: "hidden" });
  const hit = svg("rect", { x: 0, y: 0, width: W, height: H, fill: "transparent" });
  root.append(cross, dot, hit);
  const tip = h("div", { class: "tip", hidden: true });
  hit.addEventListener("mousemove", (ev) => {
    const box = root.getBoundingClientRect(), x = ((ev.clientX - box.left) / box.width) * W;
    const ts = g.x0 + ((x - g.pad.l) / (W - g.pad.l - g.pad.r)) * (g.x1 - g.x0);
    const p = points[nearest(points, ts)], px = g.X(p.ts), py = g.Y(p.nav);
    cross.setAttribute("x1", px); cross.setAttribute("x2", px); cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", px); dot.setAttribute("cy", py); dot.setAttribute("visibility", "visible");
    tip.hidden = false; tip.textContent = `${clock(p.ts, true)} · ${gbp(p.nav, 2)}`;
    tip.style.left = `${(px / W) * 100}%`; tip.style.top = `${(py / H) * box.height}px`;
  });
  hit.addEventListener("mouseleave", () => { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); tip.hidden = true; });
  return h("div", { class: "chart" }, root, tip);
}

/* ---------------- views ---------------- */
async function viewOverview() {
  const [ov, eq] = await Promise.all([api("/v1/overview"), api(`/v1/equity?hours=${state.hours}`)]);
  enginePill(ov.engine);
  const a = ov.account, s = ov.summary.overall;
  const out = [];
  if (ov.engine.state !== "running") out.push(h("div", { class: `banner ${ov.engine.state === "down" ? "bad" : ""}`, role: "status", text: bannerText(ov.engine) }));
  if (a) {
    out.push(h("div", { class: "grid kpis" },
      kpi("Account value", gbp(a.nav, 2), `Balance ${gbp(a.balance, 2)}`),
      kpi("Since start", gbp(a.since_start, 2, true), pct(a.since_start_pct), sgn(a.since_start)),
      kpi("Today", gbp(a.day_pnl, 2, true), pct(a.day_pnl_pct), sgn(a.day_pnl)),
      kpi("Open P&L", gbp(a.unrealized, 2, true), `${a.open_n} open · margin ${gbp(a.margin_used, 0)}`, sgn(a.unrealized)),
      kpi("Drawdown", pct(-a.drawdown_pct, 2, false), `Peak ${gbp(a.peak, 0)}`, a.drawdown_pct > 2 ? "neg" : "")));
  }
  const rangeBtns = h("div", { class: "seg" }, [[6, "6h"], [24, "24h"], [168, "7d"], [720, "30d"]].map(([hrs, label]) =>
    h("button", { "aria-pressed": String(state.hours === hrs), onclick: () => { state.hours = hrs; refresh(); } }, label)));
  out.push(h("div", { class: "grid two" },
    panel([h("span", { text: "Equity" }), h("span", { class: "spacer" }), rangeBtns], equityChart(eq.points, a ? a.reference_nav : null)),
    panel("Performance",
      h("dl", { class: "kv" },
        h("dt", { text: "Closed trades" }), h("dd", { class: "num", text: String(s.n) }),
        h("dt", { text: "Win rate" }), h("dd", { class: "num", text: s.n ? pct(s.win_rate * 100, 0, false) : "-" }),
        h("dt", { text: "Profit factor" }), h("dd", { class: "num", text: s.profit_factor ? num(s.profit_factor, 2) : "-" }),
        h("dt", { text: "Expectancy / trade" }), h("dd", { class: `num ${sgn(s.expectancy)}`, text: s.n ? gbp(s.expectancy, 2, true) : "-" }),
        h("dt", { text: "Avg win / loss" }), h("dd", { class: "num", text: s.n ? `${gbp(s.avg_win, 0, true)} / ${gbp(s.avg_loss, 0)}` : "-" }),
        h("dt", { text: "Realised P&L" }), h("dd", { class: `num ${sgn(s.pnl)}`, text: s.n ? gbp(s.pnl, 2, true) : "-" })))));
  out.push(h("div", { class: "grid three" }, edgePanel(ov.edge), breakdown("By playbook", ov.summary.by_playbook), breakdown("By close reason", ov.summary.by_reason)));
  return out;
}
function bannerText(e) {
  return { down: "The trading engine is not reporting. Positions keep their server-side stop-loss and take-profit.", paused: "Entries are paused (open positions are still managed).",
    halted: "Drawdown halt: no new entries until resumed from Telegram.", kill_switch: "Kill switch file present: no new entries.", llm_unhealthy: "Local model unavailable: entries suspended until it recovers." }[e.state] || e.state;
}
function edgePanel(edge) {
  const v = edge.verdict, cls = v.startsWith("positive") ? "good" : v.includes("NEGATIVE") ? "bad" : "muted";
  const rows = [["5 min", "fwd5"], ["15 min", "fwd15"], ["60 min", "fwd60"]].map(([label, k]) => {
    const x = edge.horizons[k] || { n: 0 };
    return h("tr", {}, h("td", { text: label }), num_td(String(x.n)), num_td(x.n ? num(x.mean_atr, 2) : "-", x.n ? sgn(x.mean_atr) : ""), num_td(x.n ? `${num(x.ci_low, 2)} … ${num(x.ci_high, 2)}` : "-"), num_td(x.n ? pct(x.hit_rate * 100, 0, false) : "-"));
  });
  return panel("Is the model adding value?", h("div", { class: `verdict ${cls}`, text: v }),
    table([["Horizon"], ["Picks", 1], ["Mean (ATR)", 1], ["95% CI", 1], ["Hit", 1]], rows),
    h("p", { class: "fine", text: "Forward move after each directional pick, in M5-ATRs, net of spread. Skipped ideas are excluded. Profit alone is not proof of skill." }));
}
function breakdown(title, groups) {
  const rows = Object.entries(groups).sort((a, b) => b[1].pnl - a[1].pnl).map(([k, v]) => h("tr", {}, h("td", { text: k }), num_td(String(v.n)), num_td(pct(v.win_rate * 100, 0, false)), num_td(gbp(v.pnl, 0, true), sgn(v.pnl))));
  return panel(title, table([["Group"], ["N", 1], ["Win", 1], ["P&L", 1]], rows, "No closed trades yet."));
}

async function viewPositions() {
  const [d, ov] = await Promise.all([api("/v1/positions"), api("/v1/overview")]);
  enginePill(ov.engine);
  const rows = d.positions.map((p) => {
    const frac = Math.max(0, Math.min(1, (p.r_now + 1) / 3));
    const bar = h("span", { class: "bar rbar" }, h("b", { class: p.r_now < 0 ? "neg" : "" }));
    bar.firstChild.style.width = `${frac * 100}%`;
    return h("tr", {}, h("td", {}, span("side " + p.side, p.side.toUpperCase()), " ", p.instrument.replace("_", "/")), num_td(num(p.units, 0)), h("td", { text: p.playbook || "-" }),
      num_td(String(p.entry)), num_td(String(p.sl ?? "-")), num_td(String(p.tp ?? "-")),
      h("td", { class: "r" }, bar, " ", span(`num ${sgn(p.r_now)}`, `${p.r_now >= 0 ? "+" : ""}${num(p.r_now, 2)}R`)),
      num_td(gbp(p.unrealized, 2, true), sgn(p.unrealized)), num_td(`${dur(p.held_min)} / ${dur(p.max_hold_min)}`));
  });
  return [panel(`Open positions (${d.positions.length})`, table([["Instrument"], ["Units", 1], ["Playbook"], ["Entry", 1], ["Stop", 1], ["Target", 1], ["P&L (R)", 1], ["Unrealised", 1], ["Held / max", 1]], rows, "No open positions."))];
}

async function viewTrades() {
  const off = state.pages.trades || 0;
  const d = await api(`/v1/trades?state=closed&limit=${50 + off}&offset=0`);
  const rows = d.trades.map((t) => h("tr", {}, h("td", { class: "num", text: clock(t.closed_at, true) }), h("td", {}, span("side " + t.side, t.side.toUpperCase()), " ", t.instrument.replace("_", "/")),
    h("td", { text: t.playbook || "-" }), num_td(num(t.units, 0)), num_td(String(t.entry)), num_td(String(t.exit ?? "-")), num_td(gbp(t.pnl, 2, true), sgn(t.pnl)),
    h("td", {}, pill(t.close_reason === "TP" ? "good" : t.close_reason === "SL" ? "bad" : "muted", t.close_reason || "-")),
    num_td(`${num(t.mfe_r || 0, 1)} / ${num(t.mae_r || 0, 1)}`), h("td", { class: "why", text: trunc(t.why, 90) })));
  const out = [panel(`Closed trades (${d.total})`, table([["Closed"], ["Trade"], ["Playbook"], ["Units", 1], ["Entry", 1], ["Exit", 1], ["P&L", 1], ["Reason"], ["MFE/MAE R", 1], ["Model's reason"]], rows, "No closed trades yet."))];
  if (d.trades.length < d.total) out.at(-1).append(h("button", { class: "ghost more", onclick: () => { state.pages.trades = off + 50; refresh(); } }, "Load more"));
  return out;
}

async function viewDecisions() {
  const kind = state.pages.kind || "all", off = state.pages.decisions || 0;
  const d = await api(`/v1/decisions?kind=${kind}&limit=${60 + off}&offset=0`);
  const seg = h("div", { class: "seg" }, [["all", "All"], ["entry", "Entries"], ["manage", "Positions"]].map(([k, l]) =>
    h("button", { "aria-pressed": String(kind === k), onclick: () => { state.pages.kind = k; state.pages.decisions = 0; refresh(); } }, l)));
  const rows = [];
  for (const x of d.decisions) {
    rows.push(h("tr", { class: "row", "data-id": x.id, onclick: () => toggleDetail(x.id) },
      h("td", { class: "num", text: clock(x.ts, true) }), h("td", { text: x.instrument.replace("_", "/") }), h("td", { text: x.kind }),
      h("td", { text: x.action || "-" }), num_td(x.size ? `${x.size} · c${x.confidence}` : "-"),
      h("td", {}, pill(OUTCOME_CLASS[x.outcome] || "muted", x.reject_reason && x.outcome === "rejected" ? `blocked: ${x.reject_reason}` : x.outcome)),
      num_td(x.fwd15 === null || x.fwd15 === undefined ? "-" : num(x.fwd15, 2), x.fwd15 ? sgn(x.fwd15) : ""), num_td(x.latency_ms ? `${(x.latency_ms / 1000).toFixed(1)}s` : "-"),
      h("td", { class: "why", text: trunc(x.why, 110) })));
    if (state.open.has(x.id)) rows.push(h("tr", { class: "detail", "data-detail": x.id }, h("td", { colspan: 9 }, h("pre", { id: `det-${x.id}`, text: state.details[x.id] || "Loading…" }))));
  }
  const out = [panel([h("span", { text: `Model decisions (${d.total})` }), h("span", { class: "spacer" }), seg],
    table([["Time"], ["Instrument"], ["Kind"], ["Choice"], ["Size · conf", 1], ["Outcome"], ["Fwd15 ATR", 1], ["Latency", 1], ["Why"]], rows, "No decisions yet."),
    h("p", { class: "fine", text: "Click a row to see exactly what the model was shown and what it answered." }))];
  if (d.decisions.length < d.total) out[0].append(h("button", { class: "ghost more", onclick: () => { state.pages.decisions = off + 60; refresh(); } }, "Load more"));
  return out;
}
function toggleDetail(id) { state.open.has(id) ? state.open.delete(id) : state.open.add(id); refresh(); }
async function loadDetails() {
  for (const id of [...state.open]) {
    if (state.details[id]) continue;
    try {
      const d = await api(`/v1/decisions/${id}`);
      state.details[id] = JSON.stringify({ model_answer: d.raw, options_offered: d.options_json, market_card: d.card_json, outcome: d.outcome, reject_reason: d.reject_reason }, null, 2);
    } catch { state.details[id] = "Unavailable (details are kept for 7 days)."; }
    const el = $(`det-${id}`);
    if (el) el.textContent = state.details[id];
  }
}

async function viewMarket() {
  const [d, ov] = await Promise.all([api("/v1/market"), api("/v1/overview")]);
  enginePill(ov.engine);
  const rows = d.instruments.sort((a, b) => b.interest - a.interest).map((m) => {
    const bar = h("span", { class: "bar" }, h("b")); bar.firstChild.style.width = `${Math.min(100, m.interest)}%`;
    return h("tr", {}, h("td", { text: m.instrument.replace("_", "/") }), num_td(price(m.price, m.dp)), h("td", {}, bar, " ", span("num muted", num(m.interest, 0))),
      h("td", {}, arrow(m.trend.M5), arrow(m.trend.H1), arrow(m.trend.D)), num_td(`${num(m.rsi.M5, 0)} / ${num(m.rsi.H1, 0)}`),
      num_td(pct(m.chg["1h"], 2), sgn(m.chg["1h"])), num_td(pct(m.chg["1d"], 2), sgn(m.chg["1d"])), num_td(num(m.spread_pips, 1)), h("td", {}, (m.tags || []).map((t) => span("chip", t))));
  });
  return [panel("Market scanner", table([["Instrument"], ["Price", 1], ["Interest"], ["M5 H1 D"], ["RSI M5/H1", 1], ["1h", 1], ["1d", 1], ["Spread (p)", 1], ["Signals"]], rows, "Waiting for the first scan…"),
    h("p", { class: "fine", text: "Interest is a deterministic 0-100 score that decides which instruments the model gets to look at." }))];
}

async function viewSystem() {
  const [s, ov] = await Promise.all([api("/v1/system"), api("/v1/overview")]);
  enginePill(ov.engine);
  const e = s.engine || {}, L = s.limits;
  const ev = s.events.map((x) => h("tr", {}, h("td", { class: "num", text: clock(x.ts, true) }), h("td", {}, pill(x.level === "info" ? "muted" : x.level === "warn" ? "warn" : "bad", x.level)), h("td", { text: x.kind }), h("td", { class: "why", text: x.msg })));
  return [h("div", { class: "grid three" },
    panel("Engine", h("dl", { class: "kv" },
      h("dt", { text: "State" }), h("dd", {}, pill(ov.engine.state === "running" ? "good" : "warn", ov.engine.state, true)),
      h("dt", { text: "Heartbeat" }), h("dd", { class: "num", text: ov.engine.age_s === null ? "-" : `${ov.engine.age_s}s ago` }),
      h("dt", { text: "Model" }), h("dd", { text: e.model || "-" }), h("dt", { text: "Started" }), h("dd", { text: ago(e.started_at) }),
      h("dt", { text: "Instruments" }), h("dd", { class: "num", text: String(e.instruments ?? "-") }), h("dt", { text: "Price updates" }), h("dd", { class: "num", text: num(e.stream_msgs ?? 0, 0) }),
      h("dt", { text: "Queue" }), h("dd", { class: "num", text: String(e.queue ?? "-") }), h("dt", { text: "Database" }), h("dd", { class: "num", text: `${num(s.db_bytes / 1048576, 1)} MB` }))),
    panel("Local model", h("dl", { class: "kv" },
      h("dt", { text: "Latency p50" }), h("dd", { class: "num", text: s.llm.p50_ms ? `${(s.llm.p50_ms / 1000).toFixed(1)}s` : "-" }), h("dt", { text: "Latency p95" }), h("dd", { class: "num", text: s.llm.p95_ms ? `${(s.llm.p95_ms / 1000).toFixed(1)}s` : "-" }),
      h("dt", { text: "Consecutive failures" }), h("dd", { class: "num", text: String(e.llm_failures ?? 0) }),
      Object.entries(s.outcomes_24h).map(([k, v]) => [h("dt", { text: `${k} (24h)` }), h("dd", { class: "num", text: String(v) })]))),
    panel("Guardrails (enforced by code)", h("dl", { class: "kv" },
      h("dt", { text: "Risk per trade (tiers)" }), h("dd", { class: "num", text: Object.values(L.risk_pct_tiers).map((x) => `${x}%`).join(" / ") }),
      h("dt", { text: "Max open positions" }), h("dd", { class: "num", text: String(L.max_open) }), h("dt", { text: "Max total risk" }), h("dd", { class: "num", text: `${L.max_total_risk_pct}% NAV` }),
      h("dt", { text: "Daily loss limit" }), h("dd", { class: "num", text: `${L.daily_loss_pct}%` }), h("dt", { text: "Drawdown halt" }), h("dd", { class: "num", text: `${L.drawdown_halt_pct}%` }),
      h("dt", { text: "Entries / hour" }), h("dd", { class: "num", text: String(L.entries_per_hour) })))),
  panel("Recent events", table([["Time"], ["Level"], ["Kind"], ["Message"]], ev, "No events."))];
}

const VIEWS = { overview: viewOverview, positions: viewPositions, trades: viewTrades, decisions: viewDecisions, market: viewMarket, system: viewSystem };

/* ---------------- boot ---------------- */
wireGate();
if (state.token) startApp();
