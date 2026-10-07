// Paper Desk - static, read-only dashboard. SECURITY: every dynamic value is rendered with textContent / createTextNode.
// There is no innerHTML anywhere; the CSP additionally forbids inline script/style and third-party origins.
import { choiceName, questionName, learnReasonText, styleName, sideName, decisionType, outcomeText, closeReasonText, rejectText, tagText, className, eventText, runKindText, runActionText, engineMode, whyText, edgeVerdictText, skillVerdictText } from "./plain.js";
import { deriveToken, money, pct, num, sgn, price, trunc, ago, dur, clock, chartGeometry, nearest, stepGeometry, aucBars, progress, learningHeadline, exchangeStatus, shortName, isWaiting, WAITING_TEXT, CONNECT_CMD, OUTCOME_CLASS, untilText, sessionLine, dayLabel, bestAndWorst } from "./lib.js";

const API = (window.PAPERDESK && window.PAPERDESK.api) || "";
let OPEN = !!(window.PAPERDESK && window.PAPERDESK.open === true);        // paper-only deploy: the read-only API needs no passphrase (falls back to the gate if it answers 401)
const REFRESH_MS = 5000;
const TAPE_MS = 15000;
const SVGNS = "http://www.w3.org/2000/svg";
const store = window.sessionStorage;           // per-tab session storage: cleared when the tab closes

const CLASSES = [["all", "All"], ["fx", "FX"], ["index", "Indices"], ["metal", "Metals"], ["energy", "Energy"], ["bond", "Bonds"]];
const CLASSED = ["/v1/overview", "/v1/positions", "/v1/trades", "/v1/decisions", "/v1/market", "/v1/learning"];
const state = { token: OPEN ? "open" : store.getItem("pd.token") || "", tab: "overview", cls: store.getItem("pd.cls") || "all", acct: store.getItem("pd.acct") || "both", accounts: [], hours: 24,
  timer: null, busy: false, pages: {}, open: new Set(), details: {}, tapeAt: 0, tapeKey: "" };

/* ---------------- accounts (one per broker desk) ---------------- */
// state.acct is "both" (every desk, one section each) or a single desk id. Drawing code never reads state.acct directly: it asks for the
// desk being drawn (set by inDesk), so two desks can be drawn one after the other without mixing currencies or instrument names.
let viewDesk = "";
const deskId = () => viewDesk || (state.acct !== "both" ? state.acct : (state.accounts[0] || {}).id) || "";
const acctInfo = (id = deskId()) => state.accounts.find((a) => a.id === id) || null;
const acctIndex = (id) => Math.max(0, state.accounts.findIndex((a) => a.id === id));
const sym = (id = deskId()) => (acctInfo(id) || {}).symbol || "£";
const cur = (x, dp = 0, sign = false, id = deskId()) => money(x, dp, sign, sym(id));
const isShares = () => (acctInfo() || {}).broker === "alpaca";
const scope = () => (state.acct === "both" ? state.accounts : state.accounts.filter((a) => a.id === state.acct));
const both = () => scope().length > 1;
const effClass = (id) => ((acctInfo(id) || {}).broker === "oanda" ? state.cls : "all");
function inDesk(id, fn) {                                                     // synchronous drawing only: the desk is restored before anything else runs
  const prev = viewDesk;
  viewDesk = id;
  try { return fn(); } finally { viewDesk = prev; }
}

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
    const acct = account || deskId();
    if (acct) params.push("account=" + encodeURIComponent(acct));
    const cls = effClass(acct);
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
  const bothBtn = state.accounts.length > 1 ? [h("button", { class: "acct both", "data-acct": "both", "aria-pressed": String(state.acct === "both"), onclick: () => selectAcct("both"), title: "Show every desk" },
    h("span", { class: "adot" }), h("span", { class: "name", text: "Both desks" }), h("span", { class: "val sm", text: "side by side" }))] : [];
  box.replaceChildren(...bothBtn, ...state.accounts.map((a, i) => {
    const ac = a.account, waiting = isWaiting(a.engine.state) || !ac;
    const name = [shortName(a.label), ...String(a.label).split(" ").slice(1)].join(" ");
    return h("button", { class: `acct c${i}`, "data-acct": a.id, "aria-pressed": String(a.id === state.acct), onclick: () => selectAcct(a.id), title: a.label },
      h("span", { class: "adot" }), h("span", { class: "name", text: name }),
      waiting ? h("span", { class: "off", text: waitingShort(a.engine.state) })
        : h("span", { class: "val num" }, money(ac.nav, 2, false, a.symbol), h("span", { class: `chg ${sgn(ac.day_pnl)}`, text: pct(ac.day_pnl_pct, 2) })));
  }));
  const f = $("filters");
  if (f) f.hidden = !scope().some((a) => a.broker === "oanda");
}
const waitingShort = (s) => ({ awaiting_credentials: "awaiting secret key", auth_failed: "key rejected", unreachable: "broker unreachable", not_started: "not started" }[s] || s);
async function loadAccounts() {
  const d = await api("/v1/accounts");
  state.accounts = d.accounts;
  if (state.acct !== "both" && !acctInfo(state.acct)) { state.acct = "both"; store.setItem("pd.acct", state.acct); }
  if (state.accounts.length < 2 && state.acct === "both") state.acct = state.accounts[0] ? state.accounts[0].id : "both";
  renderAccounts();
  setPills();
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
    setPills();
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

/* watchlist tape: the most interesting instruments of the desk(s) in view, refreshed more slowly than the page */
async function refreshTape() {
  const list = scope().filter((a) => !isWaiting(a.engine.state)), key = `${state.acct}|${state.cls}`;
  if (!list.length || (Date.now() - state.tapeAt < TAPE_MS && state.tapeKey === key)) return;
  state.tapeAt = Date.now(); state.tapeKey = key;
  try {
    const per = list.length > 1 ? 8 : 14;
    const groups = await Promise.all(list.map(async (a) => {
      const d = await api("/v1/market", a.id);
      return inDesk(a.id, () => d.instruments.filter((m) => m.price !== null && m.price !== undefined).sort((x, y) => y.interest - x.interest).slice(0, per).map((m) =>
        h("div", { class: `tk c${acctIndex(a.id)}` }, h("b", { text: tickerName(m.instrument) }), h("span", { class: "tpx num", text: price(m.price, m.dp) }),
          h("span", { class: `num ${sgn(m.chg["1d"])}`, text: pct(m.chg["1d"], 2) }))));
    }));
    $("tape").replaceChildren(...groups.flat());
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
function enginePill(e, prefix = "") {
  const map = { running: ["good", "Live"], paused: ["warn", "Paused"], halted: ["bad", "Stopped (loss limit)"], kill_switch: ["bad", "Emergency stop"], model_unhealthy: ["warn", "Model offline"], down: ["bad", "Engine down"],
    awaiting_credentials: ["warn", "Awaiting key"], auth_failed: ["bad", "Key rejected"], unreachable: ["warn", "Unreachable"], not_started: ["muted", "Not started"] };
  let [cls, txt] = map[e.state] || ["muted", e.state];
  if (e.state === "running" && !(e.trusted_questions && e.trusted_questions.length)) [cls, txt] = ["warn", engineMode(false, e.explore)];   // nothing proven yet: smallest-size trial trades (explore) or none (watch only)
  return pill(cls, prefix ? `${prefix} · ${txt}` : txt, true);
}
function setPills() {                                                          // one status pill per desk in view (prefixed with its name when there are two)
  const el = $("engine-pill"), list = scope();
  if (el) el.replaceChildren(...list.map((a) => enginePill(a.engine, list.length > 1 ? shortName(a.label) : "")));
}
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
      kpi("Open profit/loss", S(ac.unrealized, 2, true), `${a.open_n} open`, sgn(ac.unrealized)),
      kpi("Margin in use", S(ac.margin_used, 0), `${pct(-ac.drawdown_pct, 2, false)} from peak`, ac.drawdown_pct > 2 ? "neg" : "")),
    equityChart(eq ? eq.points : [], null, a.symbol, `${a.label} account value`));
  return p;
}

