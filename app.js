// Paper Desk - static, read-only dashboard. SECURITY: every dynamic value is rendered with textContent / createTextNode.
// There is no innerHTML anywhere; the CSP additionally forbids inline script/style and third-party origins.
import { deriveToken, money, pct, num, sgn, price, trunc, ago, dur, clock, chartGeometry, nearest, stepGeometry, aucBars, progress, learningHeadline, exchangeStatus, shortName, isWaiting, WAITING_TEXT, CONNECT_CMD, OUTCOME_CLASS } from "./lib.js";

const API = (window.PAPERDESK && window.PAPERDESK.api) || "";
let OPEN = !!(window.PAPERDESK && window.PAPERDESK.open === true);        // paper-only deploy: the read-only API needs no passphrase (falls back to the gate if it answers 401)
const REFRESH_MS = 5000;
const TAPE_MS = 15000;
const SVGNS = "http://www.w3.org/2000/svg";
const store = window.sessionStorage;           // per-tab session storage: cleared when the tab closes

const CLASSES = [["all", "All"], ["fx", "FX"], ["index", "Indices"], ["metal", "Metals"], ["energy", "Energy"], ["bond", "Bonds"]];
const CLASSED = ["/v1/overview", "/v1/positions", "/v1/trades", "/v1/decisions", "/v1/market", "/v1/learning"];
const state = { token: OPEN ? "open" : store.getItem("pd.token") || "", tab: "overview", cls: store.getItem("pd.cls") || "all", acct: store.getItem("pd.acct") || "", accounts: [], hours: 24,
  timer: null, busy: false, pages: {}, open: new Set(), details: {}, tapeAt: 0, tapeKey: "" };

/* ---------------- accounts (one per broker desk) ---------------- */
const acctInfo = (id = state.acct) => state.accounts.find((a) => a.id === id) || null;
const acctIndex = (id) => Math.max(0, state.accounts.findIndex((a) => a.id === id));
const sym = (id = state.acct) => (acctInfo(id) || {}).symbol || "£";
const cur = (x, dp = 0, sign = false, id = state.acct) => money(x, dp, sign, sym(id));
const isShares = () => (acctInfo() || {}).broker === "alpaca";
const effClass = () => ((acctInfo() || {}).broker === "oanda" || !acctInfo() ? state.cls : "all");

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