/** One section per desk when two are shown (so every number sits under the name and currency it belongs to). */
function deskSection(a, nodes) {
  if (!both()) return nodes.filter(Boolean);
  return [h("section", { class: `desk c${acctIndex(a.id)}`, "data-desk": a.id },
    h("h2", { class: "deskhead" }, h("span", { class: "adot-t" }), h("span", { text: a.label }), h("span", { class: "fine", text: `${a.currency} · ${a.broker === "alpaca" ? "US shares, day trading" : "forex, indices, metals, energy"}` })),
    ...nodes.filter(Boolean))];
}
const instCell = (p) => h("td", {}, span("side " + p.side, (isShares() && p.side === "short" ? "Short" : sideName(p.side)).toUpperCase()), " ", tickerName(p.instrument), p.name ? h("div", { class: "fine", text: p.name }) : null);

async function viewOverview() {
  const accts = state.accounts;
  const eqs = await Promise.all(accts.map((a) => (a.account && !isWaiting(a.engine.state) ? api(`/v1/equity?hours=${state.hours}`, a.id).catch(() => null) : null)));
  const rangeBtns = h("div", { class: "seg" }, [[6, "6h"], [24, "24h"], [168, "7d"], [720, "30d"]].map(([hrs, label]) =>
    h("button", { "aria-pressed": String(state.hours === hrs), onclick: () => { state.hours = hrs; refresh(); } }, label)));
  const out = [h("div", { class: "toolrow" }, h("span", { class: "fine", text: "Both accounts · time range" }), rangeBtns),
    h("div", { class: "grid even", id: "accounts" }, accts.map((a, i) => accountPanel(a, eqs[i])))];
  const parts = await Promise.all(scope().map((a) => overviewDesk(a)));
  return [...out, ...parts.flat()];
}
async function overviewDesk(a) {
  if (!a.account || isWaiting(a.engine.state)) return [];                      // nothing more to show until the desk is live
  const [ov, ln, pos] = await Promise.all([api("/v1/overview", a.id), api("/v1/learning", a.id).catch(() => null), api("/v1/positions", a.id).catch(() => ({ positions: [], exposure: null }))]);
  return inDesk(a.id, () => deskSection(a, overviewBody(a, ov, ln, pos)));
}
function overviewBody(a, ov, ln, pos) {
  const s = ov.summary.overall, out = [];
  if (ln) out.push(learningStrip(ln, ov.engine, a));
  if (ov.engine.state !== "running") out.push(h("div", { class: `banner ${ov.engine.state === "down" ? "bad" : ""}`, role: "status", text: bannerText(ov.engine) }));
  out.push(h("div", { class: "grid split" },
    panel("Performance · " + a.label,
      h("dl", { class: "kv" },
        h("dt", { text: "Closed trades" }), h("dd", { class: "num", text: String(s.n) }),
        h("dt", { text: "Win rate" }), h("dd", { class: "num", text: s.n ? pct(s.win_rate * 100, 0, false) : "-" }),
        h("dt", { text: "Profit factor (wins ÷ losses)" }), h("dd", { class: "num", text: s.profit_factor ? num(s.profit_factor, 2) : "-" }),
        h("dt", { text: "Average per trade" }), h("dd", { class: `num ${sgn(s.expectancy)}`, text: s.n ? cur(s.expectancy, 2, true) : "-" }),
        h("dt", { text: "Average win / loss" }), h("dd", { class: "num", text: s.n ? `${cur(s.avg_win, 0, true)} / ${cur(s.avg_loss, 0)}` : "-" }),
        h("dt", { text: "Profit/loss on closed trades" }), h("dd", { class: `num ${sgn(s.pnl)}`, text: s.n ? cur(s.pnl, 2, true) : "-" }))),
    positionsPanel(pos.positions, true)));
  out.push(exposurePanel(pos.exposure));
  if (ov.market_clock || ov.broker) out.push(h("div", { class: "grid even" }, sessionPanel(ov, a), brokerPanel(ov, a)));
  out.push(resultsPanels(ov.results));
  out.push(modelPanel(ov.model_skill, ov.engine));
  out.push(h("div", { class: "grid even" }, edgePanel(ov.edge), breakdown("How trades ended", ov.summary.by_reason, closeReasonText)));
  out.push(h("div", { class: "grid even" }, breakdown("By kind of trade", ov.summary.by_playbook, styleName), breakdown(isShares() ? "By stock" : "By instrument", ov.summary.by_instrument, tickerName, 12)));
  return out;
}
function sessionPanel(ov, a) {
  const line = sessionLine(ov.market_clock, ov.ts);
  if (!line) return h("div");
  return panel("Stock market hours",
    h("div", { class: `verdict ${line.open ? "good" : "muted"}`, id: `session-${a.id}`, text: line.headline }), h("p", { class: "briefing", text: line.detail }),
    a.day_trading ? h("p", { class: "fine", text: `Day trading: every position is closed ${a.flatten_min} minutes before the close, so nothing is held overnight.${a.allow_short ? " Short selling (selling shares you do not own, to profit from a fall) is allowed." : ""}` }) : null);
}
function brokerPanel(ov, a) {
  const b = ov.broker, nav = ov.account ? ov.account.nav : 0;
  if (!b) return h("div");
  const row = (k, v, cls = "") => [h("dt", { text: k }), h("dd", { class: `num ${cls}`, text: v })];
  return panel("Broker account",
    h("dl", { class: "kv", id: `broker-${a.id}` },
      row("Account value", cur(nav, 2)), row("Cash", cur(b.cash, 2)),
      row("Buying power", `${cur(b.buyingPower, 0)} (${num(b.multiplier, 0)}x leverage)`),
      row("Shares held (bought)", cur(b.longMarketValue, 0)), row("Shares sold short", cur(Math.abs(b.shortMarketValue), 0)),
      row("Short selling", b.shortingEnabled ? "Allowed" : "Not allowed"),
      row("Day trades in the last 5 days", String(b.daytradeCount)),
      row("Flagged as pattern day trader", b.patternDayTrader ? "Yes" : "No", b.patternDayTrader ? "neg" : ""),
      row("Account status", b.tradingBlocked ? "Trading blocked" : String(b.status || "-").toLowerCase(), b.tradingBlocked ? "neg" : "")),
    h("p", { class: "fine", text: `US rules flag an account that makes more than 3 day trades in 5 trading days unless it holds over ${a.symbol}25,000.${nav >= 25000 ? " This account holds more, so the limit does not apply." : " This account is below that, so the limit applies."}` }));
}
function exposurePanel(ex) {
  if (!ex || !ex.n) return null;
  const k = [kpi("Open positions", String(ex.n), `${ex.n_long} bought · ${ex.n_short} sold short`)];
  if (ex.gross) {
    k.push(kpi("Money in the market", cur(ex.gross, 0), `${pct(ex.gross_pct, 1, false)} of the account`),
      kpi("Net direction", cur(ex.net, 0, true), ex.net >= 0 ? "more bought than sold short" : "more sold short than bought", sgn(ex.net)));
  }
  k.push(kpi("At risk if every stop-loss is hit", cur(ex.at_risk, 0), ex.at_risk_pct === null ? "" : `${pct(ex.at_risk_pct, 2, false)} of the account`));
  if (ex.largest) k.push(kpi("Biggest position", tickerName(ex.largest.instrument), `${num(ex.largest.weight_pct, 1)}% of the account`));
  return panel("How much is in the market", h("div", { class: "kpis", id: `exposure-${deskId()}` }, k));
}
function resultsPanels(res) {
  if (!res) return null;
  const sideRows = [["long", isShares() ? "Bought (expecting a rise)" : "Buys"], ["short", isShares() ? "Sold short (expecting a fall)" : "Sells"]].map(([k, label]) => {
    const v = res.by_side[k];
    return h("tr", {}, h("td", { text: label }), num_td(String(v.n)), num_td(v.n ? pct(v.win_rate * 100, 0, false) : "-"), num_td(v.n ? cur(v.pnl, 0, true) : "-", v.n ? sgn(v.pnl) : ""));
  });
  const dayRows = res.daily.map((d) => h("tr", {}, h("td", { text: dayLabel(d.day) }), num_td(String(d.n)), num_td(d.n ? pct(d.win_rate * 100, 0, false) : "-"), num_td(cur(d.pnl, 0, true), sgn(d.pnl))));
  return h("div", { class: "grid even" },
    panel("Buying versus short selling", table([["Direction"], ["Trades", 1], ["Won", 1], ["Profit/loss", 1]], sideRows, "No closed trades yet.")),
    panel("Results by day", table([["Day"], ["Trades", 1], ["Won", 1], ["Profit/loss", 1]], dayRows, "No closed trades yet.")));
}
function learningStrip(ln, eng, a) {
  const last = ln.runs[0], hl = learningHeadline(ln);
  const goTo = () => selectTab("learning");
  return h("button", { class: `strip ${hl.cls}`, id: `learn-strip-${a.id}`, onclick: goTo, "aria-label": "Open the Learning tab" },
    h("span", { class: "strip-dot" }),
    h("span", { class: "strip-main", text: hl.text.split(":")[0] }),
    h("span", { class: "strip-item" }, h("b", { class: "num", text: num(ln.samples.labelled, 0) }), " results learned from"),
    h("span", { class: "strip-item" }, "model ", h("b", { text: trunc(ln.model_id || "stock", 24) })),
    h("span", { class: "strip-item" }, last ? `last learning update ${ago(last.ts)} (${runActionText(last.action)})` : "no learning update yet"),
    h("span", { class: "strip-item" }, `${num(ln.decisions_per_min, 1)} decisions a minute`),
    h("span", { class: "spacer" }), h("span", { class: "strip-go", text: "Learning ›" }));
}
function bannerText(e) {
  return { down: "The trading engine is not reporting. Open positions keep their stop-loss and take-profit at the broker.", paused: "New trades are paused (open positions are still looked after).",
    halted: "Trading stopped because losses hit the limit. No new trades until it is resumed from Telegram.", kill_switch: "Emergency stop is on: no new trades.", model_unhealthy: "The decision model is offline: no new trades until it recovers." }[e.state] || e.state;
}
function edgePanel(edge) {
  const v = edge.verdict, cls = v.startsWith("positive") ? "good" : v.includes("NEGATIVE") ? "bad" : "muted";
  const rows = [["5 min", "fwd5"], ["15 min", "fwd15"], ["60 min", "fwd60"]].map(([label, k]) => {
    const x = edge.horizons[k] || { n: 0 };
    return h("tr", {}, h("td", { text: label }), num_td(String(x.n)), num_td(x.n ? num(x.mean_atr, 2) : "-", x.n ? sgn(x.mean_atr) : ""), num_td(x.n ? `${num(x.ci_low, 2)} … ${num(x.ci_high, 2)}` : "-"), num_td(x.n ? pct(x.hit_rate * 100, 0, false) : "-"));
  });
  return panel("Is the model adding value?", h("div", { class: `verdict ${cls}`, text: edgeVerdictText(v) }),
    table([["Time after pick"], ["Picks", 1], ["Average move", 1], ["Likely range", 1], ["Right direction", 1]], rows),
    h("p", { class: "fine", text: "How far the price moved after each buy or sell pick, after trading costs, measured in typical 5-minute price swings (so it compares fairly across markets). Skipped ideas are not counted. Making money is not by itself proof of skill, so this checks it is more than luck." }));
}
function modelPanel(ms, eng) {
  const trusted = (eng && eng.trusted_questions) || [];
  const live = trusted.length > 0;
  const rows = Object.entries(ms.questions).map(([k, q]) => h("tr", {}, h("td", { text: questionName(k) }), num_td(String(q.n)),
    num_td(q.auc ? num(q.auc, 3) : "-", q.auc ? (q.auc >= 0.54 ? "pos" : q.auc <= 0.46 ? "neg" : "") : ""), num_td(num(q.mean_r, 2), sgn(q.mean_r)),
    num_td(q.quintile_mean_r ? q.quintile_mean_r.map((x) => (x >= 0 ? "+" : "") + num(x, 2)).join(" ") : "-"),
    h("td", {}, pill(trusted.includes(k) ? "good" : "muted", trusted.includes(k) ? "trades" : "trial only"))));
  return panel("Is the model any good at predicting?",
    h("div", { class: `verdict ${live ? "good" : "muted"}`, text: live ? `Live: ${trusted.length} kind(s) of trade proven, trading at full size` : (eng && eng.explore ? "Trial mode: nothing is proven yet, so only smallest-size trial trades run" : "Watch only: scoring and measuring, no trades until it is proven") }),
    h("p", { class: "fine", text: `${skillVerdictText(ms.verdict)} ${num(ms.labelled, 0)} results recorded, ${num(ms.pending, 0)} still waiting to play out.` }),
    table([["Kind of trade"], ["Samples", 1], ["Accuracy score", 1], ["Average result (R)", 1], ["Result, least to most confident", 1], ["Status"]], rows, "Waiting for results…"),
    h("p", { class: "fine", text: "For every possible trade the model estimates the chance it reaches its target before its stop. Accuracy score: 0.5 is a coin flip and 1.0 is perfect. R means multiples of the amount risked (+1R = a profit equal to the risk). The five numbers split the model's guesses from least to most confident; if its confidence means anything they should rise from left to right." }));
}
function breakdown(title, groups, label = (k) => k, max = 0) {
  const sorted = Object.entries(groups).sort((x, y) => y[1].pnl - x[1].pnl), cut = max ? bestAndWorst(sorted, max / 2, max / 2) : { shown: sorted, hidden: 0 };
  const rows = cut.shown.map(([k, v]) => h("tr", {}, h("td", { text: label(k) }), num_td(String(v.n)), num_td(pct(v.win_rate * 100, 0, false)), num_td(cur(v.pnl, 0, true), sgn(v.pnl))));
  return panel(title, table([["Group"], ["Trades", 1], ["Won", 1], ["Profit/loss", 1]], rows, "No closed trades yet."),
    cut.hidden ? h("p", { class: "fine", text: `Showing the best and worst; ${cut.hidden} more in between.` }) : null);
}