function withParams(path, account) {
  const params = [];
  if (!path.startsWith("/v1/accounts")) {
    const acct = account || state.acct;
    if (acct) params.push("account=" + encodeURIComponent(acct));
    const cls = account && account !== state.acct ? "all" : effClass();
    if (cls !== "all" && CLASSED.some((p) => path === p || path.startsWith(p + "?"))) params.push("class=" + encodeURIComponent(cls));
  }
  return params.length ? path + (path.includes("?") ? "&" : "?") + params.join("&") : path;
}
async function api(path, account = "") {
  const r = await fetch(API + withParams(path, account), { headers: OPEN ? {} : { Authorization: `Bearer ${state.token}` }, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
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
  OPEN = false;                                                               // the API wants a passphrase after all
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

/* ---------------- theme ---------------- */
function applyTheme(t) { document.documentElement.setAttribute("data-theme", t); store.setItem("pd.theme", t); }
applyTheme(store.getItem("pd.theme") || "dark");

/* ---------------- shell ---------------- */
const TABS = [["overview", "Overview"], ["positions", "Positions"], ["trades", "Trades"], ["decisions", "Decisions"], ["market", "Markets"], ["learning", "Learning"], ["system", "System"]];

function startApp() {
  $("gate").hidden = true;
  const app = $("app");
  app.hidden = false;
  app.replaceChildren(
    h("header", { class: "top" },
      h("div", { class: "bar1" },
        h("div", { class: "brand" }, h("i"), h("h1", { class: "title", text: "Paper Desk" })),
        h("div", { class: "accts", id: "accts", role: "group", "aria-label": "Trading accounts" }),
        h("div", { class: "tools" },
          h("div", { class: "sessions", id: "sessions", "aria-label": "Exchange sessions" }),
          h("div", { class: "clockbox num", id: "clockbox" }),
          h("span", { id: "engine-pill" }),
          h("button", { class: "ghost", id: "theme", onclick: () => applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark") }, "Theme"),
          OPEN ? null : h("button", { class: "ghost", id: "lock", onclick: () => logout("") }, "Lock"))),
      h("div", { class: "bar2" },
        h("nav", { class: "tabs", role: "tablist" }, TABS.map(([id, label]) =>
          h("button", { class: "tab", role: "tab", id: `tab-${id}`, "aria-selected": String(id === state.tab), onclick: () => selectTab(id) }, label))),
        h("div", { class: "filters", id: "filters", role: "group", "aria-label": "Market filter" },
          h("span", { text: "Market" }),
          CLASSES.map(([id, label]) => h("button", { "data-cls": id, "aria-pressed": String(state.cls === id), onclick: () => selectClass(id) }, label))))),
    h("div", { class: "tape", "aria-label": "Watchlist" }, h("div", { class: "tape-in", id: "tape" })),
    h("main", { class: "wrap", id: "view" }, h("div", { class: "skeleton" })),
    h("footer", { class: "foot", id: "foot" }, "Paper trading only · read-only view"));
  clearInterval(state.timer);
  state.timer = setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  tickMasthead();
  refresh();
}
function tickMasthead() {
  const now = Date.now(), cb = $("clockbox"), ss = $("sessions");
  if (!cb || !ss) return;
  cb.replaceChildren(h("div", { text: `${clock(now / 1000)} local` }), h("div", { text: `${new Date(now).toISOString().slice(11, 16)} UTC` }));
  ss.replaceChildren(...exchangeStatus(now).map((x) => h("span", { class: x.open ? "on" : "", title: `${x.name} ${x.local} · ${x.open ? "open" : "closed"}` }, `${x.code} ${x.local}`)));
}
setInterval(() => { if (state.token) tickMasthead(); }, 30000);

function renderAccounts() {
  const box = $("accts");
  if (!box) return;
  box.replaceChildren(...state.accounts.map((a, i) => {
    const ac = a.account, waiting = isWaiting(a.engine.state) || !ac;
    const name = [shortName(a.label), ...String(a.label).split(" ").slice(1)].join(" ");
    return h("button", { class: `acct c${i}`, "data-acct": a.id, "aria-pressed": String(a.id === state.acct), onclick: () => selectAcct(a.id), title: a.label },
      h("span", { class: "adot" }), h("span", { class: "name", text: name }),
      waiting ? h("span", { class: "off", text: waitingShort(a.engine.state) })
        : h("span", { class: "val num" }, money(ac.nav, 2, false, a.symbol), h("span", { class: `chg ${sgn(ac.day_pnl)}`, text: pct(ac.day_pnl_pct, 2) })));
  }));
  const f = $("filters");
  if (f) f.hidden = !(acctInfo() && acctInfo().broker === "oanda") ;
}
const waitingShort = (s) => ({ awaiting_credentials: "awaiting secret key", auth_failed: "key rejected", unreachable: "broker unreachable", not_started: "not started" }[s] || s);
async function loadAccounts() {
  const d = await api("/v1/accounts");
  state.accounts = d.accounts;
  if (!acctInfo()) { state.acct = d.default; store.setItem("pd.acct", state.acct); }
  renderAccounts();
}
function selectAcct(id) {
  if (id === state.acct) return;
  state.acct = id;
  store.setItem("pd.acct", id);
  state.pages = {}; state.open = new Set(); state.details = {}; state.tapeAt = 0;
  renderAccounts();
  refresh();
}
function selectClass(id) {
  state.cls = id;
  store.setItem("pd.cls", id);
  state.pages = {};
  for (const b of document.querySelectorAll("#filters button")) b.setAttribute("aria-pressed", String(b.dataset.cls === id));
  refresh();
}
function selectTab(id) {
  state.tab = id;
  state.pages = {};
  for (const [t] of TABS) $(`tab-${t}`).setAttribute("aria-selected", String(t === id));
  refresh();
}
async function refresh() {
  if (!state.token) return;
  if (state.busy) { state.queued = true; return; }                              // a click during a fetch must not be dropped: run again right after
  state.busy = true;
  const view = $("view");
  try {
    await loadAccounts();
    const content = await VIEWS[state.tab]();
    view.replaceChildren(...content);
    if (state.tab === "decisions") loadDetails();
    $("foot").textContent = `Paper trading only · read-only view · updated ${clock(Date.now() / 1000)}`;
    refreshTape();
  } catch (e) {
    if (e.status === 401) return;
    const msg = e.status === 429 ? `Rate limited - retrying (${e.retry}s).` : "Data service unreachable - retrying.";
    const existing = view.querySelector(".banner");
    if (existing) existing.textContent = msg; else view.prepend(h("div", { class: "banner bad", role: "status", text: msg }));
  } finally {
    state.busy = false;
    if (state.queued) { state.queued = false; refresh(); }
  }
}

/* watchlist tape: the selected account's most interesting instruments, refreshed more slowly than the page */
async function refreshTape() {
  const a = acctInfo(), key = `${state.acct}|${effClass()}`;
  if (!a || isWaiting(a.engine.state) || (Date.now() - state.tapeAt < TAPE_MS && state.tapeKey === key)) return;
  state.tapeAt = Date.now(); state.tapeKey = key;
  try {
    const d = await api("/v1/market");
    const items = d.instruments.filter((m) => m.price !== null && m.price !== undefined).sort((x, y) => y.interest - x.interest).slice(0, 14);
    $("tape").replaceChildren(...items.map((m) => h("div", { class: "tk" }, h("b", { text: tickerName(m.instrument) }), h("span", { class: "tpx num", text: price(m.price, m.dp) }),
      h("span", { class: `num ${sgn(m.chg["1d"])}`, text: pct(m.chg["1d"], 2) }))));
  } catch { /* the tape is decoration; the page banner reports outages */ }
}
const tickerName = (inst) => (inst.endsWith("_USD") && isShares() ? inst.slice(0, -4) : inst.replace("_", "/"));

/* ---------------- shared widgets ---------------- */
function kpi(label, value, sub, cls = "") {
  return h("div", { class: "kpi" }, h("div", { class: "label", text: label }), h("div", { class: `value num ${cls}`, text: value }), sub ? h("div", { class: "sub num", text: sub }) : null);
}
function panel(title, ...body) { return h("section", { class: "panel" }, h("h2", {}, title), ...body); }
function table(heads, rows, empty = "Nothing here yet.") {
  if (!rows.length) return h("div", { class: "empty", text: empty });
  return h("div", { class: "scroll" }, h("table", {}, h("thead", {}, h("tr", {}, heads.map(([t, r]) => h("th", { class: r ? "r" : "", text: t })))), h("tbody", {}, rows)));
}
function enginePill(e) {
  const map = { running: ["good", "Live"], paused: ["warn", "Paused"], halted: ["bad", "Halted"], kill_switch: ["bad", "Kill switch"], model_unhealthy: ["warn", "Model offline"], down: ["bad", "Engine down"],
    awaiting_credentials: ["warn", "Awaiting key"], auth_failed: ["bad", "Key rejected"], unreachable: ["warn", "Unreachable"], not_started: ["muted", "Not started"] };
  let [cls, txt] = map[e.state] || ["muted", e.state];
  if (e.state === "running" && !(e.trusted_questions && e.trusted_questions.length)) [cls, txt] = ["warn", e.explore ? "Exploring" : "Shadow"];   // nothing validated: smallest-size trades only (explore) or none (shadow)
  return pill(cls, txt, true);
}
function setEnginePill(e) { const el = $("engine-pill"); if (el) el.replaceChildren(enginePill(e)); }
function arrow(t) { return span(`arrow ${t === "UP" ? "up" : t === "DOWN" ? "down" : "flat"}`, t === "UP" ? "▲" : t === "DOWN" ? "▼" : "–"); }
function stat(rec) { return rec && rec.n ? `${rec.n} · ${num(rec.win_rate * 100, 0)}% · ${cur(rec.expectancy, 0, true)}/tr` : "-"; }

/* ---------------- equity chart ---------------- */
function equityChart(points, ref, symbol = "£", label = "Account value over time") {
  const W = 640, H = 250;
  const g = chartGeometry(points, W, H, undefined, ref);
  if (!g) return h("div", { class: "empty", text: "Collecting equity data…" });
  const dp = g.hi - g.lo < 25 ? 2 : 0;
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": label });
  for (const t of g.ticks) {
    root.append(svg("line", { class: "grid-line", x1: g.pad.l, x2: W - g.pad.r, y1: t.y, y2: t.y }));
    const lab = svg("text", { class: "axis", x: g.pad.l - 8, y: t.y + 4, "text-anchor": "end" }); lab.textContent = money(t.v, dp, false, symbol); root.append(lab);
  }
  if (g.refY !== null) root.append(svg("line", { class: "ref", x1: g.pad.l, x2: W - g.pad.r, y1: g.refY, y2: g.refY }));
  root.append(svg("path", { class: "eq-area", d: g.area }), svg("path", { class: "eq-line", d: g.line }));
  for (const frac of [0, .25, .5, .75, 1]) {
    const ts = g.x0 + (g.x1 - g.x0) * frac, lab = svg("text", { class: "axis", x: g.X(ts), y: H - 6, "text-anchor": frac === 0 ? "start" : frac === 1 ? "end" : "middle" });
    lab.textContent = clock(ts, g.x1 - g.x0 > 86400); root.append(lab);
  }
  const cross = svg("line", { class: "cross", x1: 0, x2: 0, y1: g.pad.t, y2: H - g.pad.b, visibility: "hidden" });
  const dot = svg("circle", { class: "dot", r: 4, visibility: "hidden" });
  const hit = svg("rect", { x: 0, y: 0, width: W, height: H, fill: "transparent" });
  root.append(cross, dot, hit);
  const tip = h("div", { class: "tip", hidden: true });
  hit.addEventListener("mousemove", (ev) => {
    const box = root.getBoundingClientRect(), x = ((ev.clientX - box.left) / box.width) * W;
    const ts = g.x0 + ((x - g.pad.l) / (W - g.pad.l - g.pad.r)) * (g.x1 - g.x0);
    const p = points[nearest(points, ts)], px = g.X(p.ts), py = g.Y(p.nav);
    cross.setAttribute("x1", px); cross.setAttribute("x2", px); cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", px); dot.setAttribute("cy", py); dot.setAttribute("visibility", "visible");
    tip.hidden = false; tip.textContent = `${clock(p.ts, true)} · ${money(p.nav, 2, false, symbol)}`;
    tip.style.left = `${(px / W) * 100}%`; tip.style.top = `${(py / H) * box.height}px`;
  });
  hit.addEventListener("mouseleave", () => { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); tip.hidden = true; });
  return h("div", { class: "chart" }, root, tip);
}

/* ---------------- views ---------------- */
function awaitingBlock(a) {
  const [title, body] = WAITING_TEXT[a.engine.state] || [a.engine.state, ""];
  const secret = a.engine.state === "awaiting_credentials" || a.engine.state === "auth_failed";
  return h("div", { class: "awaiting", id: `await-${a.id}` }, h("b", { text: title }), h("span", { text: body }),
    secret ? h("code", { text: CONNECT_CMD }) : null, a.engine.note ? h("span", { class: "fine", text: a.engine.note }) : null);
}

/** One account's card: value, the four numbers that matter, and its own running equity graph. */
function accountPanel(a, eq) {
  const ac = a.account, live = ac && !isWaiting(a.engine.state);
  const S = (x, dp = 2, sign = false) => money(x, dp, sign, a.symbol);
  const sel = a.id === state.acct;
  const title = [h("span", { class: "adot-t" }), h("span", { text: a.label }), h("span", { class: "spacer" }), enginePill(a.engine),
    h("button", { class: "ghost", "aria-pressed": String(sel), "data-pick": a.id, onclick: () => selectAcct(a.id) }, sel ? "Viewing" : "View")];
  const p = panel(title);
  p.className = `panel c${acctIndex(a.id)}${sel ? " sel" : ""}`;
  p.dataset.acct = a.id;
  if (!live) { p.append(awaitingBlock(a)); return p; }
  p.append(h("div", { class: "ahead" }, h("span", { class: "aval num", text: S(ac.nav, 2) }), h("span", { class: "acur", text: `${a.currency} · balance ${S(ac.balance, 2)}` })),
    h("div", { class: "kpis" },
      kpi("Today", S(ac.day_pnl, 2, true), pct(ac.day_pnl_pct), sgn(ac.day_pnl)),
      kpi("Since start", S(ac.since_start, 2, true), pct(ac.since_start_pct), sgn(ac.since_start)),
      kpi("Open P&L", S(ac.unrealized, 2, true), `${a.open_n} open`, sgn(ac.unrealized)),
      kpi("Margin used", S(ac.margin_used, 0), `drawdown ${pct(-ac.drawdown_pct, 2, false)}`, ac.drawdown_pct > 2 ? "neg" : "")),
    equityChart(eq ? eq.points : [], null, a.symbol, `${a.label} account value`));
  return p;
}

async function viewOverview() {
  const accts = state.accounts, cur_ = acctInfo();
  const eqs = await Promise.all(accts.map((a) => (a.account && !isWaiting(a.engine.state) ? api(`/v1/equity?hours=${state.hours}`, a.id).catch(() => null) : null)));
  setEnginePill(cur_.engine);
  const rangeBtns = h("div", { class: "seg" }, [[6, "6h"], [24, "24h"], [168, "7d"], [720, "30d"]].map(([hrs, label]) =>
    h("button", { "aria-pressed": String(state.hours === hrs), onclick: () => { state.hours = hrs; refresh(); } }, label)));
  const out = [h("div", { class: "toolrow" }, h("span", { class: "fine", text: "Both accounts · graph range" }), rangeBtns),
    h("div", { class: "grid even", id: "accounts" }, accts.map((a, i) => accountPanel(a, eqs[i])))];
  if (!cur_.account || isWaiting(cur_.engine.state)) return out;                       // nothing more to show until the desk is live

  const [ov, ln, pos] = await Promise.all([api("/v1/overview"), api("/v1/learning").catch(() => null), api("/v1/positions").catch(() => ({ positions: [] }))]);
  setEnginePill(ov.engine);
  const s = ov.summary.overall;
  if (ln) out.push(learningStrip(ln, ov.engine));
  if (ov.engine.state !== "running") out.push(h("div", { class: `banner ${ov.engine.state === "down" ? "bad" : ""}`, role: "status", text: bannerText(ov.engine) }));
  out.push(h("div", { class: "grid split" },
    panel("Performance · " + cur_.label,
      h("dl", { class: "kv" },
        h("dt", { text: "Closed trades" }), h("dd", { class: "num", text: String(s.n) }),
        h("dt", { text: "Win rate" }), h("dd", { class: "num", text: s.n ? pct(s.win_rate * 100, 0, false) : "-" }),
        h("dt", { text: "Profit factor" }), h("dd", { class: "num", text: s.profit_factor ? num(s.profit_factor, 2) : "-" }),
        h("dt", { text: "Expectancy / trade" }), h("dd", { class: `num ${sgn(s.expectancy)}`, text: s.n ? cur(s.expectancy, 2, true) : "-" }),
        h("dt", { text: "Avg win / loss" }), h("dd", { class: "num", text: s.n ? `${cur(s.avg_win, 0, true)} / ${cur(s.avg_loss, 0)}` : "-" }),
        h("dt", { text: "Realised P&L" }), h("dd", { class: `num ${sgn(s.pnl)}`, text: s.n ? cur(s.pnl, 2, true) : "-" }))),
    positionsPanel(pos.positions, true)));
  out.push(modelPanel(ov.model_skill, ov.engine));
  out.push(h("div", { class: "grid even" }, edgePanel(ov.edge), breakdown("By close reason", ov.summary.by_reason)));
  return out;
}
function learningStrip(ln, eng) {
  const last = ln.runs[0], hl = learningHeadline(ln);
  const goTo = () => selectTab("learning");
  return h("button", { class: `strip ${hl.cls}`, id: "learn-strip", onclick: goTo, "aria-label": "Open the Learning tab" },
    h("span", { class: "strip-dot" }),
    h("span", { class: "strip-main", text: hl.text.split(":")[0] }),
    h("span", { class: "strip-item" }, h("b", { class: "num", text: num(ln.samples.labelled, 0) }), " outcomes learned from"),
    h("span", { class: "strip-item" }, "model ", h("b", { text: trunc(ln.model_id || "stock", 24) })),
    h("span", { class: "strip-item" }, last ? `last learner run ${ago(last.ts)} (${last.action})` : "no learner run yet"),
    h("span", { class: "strip-item" }, `${num(ln.decisions_per_min, 1)} decisions/min`),
    h("span", { class: "spacer" }), h("span", { class: "strip-go", text: "Learning ›" }));
}
function bannerText(e) {
  return { down: "The trading engine is not reporting. Positions keep their server-side stop-loss and take-profit.", paused: "Entries are paused (open positions are still managed).",
    halted: "Drawdown halt: no new entries until resumed from Telegram.", kill_switch: "Kill switch file present: no new entries.", model_unhealthy: "Decision model unavailable: entries suspended until it recovers." }[e.state] || e.state;
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
function modelPanel(ms, eng) {
  const trusted = (eng && eng.trusted_questions) || [];
  const live = trusted.length > 0;
  const rows = Object.entries(ms.questions).map(([k, q]) => h("tr", {}, h("td", { text: k.replace("win_", "").replace("_", " ").toLowerCase() }), num_td(String(q.n)),
    num_td(q.auc ? num(q.auc, 3) : "-", q.auc ? (q.auc >= 0.54 ? "pos" : q.auc <= 0.46 ? "neg" : "") : ""), num_td(num(q.mean_r, 2), sgn(q.mean_r)),
    num_td(q.quintile_mean_r ? q.quintile_mean_r.map((x) => (x >= 0 ? "+" : "") + num(x, 2)).join(" ") : "-"),
    h("td", {}, pill(trusted.includes(k) ? "good" : "muted", trusted.includes(k) ? "trades" : "shadow"))));
  return panel("Does the decision model have skill?",
    h("div", { class: `verdict ${live ? "good" : "muted"}`, text: live ? `LIVE on ${trusted.length} validated question(s)` : (eng && eng.explore ? "EXPLORING: nothing validated yet, so only smallest-size trades where the calibrated edge clears the bar" : "SHADOW: scoring and measuring, no trades until validated") }),
    h("p", { class: "fine", text: `${ms.verdict}. ${num(ms.labelled, 0)} outcomes labelled, ${num(ms.pending, 0)} pending.` }),
    table([["Question"], ["N", 1], ["AUC", 1], ["Mean R", 1], ["R by raw-prob quintile", 1], ["Status"]], rows, "Waiting for labelled outcomes…"),
    h("p", { class: "fine", text: "Laya answers: will this trade hit its target before its stop? AUC 0.5 = no skill. Quintile R should rise from left to right if the probabilities mean anything." }));
}
function breakdown(title, groups) {
  const rows = Object.entries(groups).sort((a, b) => b[1].pnl - a[1].pnl).map(([k, v]) => h("tr", {}, h("td", { text: k }), num_td(String(v.n)), num_td(pct(v.win_rate * 100, 0, false)), num_td(cur(v.pnl, 0, true), sgn(v.pnl))));
  return panel(title, table([["Group"], ["N", 1], ["Win", 1], ["P&L", 1]], rows, "No closed trades yet."));
}

function positionsPanel(list, compact = false) {
  const units = isShares() ? "Shares" : "Units";
  const rows = list.map((p) => {
    const frac = Math.max(0, Math.min(1, (p.r_now + 1) / 3));
    const bar = h("span", { class: "bar rbar" }, h("b", { class: p.r_now < 0 ? "neg" : "" }));
    bar.firstChild.style.width = `${frac * 100}%`;
    const cells = [h("td", {}, span("side " + p.side, p.side.toUpperCase()), " ", tickerName(p.instrument)), num_td(num(p.units, 0))];
    if (!compact) cells.push(h("td", { text: p.playbook || "-" }));
    cells.push(num_td(String(p.entry)), num_td(String(p.sl ?? "-")), num_td(String(p.tp ?? "-")),
      h("td", { class: "r" }, bar, " ", span(`num ${sgn(p.r_now)}`, `${p.r_now >= 0 ? "+" : ""}${num(p.r_now, 2)}R`)), num_td(cur(p.unrealized, 2, true), sgn(p.unrealized)));
    if (!compact) cells.push(num_td(`${dur(p.held_min)} / ${dur(p.max_hold_min)}`));
    return h("tr", {}, cells);
  });
  const heads = [["Instrument"], [units, 1], ...(compact ? [] : [["Playbook"]]), ["Entry", 1], ["Stop", 1], ["Target", 1], ["P&L (R)", 1], ["Unrealised", 1], ...(compact ? [] : [["Held / max", 1]])];
  return panel(`Open positions (${list.length})`, table(heads, rows, "No open positions."));
}
async function viewPositions() {
  const [d, ov] = await Promise.all([api("/v1/positions"), api("/v1/overview")]);
  setEnginePill(ov.engine);
  return [positionsPanel(d.positions)];
}

async function viewTrades() {
  const off = state.pages.trades || 0;
  const d = await api(`/v1/trades?state=closed&limit=${50 + off}&offset=0`);
  const rows = d.trades.map((t) => h("tr", {}, h("td", { class: "num", text: clock(t.closed_at, true) }), h("td", {}, span("side " + t.side, t.side.toUpperCase()), " ", tickerName(t.instrument)),
    h("td", { text: t.playbook || "-" }), num_td(num(t.units, 0)), num_td(String(t.entry)), num_td(String(t.exit ?? "-")), num_td(cur(t.pnl, 2, true), sgn(t.pnl)),
    h("td", {}, pill(t.close_reason === "TP" ? "good" : t.close_reason === "SL" ? "bad" : "muted", t.close_reason || "-")),
    num_td(`${num(t.mfe_r || 0, 1)} / ${num(t.mae_r || 0, 1)}`), h("td", { class: "why", text: trunc(t.why, 90) })));
  const out = [panel(`Closed trades (${d.total})`, table([["Closed"], ["Trade"], ["Playbook"], [isShares() ? "Shares" : "Units", 1], ["Entry", 1], ["Exit", 1], ["P&L", 1], ["Reason"], ["MFE/MAE R", 1], ["Model's reason"]], rows, "No closed trades yet."))];
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
      h("td", { class: "num", text: clock(x.ts, true) }), h("td", { text: tickerName(x.instrument) }), h("td", { text: x.kind }),
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
  setEnginePill(ov.engine);
  const rows = d.instruments.sort((a, b) => b.interest - a.interest).map((m) => {
    const bar = h("span", { class: "bar" }, h("b")); bar.firstChild.style.width = `${Math.min(100, m.interest)}%`;
    return h("tr", {}, h("td", {}, tickerName(m.instrument), h("div", { class: "fine", text: `${m.class || ""}${m.open === null || m.open === undefined ? "" : m.open ? " · open" : " · closed"}` })), num_td(price(m.price, m.dp)), h("td", {}, bar, " ", span("num muted", num(m.interest, 0))),
      h("td", {}, arrow(m.trend.M5), arrow(m.trend.H1), arrow(m.trend.D)), num_td(`${num(m.rsi.M5, 0)} / ${num(m.rsi.H1, 0)}`),
      num_td(pct(m.chg["1h"], 2), sgn(m.chg["1h"])), num_td(pct(m.chg["1d"], 2), sgn(m.chg["1d"])), num_td(num(m.spread_pips, 1)), h("td", {}, (m.tags || []).map((t) => span("chip", t))),
      h("td", { class: "why" }, m.last_look ? [pill(OUTCOME_CLASS[m.last_look.outcome] || "muted", m.last_look.action || m.last_look.outcome || "-"), " ", span("fine", `${ago(m.last_look.ts)} · ${trunc(m.last_look.why, 70)}`)] : span("fine", "not yet scored")));
  });
  return [panel("Market scanner", table([["Instrument"], ["Price", 1], ["Interest"], ["M5 H1 D"], ["RSI M5/H1", 1], ["1h", 1], ["1d", 1], [isShares() ? "Spread (¢)" : "Spread (p)", 1], ["Signals"], ["Model's last look"]], rows, "Waiting for the first scan…"),
    h("p", { class: "fine", text: "Interest is a deterministic 0-100 score that decides which instruments the decision model gets to score." }))];
}

const qname = (k) => k.replace("win_", "").replace("_", " ").toLowerCase();

function curveChart(q, minEv) {
  const W = 420, H = 210, g = stepGeometry(q.edges, q.values, W, H, minEv);
  if (!g) return h("div", { class: "empty", text: "No curve yet." });
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Expected R by raw probability" });
  const label = (x, y, text, anchor = "middle") => { const el = svg("text", { class: "axis", x, y, "text-anchor": anchor }); el.textContent = text; return el; };
  for (const t of g.yticks) { root.append(svg("line", { class: "grid-line", x1: g.pad.l, x2: W - g.pad.r, y1: t.y, y2: t.y }), label(g.pad.l - 6, t.y + 4, (t.v >= 0 ? "+" : "") + num(t.v, 2), "end")); }
  root.append(svg("line", { class: "zero-line", x1: g.pad.l, x2: W - g.pad.r, y1: g.zeroY, y2: g.zeroY }));
  if (minEv > 0) root.append(svg("line", { class: "ref", x1: g.pad.l, x2: W - g.pad.r, y1: g.evY, y2: g.evY }), label(W - g.pad.r, g.evY - 4, `bar +${num(minEv, 2)}R`, "end"));
  for (const s of g.segments) {
    const ok = s.v >= minEv && minEv > 0, kind = ok ? "pos" : s.v >= 0 ? "mid" : "neg";
    const bar = svg("rect", { class: `f-${kind}`, x: s.x1, width: Math.max(0, s.x2 - s.x1), y: Math.min(s.y, g.zeroY), height: Math.abs(s.y - g.zeroY) });
    root.append(bar, svg("line", { class: `s-${kind}`, x1: s.x1, x2: s.x2, y1: s.y, y2: s.y, "stroke-width": 2.5 }));
  }
  for (const t of g.ticks) root.append(label(t.x, H - 8, num(t.p, 2)));
  return h("div", { class: "chart" }, root);
}
function aucChart(items) {
  const W = 420, H = 180, g = aucBars(items, W, H);
  if (!g) return h("div", { class: "empty", text: "Needs a day with 100+ labelled outcomes." });
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Daily AUC" });
  const label = (x, y, text, anchor = "middle") => { const el = svg("text", { class: "axis", x, y, "text-anchor": anchor }); el.textContent = text; return el; };
  root.append(svg("line", { class: "ref", x1: g.pad.l, x2: W - g.pad.r, y1: g.refY, y2: g.refY }), label(g.pad.l - 6, g.refY + 4, "0.50", "end"));
  for (const b of g.bars) {
    root.append(svg("rect", { class: b.above ? (b.auc >= 0.54 ? "c-pos" : "c-mid") : "c-neg", x: b.x, y: b.y, width: b.w, height: b.h }),
      label(b.cx, b.above ? b.y - 4 : b.y + b.h + 12, num(b.auc, 3)), label(b.cx, H - 8, clock(b.day, true).slice(0, 6)));
  }
  return h("div", { class: "chart" }, root);
}
function meter(label, have, need, note) {
  const f = progress(have, need), bar = h("span", { class: "meter" }, h("b"));
  bar.firstChild.style.width = `${f * 100}%`;
  return h("div", { class: "meter-row" }, h("div", { class: "meter-head" }, h("span", { text: label }), h("span", { class: "num muted", text: `${num(have, 0)} / ${num(need, 0)}` })), bar, note ? h("div", { class: "fine", text: note }) : null);
}
const RUN_CLASS = { promoted: "good", adopted: "good", refreshed: "muted", collecting: "muted", demoted: "warn", rejected: "warn", failed: "bad", skipped: "muted" };

async function viewLearning() {
  const [d, ov] = await Promise.all([api("/v1/learning"), api("/v1/overview")]);
  setEnginePill(ov.engine);
  const hl = learningHeadline(d), cal = d.calibration, S = d.settings, last = d.runs[0];
  const aucs = Object.values(ov.model_skill.questions || {}).map((q) => q.auc).filter((x) => x);
  const meanAuc = aucs.length ? aucs.reduce((a, b) => a + b, 0) / aucs.length : null;
  const trusted = cal && cal.questions ? Object.values(cal.questions).filter((q) => q.trusted).length : 0;
  const out = [h("div", { class: `verdict ${hl.cls}`, id: "learn-verdict", text: hl.text }),
    h("div", { class: "kpis" },
      kpi("Model in use", trunc(d.model_id || "stock", 22), cal && cal.created ? `calibrated ${cal.created.slice(0, 16).replace("T", " ")}` : "no calibration"),
      kpi("Outcomes learned", num(d.samples.labelled, 0), `${num(d.samples.pending, 0)} still maturing`),
      kpi("Live skill (AUC)", meanAuc === null ? "-" : num(meanAuc, 3), meanAuc === null ? "needs 100+ per question" : meanAuc >= 0.54 ? "some skill" : meanAuc > 0.46 ? "indistinguishable from chance" : "inverted", meanAuc === null ? "" : meanAuc >= 0.54 ? "pos" : meanAuc <= 0.46 ? "neg" : ""),
      kpi("Trusted questions", String(trusted), `${Object.keys((cal && cal.questions) || {}).length} measured`),
      kpi("Last learner run", last ? ago(last.ts) : "-", last ? `${last.kind}: ${last.action}` : "none yet"))];
  const next = Math.max(0, S.retrain_min_new_states - d.samples.new_since_retrain);
  out.push(h("div", { class: "grid even" },
    panel("Learning progress",
      meter("Outcomes before first calibration", d.samples.labelled, S.learn_min_rows, "The online learner fits a calibration once enough outcomes exist."),
      meter("New labelled scans toward the next nightly retrain", d.samples.new_since_retrain, S.retrain_min_new_states, next ? `${num(next, 0)} more needed. Retraining is tried at 03:30 and skipped if memory is tight.` : "Enough new data: the next 03:30 run will attempt a retrain."),
      h("p", { class: "fine", text: `Last retrain: ${d.samples.last_retrain_ts ? ago(d.samples.last_retrain_ts) : "never"}. The online learner re-checks every ${S.learn_interval_min} min.` })),
    panel("The safety rules it cannot override",
      h("ul", { class: "rules" },
        h("li", { text: `A question trades at full size only if, on data it has never seen, it picks at least ${S.learn_min_selected} options with mean R above zero and t ≥ ${S.learn_min_t}.` }),
        h("li", { text: `Trust is withdrawn when fresh data stops confirming it (fewer than ${S.demote_min_n} picks, or mean R ≤ ${S.demote_mean_r}).` }),
        h("li", { text: "A new model replaces the old one only if it measurably beats it on held-out data. Otherwise the old one stays." }),
        h("li", { text: `Until something is trusted, only smallest-size exploration trades run, and only where expected R clears +${S.min_ev_r}.` })))));
  const qs = Object.entries((cal && cal.questions) || {});
  if (qs.length) out.push(h("div", { class: "grid even" }, qs.map(([k, q]) => panel([h("span", { text: `${qname(k)}: what the probability is worth` }), h("span", { class: "spacer" }), pill(q.trusted ? "good" : "muted", q.trusted ? "trades" : "shadow")],
    curveChart(q, cal.min_ev_r || S.min_ev_r),
    h("p", { class: "fine num", text: `Raw P(win) → expected R after spread. Held-out AUC ${q.auc === null || q.auc === undefined ? "-" : num(q.auc, 3)} · ${q.selected_n || 0} picks above the bar${q.selected_mean_r === null || q.selected_mean_r === undefined ? "" : ` · mean ${num(q.selected_mean_r, 2)}R (t=${num(q.selected_t, 1)})`}.` })))));
  const dq = Object.entries(d.daily_auc || {});
  out.push(panel("Is it getting better? Daily AUC of live predictions (0.50 = coin flip)", dq.length ? h("div", { class: "grid even" }, dq.map(([k, items]) => h("div", {}, h("div", { class: "fine", text: qname(k) }), aucChart(items)))) : h("div", { class: "empty", text: "Daily AUC appears once a day has 100+ labelled outcomes for a question." })));
  const runs = d.runs.map((r) => h("tr", {}, h("td", { class: "num", text: clock(r.ts, true) }), h("td", { text: r.kind }), h("td", {}, pill(RUN_CLASS[r.action] || "muted", r.action)),
    num_td(r.rows === null || r.rows === undefined ? "-" : num(r.rows, 0)), h("td", { text: trunc(r.model_id, 22) }), h("td", { class: "why", text: r.reason || (r.trusted.length ? `trusted: ${r.trusted.map(qname).join(", ")}` : "") })));
  out.push(panel("Learning log", table([["When"], ["Kind"], ["Result"], ["Rows", 1], ["Model"], ["Detail"]], runs, "No learner runs yet - it starts once the engine has been up for a few minutes."),
    h("p", { class: "fine", text: "online = refit of the calibration on live outcomes (every 30 min). retrain = nightly fine-tune of a challenger model, promoted only if it earns trust on held-out data." })));
  return out;
}

async function viewSystem() {
  const [s, ov] = await Promise.all([api("/v1/system"), api("/v1/overview")]);
  setEnginePill(ov.engine);
  const e = s.engine || {}, L = s.limits;
  const ev = s.events.map((x) => h("tr", {}, h("td", { class: "num", text: clock(x.ts, true) }), h("td", {}, pill(x.level === "info" ? "muted" : x.level === "warn" ? "warn" : "bad", x.level)), h("td", { text: x.kind }), h("td", { class: "why", text: x.msg })));
  return [h("div", { class: "grid three" },
    panel("Engine", h("dl", { class: "kv" },
      h("dt", { text: "State" }), h("dd", {}, pill(ov.engine.state === "running" ? "good" : "warn", ov.engine.state, true)),
      h("dt", { text: "Heartbeat" }), h("dd", { class: "num", text: ov.engine.age_s === null ? "-" : `${ov.engine.age_s}s ago` }),
      h("dt", { text: "Model" }), h("dd", { text: e.model || "-" }), h("dt", { text: "Started" }), h("dd", { text: ago(e.started_at) }),
      h("dt", { text: "Instruments" }), h("dd", { class: "num", text: String(e.instruments ?? "-") }), h("dt", { text: "Price updates" }), h("dd", { class: "num", text: num(e.stream_msgs ?? 0, 0) }),
      h("dt", { text: "Queue" }), h("dd", { class: "num", text: String(e.queue ?? "-") }), h("dt", { text: "Database" }), h("dd", { class: "num", text: `${num(s.db_bytes / 1048576, 1)} MB` }))),
    panel("Decision model (Laya, local)", h("dl", { class: "kv" },
      h("dt", { text: "Latency p50" }), h("dd", { class: "num", text: s.model.p50_ms ? `${s.model.p50_ms} ms` : "-" }), h("dt", { text: "Latency p95" }), h("dd", { class: "num", text: s.model.p95_ms ? `${s.model.p95_ms} ms` : "-" }),
      h("dt", { text: "Validated questions" }), h("dd", { class: "num", text: String((e.trusted_questions || []).length) }), h("dt", { text: "Calibrated" }), h("dd", { class: "num", text: e.calibrated_at || "never" }),
      h("dt", { text: "Consecutive failures" }), h("dd", { class: "num", text: String(e.model_failures ?? 0) }),
      Object.entries(s.outcomes_24h).map(([k, v]) => [h("dt", { text: `${k} (24h)` }), h("dd", { class: "num", text: String(v) })]))),
    panel("Guardrails (enforced by code)", h("dl", { class: "kv" },
      h("dt", { text: "Risk per trade (tiers)" }), h("dd", { class: "num", text: Object.values(L.risk_pct_tiers).map((x) => `${x}%`).join(" / ") }),
      h("dt", { text: "Max open positions" }), h("dd", { class: "num", text: String(L.max_open) }), h("dt", { text: "Max total risk" }), h("dd", { class: "num", text: `${L.max_total_risk_pct}% NAV` }),
      h("dt", { text: "Daily loss limit" }), h("dd", { class: "num", text: `${L.daily_loss_pct}%` }), h("dt", { text: "Drawdown halt" }), h("dd", { class: "num", text: `${L.drawdown_halt_pct}%` }),
      h("dt", { text: "Entries / hour" }), h("dd", { class: "num", text: String(L.entries_per_hour) })))),
  panel("Recent events", table([["Time"], ["Level"], ["Kind"], ["Message"]], ev, "No events."))];
}

const VIEWS = { overview: viewOverview, positions: viewPositions, trades: viewTrades, decisions: viewDecisions, market: viewMarket, learning: viewLearning, system: viewSystem };

/* ---------------- boot ---------------- */
wireGate();
if (state.token) startApp();