function positionsPanel(list, compact = false) {
  const sh = isShares(), units = sh ? "Shares" : "Units";
  const rows = list.map((p) => {
    const frac = Math.max(0, Math.min(1, (p.r_now + 1) / 3));
    const bar = h("span", { class: "bar rbar" }, h("b", { class: p.r_now < 0 ? "neg" : "" }));
    bar.firstChild.style.width = `${frac * 100}%`;
    const cells = [instCell(p)];
    if (!compact) cells.push(h("td", { text: styleName(p.playbook) }));
    cells.push(num_td(num(p.units, 0)), num_td(String(p.entry)), num_td(p.price === null || p.price === undefined ? "-" : String(p.price)));
    if (sh && !compact) cells.push(num_td(p.move_pct === null || p.move_pct === undefined ? "-" : pct(p.move_pct, 2), sgn(p.move_pct)), num_td(p.notional ? cur(p.notional, 0) : "-"), num_td(p.weight_pct === null || p.weight_pct === undefined ? "-" : pct(p.weight_pct, 1, false)));
    if (!compact) cells.push(num_td(String(p.sl ?? "-")), num_td(String(p.tp ?? "-")));
    cells.push(h("td", { class: "r" }, bar, " ", span(`num ${sgn(p.r_now)}`, `${p.r_now >= 0 ? "+" : ""}${num(p.r_now, 2)}R`)), num_td(cur(p.unrealized, 2, true), sgn(p.unrealized)));
    if (!compact) cells.push(num_td(`${dur(p.held_min)} / ${dur(p.max_hold_min)}`));
    return h("tr", {}, cells);
  });
  const heads = [["Instrument"], ...(compact ? [] : [["Style"]]), [units, 1], ["Entry", 1], ["Now", 1], ...(sh && !compact ? [["Move", 1], ["Value", 1], ["% of account", 1]] : []),
    ...(compact ? [] : [["Stop-loss", 1], ["Target", 1]]), ["Progress (R)", 1], ["Profit/loss now", 1], ...(compact ? [] : [["Held / limit", 1]])];
  return panel(`Open positions (${list.length})`, table(heads, rows, "No open positions."), compact ? null : h("p", { class: "fine", text: `Progress is in R, multiples of the amount risked: +1R is a profit equal to what was risked, and -1R means the stop-loss is about to be hit. A trade is closed at its limit if it has not reached the stop or target by then.${sh ? " Value is shares × current price; % of account is that value against the whole account." : ""}` }));
}
async function viewPositions() {
  const parts = await Promise.all(scope().map(async (a) => {
    const d = await api("/v1/positions", a.id);
    return inDesk(a.id, () => deskSection(a, [positionsPanel(d.positions), exposurePanel(d.exposure)]));
  }));
  return parts.flat();
}

async function viewTrades() {
  const parts = await Promise.all(scope().map(async (a) => {
    const key = `trades:${a.id}`, off = state.pages[key] || 0;
    const d = await api(`/v1/trades?state=closed&limit=${50 + off}&offset=0`, a.id);
    return inDesk(a.id, () => deskSection(a, tradesBody(d, key, off)));
  }));
  return parts.flat();
}
function tradesBody(d, key, off) {
  const sh = isShares();
  const rows = d.trades.map((t) => h("tr", {}, h("td", { class: "num", text: clock(t.closed_at, true) }), instCell(t),
    h("td", { text: styleName(t.playbook) }), num_td(num(t.units, 0)), num_td(String(t.entry)), num_td(String(t.exit ?? "-")),
    ...(sh ? [num_td(t.notional ? cur(t.notional, 0) : "-")] : []),
    num_td(cur(t.pnl, 2, true), sgn(t.pnl)), ...(sh ? [num_td(t.pnl_pct === null || t.pnl_pct === undefined ? "-" : pct(t.pnl_pct, 2), sgn(t.pnl_pct))] : []),
    num_td(t.r_multiple === null || t.r_multiple === undefined ? "-" : `${t.r_multiple >= 0 ? "+" : ""}${num(t.r_multiple, 1)}R`, sgn(t.r_multiple)), num_td(dur(t.held_min)),
    h("td", {}, pill(t.close_reason === "TP" ? "good" : t.close_reason === "SL" ? "bad" : "muted", closeReasonText(t.close_reason))),
    num_td(`${num(t.mfe_r || 0, 1)} / ${num(t.mae_r || 0, 1)}`), h("td", { class: "why", text: trunc(whyText(t.why), 120) })));
  const heads = [["Closed"], ["Trade"], ["Style"], [sh ? "Shares" : "Units", 1], ["Entry", 1], ["Exit", 1], ...(sh ? [["Value", 1]] : []), ["Profit/loss", 1], ...(sh ? [["Return", 1]] : []),
    ["Result (R)", 1], ["Held", 1], ["Ended by"], ["Best / worst (R)", 1], ["Why it was taken"]];
  const out = [panel(`Closed trades (${d.total})`, table(heads, rows, "No closed trades yet."),
    h("p", { class: "fine", text: `Result (R) is the profit or loss in multiples of the amount risked. Best / worst shows how far the trade went in our favour and against us while it was open, in R.${sh ? " Return is the profit or loss as a percentage of the money put into the shares." : ""}` }))];
  if (d.trades.length < d.total) out.at(-1).append(h("button", { class: "ghost more", onclick: () => { state.pages[key] = off + 50; refresh(); } }, "Load more"));
  return out;
}

async function viewDecisions() {
  const kind = state.pages.kind || "all";
  const seg = h("div", { class: "seg" }, [["all", "All"], ["entry", "New trades"], ["manage", "Open positions"]].map(([k, l]) =>
    h("button", { "aria-pressed": String(kind === k), onclick: () => { state.pages.kind = k; for (const key of Object.keys(state.pages)) if (key.startsWith("decisions:")) state.pages[key] = 0; refresh(); } }, l)));
  const parts = await Promise.all(scope().map(async (a) => {
    const key = `decisions:${a.id}`, off = state.pages[key] || 0;
    const d = await api(`/v1/decisions?kind=${kind}&limit=${60 + off}&offset=0`, a.id);
    return inDesk(a.id, () => deskSection(a, decisionsBody(a, d, key, off)));
  }));
  return [h("div", { class: "toolrow" }, h("span", { class: "fine", text: "Show" }), seg), ...parts.flat()];
}
function decisionsBody(a, d, key, off) {
  const rows = [];
  for (const x of d.decisions) {
    const dk = `${a.id}:${x.id}`;
    rows.push(h("tr", { class: "row", "data-id": x.id, onclick: () => toggleDetail(dk) },
      h("td", { class: "num", text: clock(x.ts, true) }), h("td", {}, tickerName(x.instrument), x.name ? h("div", { class: "fine", text: x.name }) : null), h("td", { text: decisionType(x.kind) }),
      h("td", { text: choiceName(x.action) }), num_td(x.size ? `size ${x.size} of 3` : "-"),
      h("td", {}, pill(OUTCOME_CLASS[x.outcome] || "muted", x.reject_reason && x.outcome === "rejected" ? `blocked: ${rejectText(x.reject_reason)}` : outcomeText(x.outcome))),
      num_td(x.fwd15 === null || x.fwd15 === undefined ? "-" : num(x.fwd15, 2), x.fwd15 ? sgn(x.fwd15) : ""), num_td(x.latency_ms ? `${(x.latency_ms / 1000).toFixed(1)}s` : "-"),
      h("td", { class: "why", text: trunc(whyText(x.why, x.kind), 190) })));
    if (state.open.has(dk)) rows.push(h("tr", { class: "detail", "data-detail": x.id }, h("td", { colspan: 9 }, h("pre", { id: `det-${dk}`, text: state.details[dk] || "Loading…" }))));
  }
  const out = [panel(`Model decisions (${d.total})`,
    table([["Time"], ["Instrument"], ["Type"], ["Choice"], ["Size", 1], ["Result"], ["Price move 15 min later", 1], ["Thinking time", 1], ["Reason"]], rows, "No decisions yet."),
    h("p", { class: "fine", text: "Click a row to see exactly what the model was shown and what it answered. Price move is measured in typical 5-minute price swings (positive means the price rose). Size runs from 1 (smallest) to 3 (largest); while the model is unproven only size 1 is used." }))];
  if (d.decisions.length < d.total) out[0].append(h("button", { class: "ghost more", onclick: () => { state.pages[key] = off + 60; refresh(); } }, "Load more"));
  return out;
}
function toggleDetail(key) { state.open.has(key) ? state.open.delete(key) : state.open.add(key); refresh(); }
async function loadDetails() {
  for (const key of [...state.open]) {
    if (state.details[key]) continue;
    const [desk, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    try {
      const d = await api(`/v1/decisions/${id}`, desk);
      state.details[key] = JSON.stringify({ model_answer: d.raw, choices_offered: d.options_json, market_snapshot_shown_to_model: d.card_json, result: d.outcome, blocked_because: d.reject_reason }, null, 2);
    } catch { state.details[key] = "Unavailable (details are kept for 7 days)."; }
    const el = $(`det-${key}`);
    if (el) el.textContent = state.details[key];
  }
}

async function viewMarket() {
  const parts = await Promise.all(scope().map(async (a) => {
    const [d, u] = await Promise.all([api("/v1/market", a.id), a.screen ? api("/v1/universe", a.id).catch(() => null) : null]);
    return inDesk(a.id, () => deskSection(a, [u && u.enabled ? universePanel(u) : null, scannerPanel(d)]));
  }));
  return parts.flat();
}
function universePanel(u) {
  const C = u.criteria, ex = Object.entries(u.pool_exchanges || {}).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${num(v, 0)}`).join(" · ");
  const rows = [...u.active].sort((x, y) => (y.score ?? -1) - (x.score ?? -1)).map((s) => {
    const bar = h("span", { class: "bar" }, h("b")); bar.firstChild.style.width = `${Math.min(100, s.score || 0)}%`;
    return h("tr", {}, h("td", {}, h("b", { text: s.symbol }), s.held ? [" ", pill("good", "holding")] : null, h("div", { class: "fine", text: s.name || "" })), h("td", { text: s.exchange || "-" }),
      num_td(s.price === null || s.price === undefined ? "-" : num(s.price, 2)), num_td(s.move_pct === null || s.move_pct === undefined ? "-" : pct(s.move_pct, 2), sgn(s.move_pct)),
      num_td(s.spread_pct === null || s.spread_pct === undefined ? "-" : `${num(s.spread_pct, 2)}%`), h("td", {}, bar, " ", span("num muted", s.score === null || s.score === undefined ? "-" : num(s.score, 0))),
      h("td", { text: s.shortable === null || s.shortable === undefined ? "-" : s.shortable ? "yes" : "no" }),
      h("td", { class: "why" }, s.last_action ? [pill(OUTCOME_CLASS[s.last_outcome] || "muted", choiceName(s.last_action) !== "-" ? choiceName(s.last_action) : outcomeText(s.last_outcome)), " ", span("fine", ago(s.last_ts))] : span("fine", "not yet looked at")));
  });
  return panel(`Stock screen · watching ${u.active.length}`,
    h("div", { class: "kpis", id: "universe-kpis" },
      kpi("Candidate list", num(u.pool_size, 0), ex || "no list yet"), kpi("Watched right now", String(u.active.length), `up to ${C.active_n} · updated ${ago(u.active_ts)}`),
      kpi("List rebuilt", ago(u.pool_ts), "once a day"), kpi("Share price range", `$${num(C.min_price, 0)} – $${num(C.max_price, 0)}`, "cheaper and dearer are skipped"),
      kpi("Widest trading cost", `${num(C.max_spread_pct, 2)}%`, "gap between buy and sell price")),
    table([["Stock"], ["Exchange"], ["Price", 1], ["Move today", 1], ["Trading cost", 1], ["Attention score"], ["Can sell short?"], ["Model's last look"]], rows, "The first screen has not run yet."),
    h("p", { class: "fine", text: `Every day the desk ranks every US-listed stock by how much money changed hands and keeps the ${num(C.liquid_n, 0)} most traded. Every ${Math.round(C.refresh_s / 60)} minutes it re-scores those by today's movement, price range, unusual volume and trading cost, and watches the best ${C.active_n}. Stocks with an open position are always kept.` }));
}
function scannerPanel(d) {
  const sh = isShares();
  const rows = d.instruments.sort((a, b) => b.interest - a.interest).map((m) => {
    const bar = h("span", { class: "bar" }, h("b")); bar.firstChild.style.width = `${Math.min(100, m.interest)}%`;
    return h("tr", {}, h("td", {}, tickerName(m.instrument), h("div", { class: "fine", text: `${m.name ? m.name + " · " : ""}${className(m.class)}${m.open === null || m.open === undefined ? "" : m.open ? " · open" : " · closed"}` })), num_td(price(m.price, m.dp)), h("td", {}, bar, " ", span("num muted", num(m.interest, 0))),
      h("td", {}, arrow(m.trend.M5), arrow(m.trend.H1), arrow(m.trend.D)), num_td(`${num(m.rsi.M5, 0)} / ${num(m.rsi.H1, 0)}`),
      num_td(pct(m.chg["1h"], 2), sgn(m.chg["1h"])), num_td(pct(m.chg["1d"], 2), sgn(m.chg["1d"])), num_td(num(m.spread_pips, 1)), ...(sh ? [h("td", { text: m.shortable === null || m.shortable === undefined ? "-" : m.shortable ? "yes" : "no" })] : []),
      h("td", {}, (m.tags || []).map((t) => span("chip", tagText(t)))),
      h("td", { class: "why" }, m.last_look ? [pill(OUTCOME_CLASS[m.last_look.outcome] || "muted", choiceName(m.last_look.action) !== "-" ? choiceName(m.last_look.action) : outcomeText(m.last_look.outcome)), " ", span("fine", `${ago(m.last_look.ts)} · ${trunc(whyText(m.last_look.why), 110)}`)] : span("fine", "not yet looked at")));
  });
  return panel("Market scanner", table([["Instrument"], ["Price", 1], ["Attention score"], ["Trend: 5m · 1h · day"], ["Momentum 5m / 1h", 1], ["Last hour", 1], ["Last day", 1], [sh ? "Trading cost (¢)" : "Trading cost (pips)", 1], ...(sh ? [["Can sell short?"]] : []), ["What is happening"], ["Model's last look"]], rows, "Waiting for the first scan…"),
    h("p", { class: "fine", text: "The attention score (0-100) is a simple rule, not the model: it ranks which markets look most active so the model spends its time on those. Trend arrows show whether the price is rising or falling over recent minutes, the last hour and the day. Momentum is the RSI indicator: below 30 means pushed down hard, above 70 pushed up hard. Trading cost is the gap between the buy and sell price." }));
}

const qname = (k) => questionName(k);

function curveChart(q, minEv) {
  const W = 420, H = 210, g = stepGeometry(q.edges, q.values, W, H, minEv);
  if (!g) return h("div", { class: "empty", text: "No curve yet." });
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Expected result by the model's confidence" });
  const label = (x, y, text, anchor = "middle") => { const el = svg("text", { class: "axis", x, y, "text-anchor": anchor }); el.textContent = text; return el; };
  for (const t of g.yticks) { root.append(svg("line", { class: "grid-line", x1: g.pad.l, x2: W - g.pad.r, y1: t.y, y2: t.y }), label(g.pad.l - 6, t.y + 4, (t.v >= 0 ? "+" : "") + num(t.v, 2), "end")); }
  root.append(svg("line", { class: "zero-line", x1: g.pad.l, x2: W - g.pad.r, y1: g.zeroY, y2: g.zeroY }));
  if (minEv > 0) root.append(svg("line", { class: "ref", x1: g.pad.l, x2: W - g.pad.r, y1: g.evY, y2: g.evY }), label(W - g.pad.r, g.evY - 4, `needed: +${num(minEv, 2)}R`, "end"));
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
  if (!g) return h("div", { class: "empty", text: "Needs a day with 100+ recorded results." });
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Daily accuracy score" });
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
  const parts = await Promise.all(scope().map(async (a) => {
    const [d, ov] = await Promise.all([api("/v1/learning", a.id), api("/v1/overview", a.id)]);
    return inDesk(a.id, () => deskSection(a, learningBody(d, ov)));
  }));
  return parts.flat();
}
function learningBody(d, ov) {
  const hl = learningHeadline(d), cal = d.calibration, S = d.settings, last = d.runs[0];
  const aucs = Object.values(ov.model_skill.questions || {}).map((q) => q.auc).filter((x) => x);
  const meanAuc = aucs.length ? aucs.reduce((a, b) => a + b, 0) / aucs.length : null;
  const trusted = cal && cal.questions ? Object.values(cal.questions).filter((q) => q.trusted).length : 0;
  const out = [h("div", { class: `verdict ${hl.cls}`, id: `learn-verdict-${deskId()}`, text: hl.text }),
    h("div", { class: "kpis" },
      kpi("Model in use", trunc(d.model_id || "stock", 22), cal && cal.created ? `track record built ${cal.created.slice(0, 16).replace("T", " ")}` : "no track record yet"),
      kpi("Results learned from", num(d.samples.labelled, 0), `${num(d.samples.pending, 0)} still playing out`),
      kpi("Live accuracy score", meanAuc === null ? "-" : num(meanAuc, 3), meanAuc === null ? "needs 100+ results per trade type" : meanAuc >= 0.54 ? "showing some skill" : meanAuc > 0.46 ? "no better than chance" : "worse than chance", meanAuc === null ? "" : meanAuc >= 0.54 ? "pos" : meanAuc <= 0.46 ? "neg" : ""),
      kpi("Proven trade types", String(trusted), `of ${Object.keys((cal && cal.questions) || {}).length} tested`),
      kpi("Last learning update", last ? ago(last.ts) : "-", last ? `${runKindText(last.kind).toLowerCase()}: ${runActionText(last.action)}` : "none yet"))];
  const next = Math.max(0, S.retrain_min_new_states - d.samples.new_since_retrain);
  out.push(h("div", { class: "grid even" },
    panel("Learning progress",
      meter("Results needed for the first track record", d.samples.labelled, S.learn_min_rows, "Once enough results exist, the quick-update learner builds the model's first track record."),
      meter("New results toward the next overnight retrain", d.samples.new_since_retrain, S.retrain_min_new_states, next ? `${num(next, 0)} more needed. Retraining is tried at 03:30 and skipped if the Mac is short of memory.` : "Enough new data: the next 03:30 run will attempt a retrain."),
      h("p", { class: "fine", text: `Last retrain: ${d.samples.last_retrain_ts ? ago(d.samples.last_retrain_ts) : "never"}. The quick-update learner re-checks every ${S.learn_interval_min} min.` })),
    panel("The safety rules it cannot get around",
      h("ul", { class: "rules" },
        h("li", { text: `A kind of trade only gets full size if, on data it has never seen, it makes at least ${S.learn_min_selected} picks with an average result above zero that is statistically convincing (t-score of at least ${S.learn_min_t}).` }),
        h("li", { text: `Trust is withdrawn if fresh data stops backing it up (fewer than ${S.demote_min_n} picks, or an average result of ${S.demote_mean_r}R or worse).` }),
        h("li", { text: "A new model replaces the old one only if it clearly does better on data it was not trained on. Otherwise the old one stays." }),
        h("li", { text: "Until something is proven, only smallest-size trial trades run, and only for the model's strongest picks. Trial trades gather real results; they do not prove anything." })))));
  const qs = Object.entries((cal && cal.questions) || {});
  if (qs.length) out.push(h("div", { class: "grid even" }, qs.map(([k, q]) => panel([h("span", { text: `${qname(k)}: what the model's confidence is worth` }), h("span", { class: "spacer" }), pill(q.trusted ? "good" : "muted", q.trusted ? "trades" : "trial only")],
    curveChart(q, cal.min_ev_r || S.min_ev_r),
    h("p", { class: "fine num", text: `Left to right: how confident the model was that the trade would win. Height: the average result that followed, after trading costs, in R (multiples of the amount risked). Accuracy score on unseen data: ${q.auc === null || q.auc === undefined ? "-" : num(q.auc, 3)} · ${q.selected_n || 0} picks cleared the bar${q.selected_mean_r === null || q.selected_mean_r === undefined ? "" : ` · average ${num(q.selected_mean_r, 2)}R (t-score ${num(q.selected_t, 1)})`}.` })))));
  const dq = Object.entries(d.daily_auc || {});
  out.push(panel("Is it getting better? Daily accuracy score of its live predictions (0.50 = coin flip)", dq.length ? h("div", { class: "grid even" }, dq.map(([k, items]) => h("div", {}, h("div", { class: "fine", text: qname(k) }), aucChart(items)))) : h("div", { class: "empty", text: "The daily accuracy score appears once a day has 100+ recorded results for a kind of trade." })));
  const runs = d.runs.map((r) => h("tr", {}, h("td", { class: "num", text: clock(r.ts, true) }), h("td", { text: runKindText(r.kind) }), h("td", {}, pill(RUN_CLASS[r.action] || "muted", runActionText(r.action))),
    num_td(r.rows === null || r.rows === undefined ? "-" : num(r.rows, 0)), h("td", { text: trunc(r.model_id, 22) }), h("td", { class: "why", text: learnReasonText(r.reason) || (r.trusted.length ? `proven: ${r.trusted.map(qname).join(", ")}` : "") })));
  out.push(panel("Learning log", table([["When"], ["Type"], ["Result"], ["Results used", 1], ["Model"], ["Detail"]], runs, "No learning updates yet - they start once the engine has been up for a few minutes."),
    h("p", { class: "fine", text: "Quick update = the model's track record is re-measured on the latest live results (every 30 minutes). Overnight retrain = a fresh candidate model is trained and only replaces the current one if it clearly does better on data it was not trained on." })));
  return out;
}

async function viewSystem() {
  const parts = await Promise.all(scope().map(async (a) => {
    const [s, ov] = await Promise.all([api("/v1/system", a.id), api("/v1/overview", a.id)]);
    return inDesk(a.id, () => deskSection(a, systemBody(a, s, ov)));
  }));
  return parts.flat();
}
function systemBody(a, s, ov) {
  const e = s.engine || {}, L = s.limits;
  const ev = s.events.map((x) => h("tr", {}, h("td", { class: "num", text: clock(x.ts, true) }), h("td", {}, pill(x.level === "info" ? "muted" : x.level === "warn" ? "warn" : "bad", x.level === "info" ? "info" : x.level === "warn" ? "warning" : x.level === "critical" ? "urgent" : "error")), h("td", { text: eventText(x.kind) }), h("td", { class: "why", text: x.msg })));
  return [h("div", { class: "grid three" },
    panel("Engine", h("dl", { class: "kv" },
      h("dt", { text: "State" }), h("dd", {}, pill(ov.engine.state === "running" ? "good" : "warn", ov.engine.state.replace(/_/g, " "), true)),
      h("dt", { text: "Last check-in" }), h("dd", { class: "num", text: ov.engine.age_s === null ? "-" : `${ov.engine.age_s}s ago` }),
      h("dt", { text: "Model" }), h("dd", { text: e.model || "-" }), h("dt", { text: "Started" }), h("dd", { text: ago(e.started_at) }),
      h("dt", { text: "Instruments" }), h("dd", { class: "num", text: String(e.instruments ?? "-") }), h("dt", { text: "Price updates received" }), h("dd", { class: "num", text: num(e.stream_msgs ?? 0, 0) }),
      h("dt", { text: "Waiting to be looked at" }), h("dd", { class: "num", text: String(e.queue ?? "-") }), h("dt", { text: "Database" }), h("dd", { class: "num", text: `${num(s.db_bytes / 1048576, 1)} MB` }))),
    panel("Decision model (runs on the Mac)", h("dl", { class: "kv" },
      h("dt", { text: "Typical thinking time" }), h("dd", { class: "num", text: s.model.p50_ms ? `${s.model.p50_ms} ms` : "-" }), h("dt", { text: "Slow cases (1 in 20)" }), h("dd", { class: "num", text: s.model.p95_ms ? `${s.model.p95_ms} ms` : "-" }),
      h("dt", { text: "Proven trade types" }), h("dd", { class: "num", text: String((e.trusted_questions || []).length) }), h("dt", { text: "Track record built" }), h("dd", { class: "num", text: e.calibrated_at ? ago(Date.parse(e.calibrated_at) / 1000) : "never" }),
      h("dt", { text: "Failures in a row" }), h("dd", { class: "num", text: String(e.model_failures ?? 0) }),
      Object.entries(s.outcomes_24h).flatMap(([k, v]) => [h("dt", { text: `${outcomeText(k)} (24h)` }), h("dd", { class: "num", text: String(v) })]))),
    panel("Safety limits (enforced in code)", h("dl", { class: "kv" },
      h("dt", { text: "Risk per trade (size 1 / 2 / 3)" }), h("dd", { class: "num", text: Object.values(L.risk_pct_tiers).map((x) => `${x}%`).join(" / ") }),
      h("dt", { text: "Most open positions" }), h("dd", { class: "num", text: String(L.max_open) }), h("dt", { text: "Max total risk" }), h("dd", { class: "num", text: `${L.max_total_risk_pct}% of account` }),
      h("dt", { text: "Daily loss limit" }), h("dd", { class: "num", text: `${L.daily_loss_pct}%` }), h("dt", { text: "Stop trading if down" }), h("dd", { class: "num", text: `${L.drawdown_halt_pct}%` }),
      h("dt", { text: "New trades per hour" }), h("dd", { class: "num", text: String(L.entries_per_hour) }),
      a.day_trading ? [h("dt", { text: "Close everything before the market closes" }), h("dd", { class: "num", text: `${a.flatten_min} min` })] : null,
      a.broker === "alpaca" ? [h("dt", { text: "Short selling" }), h("dd", { class: "num", text: a.allow_short ? "allowed" : "off" })] : null,
      h("dt", { text: "Kinds of assets traded" }), h("dd", { class: "num", text: a.broker === "alpaca" ? "US shares" : a.trade_classes.join(", ") })))),
  panel("Recent events", table([["Time"], ["Level"], ["What happened"], ["Details"]], ev, "No events."))];
}

const VIEWS = { overview: viewOverview, positions: viewPositions, trades: viewTrades, decisions: viewDecisions, market: viewMarket, learning: viewLearning, system: viewSystem };

/* ---------------- boot ---------------- */
wireGate();
if (state.token) startApp();
