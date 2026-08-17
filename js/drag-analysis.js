/* ======================================================================
   OBN SpeedView — Drag Analysis panel

   Shows how TMS333/334 LP Range has actually responded to vessel SOG,
   live and on loaded archive days. Purely derived from fields already on
   the wire (IFR SOG, TMS{333,334}_LP Range) — no new telemetry.

   Design notes:
   - LP Range, as computed by 4DNav, is already the horizontal beacon-to-
     transceiver distance (confirmed against an earlier wrong assumption
     that it was a slant range needing a Pythagorean split against LP
     Vertical Distance — it isn't, so there is no geometric transform
     here). This is LP Range itself, smoothed over a small sample-count
     window (DRAG_FILTER_WINDOW) to cut sample noise, mirroring the same
     derivation the backend also computes for its own "live" WS message
     fields. Recomputed independently here (rather than consumed from the
     WS message) so live and loaded-archive rows go through the exact
     same code path — archived rows never carry the backend's derived
     fields since those aren't persisted.
   - A gap between valid samples > DRAG_MAX_GAP_SEC resets that beacon's
     smoothing window (fix dropout — don't average across the gap).
   - No fitting, no modeling, no extrapolation. This deliberately replaces
     an earlier curve-fit/prediction design that didn't hold up under
     real-world testing — every value shown here is a straight average of
     samples actually measured at that speed. Speeds never observed this
     session simply have no entry; nothing is projected or guessed.
     Smoothed samples are bucketed by speed (DRAG_BUCKET_KT) and averaged
     per bucket in O(1) per sample — that per-bucket average, plotted
     against the speeds that produced it, is the entire "history" view.
   ====================================================================== */
const DRAG_FILTER_WINDOW = 5;     // samples — smooths raw noise before bucketing
const DRAG_MAX_GAP_SEC   = 5.0;   // seconds — dropout gap resets the smoothing window
const DRAG_RING_CAP      = 3000;  // raw scatter points kept per beacon
const DRAG_BUCKET_KT     = 0.1;   // speed-bucket width for the historical average
const RHO                = 1025;  // seawater density, kg/m^3 — fixed

const BEACONS = [
  { key: "333", label: "TMS333", rangeField: "TMS333_LP Range (m)", color: "#ff4d6a", glow: "rgba(255,77,106,0.9)" },
  { key: "334", label: "TMS334", rangeField: "TMS334_LP Range (m)", color: "#3ee07a", glow: "rgba(62,224,122,0.9)" },
];

function freshBeaconState() {
  return {
    ring: [],
    window: [],
    lastEpoch: null,
    lastFiltered: null, // most recent real (smoothed) LP Range — used for the "now" readout
    n: 0,
    buckets: new Map(), // bucketIndex (round(sog/DRAG_BUCKET_KT)) -> { sum, count }
  };
}

function loadEnabled(key) {
  const v = localStorage.getItem("sv_drag_enabled_" + key);
  return v === null ? true : v === "true";
}

const drag = {
  cd: parseFloat(localStorage.getItem("sv_drag_cd")) || 1.10,
  area: parseFloat(localStorage.getItem("sv_drag_area")) || 5.23,
  sogMin: Infinity,
  sogMax: -Infinity,
  lastSog: null,
  // Per-beacon on/off — switched off when a TMS is on deck and its LP Range
  // is known-corrupt, so it never gets ingested into that beacon's history.
  // Doesn't touch already-accumulated data — only gates future samples, so
  // valid data collected before switching off stays visible.
  enabled: { "333": loadEnabled("333"), "334": loadEnabled("334") },
  beacons: { "333": freshBeaconState(), "334": freshBeaconState() },
};

function resetAll() {
  drag.sogMin = Infinity;
  drag.sogMax = -Infinity;
  drag.lastSog = null;
  drag.beacons["333"] = freshBeaconState();
  drag.beacons["334"] = freshBeaconState();
}

function bucketIndex(sog) {
  return Math.round(sog / DRAG_BUCKET_KT);
}

function ingestPoint(key, sog, lpRange, epoch) {
  const b = drag.beacons[key];
  const dt = (Number.isFinite(epoch) && b.lastEpoch !== null) ? Math.max(0, epoch - b.lastEpoch) : null;

  if (dt !== null && dt > DRAG_MAX_GAP_SEC) {
    b.window.length = 0; // dropout — don't average pre/post-gap raw samples together
  }

  b.window.push(lpRange);
  if (b.window.length > DRAG_FILTER_WINDOW) b.window.shift();
  const filtered = b.window.reduce((a, v) => a + v, 0) / b.window.length;

  b.lastEpoch = epoch;
  b.lastFiltered = filtered;
  b.n += 1;

  const idx = bucketIndex(sog);
  let bucket = b.buckets.get(idx);
  if (!bucket) { bucket = { sum: 0, count: 0 }; b.buckets.set(idx, bucket); }
  bucket.sum += filtered;
  bucket.count += 1;

  b.ring.push({ v: sog, y: filtered });
  if (b.ring.length > DRAG_RING_CAP) b.ring.shift();

  if (sog < drag.sogMin) drag.sogMin = sog;
  if (sog > drag.sogMax) drag.sogMax = sog;
  drag.lastSog = sog;
}

// Called on the same day-boundary resets everything else in the app already
// does (regions, events, LP alert zones) — a new UTC day starts the
// speed/LP-range history fresh rather than blending across days.
export function reset() {
  resetAll();
  if (panelOpen) refreshAll();
}

export function ingestRow(row) {
  if (!row) return;
  const sog = row["IFR SOG (knot)"];
  if (sog === null || sog === undefined || !Number.isFinite(sog)) return;
  const epoch = row.epoch;

  for (const b of BEACONS) {
    if (!drag.enabled[b.key]) continue;
    const range = row[b.rangeField];
    if (range === null || range === undefined || !Number.isFinite(range)) continue;
    ingestPoint(b.key, sog, range, epoch);
  }

  if (panelOpen) { render(); updateReadouts(hoverSog); }
}

export function rebuildFromRows(rows) {
  resetAll();
  if (rows) for (const row of rows) ingestRow(row);
  if (panelOpen) { render(); updateReadouts(hoverSog); buildHistoryTable(); }
}

// Sorted (by speed) array of { v, y, n } — the real per-bucket average LP
// Range for every speed actually observed this session, and how many
// samples backed that average. Empty buckets simply don't appear; nothing
// is interpolated or projected beyond what's been measured.
function historyPoints(key) {
  const b = drag.beacons[key];
  const pts = [];
  for (const [idx, bucket] of b.buckets) {
    pts.push({ v: idx * DRAG_BUCKET_KT, y: bucket.sum / bucket.count, n: bucket.count });
  }
  pts.sort((a, c) => a.v - c.v);
  return pts;
}

function nearestHistoryPoint(key, v) {
  const pts = historyPoints(key);
  if (!pts.length) return null;
  let best = pts[0];
  for (const p of pts) if (Math.abs(p.v - v) < Math.abs(best.v - v)) best = p;
  return best;
}

// Same bucketed-average derivation as ingestPoint/historyPoints, but as a
// one-shot computation over an arbitrary rows slice (e.g. a report region's
// time window) — independent of the live session state, for report.js.
export function historyForBeacon(rows, beaconKey) {
  const bd = BEACONS.find((x) => x.key === beaconKey);
  const rawPoints = [];
  const buckets = new Map();
  const win = [];
  for (const row of rows) {
    const sog = row["IFR SOG (knot)"];
    const range = row[bd.rangeField];
    if (sog === null || sog === undefined || !Number.isFinite(sog)) continue;
    if (range === null || range === undefined || !Number.isFinite(range)) continue;
    win.push(range);
    if (win.length > DRAG_FILTER_WINDOW) win.shift();
    const filtered = win.reduce((a, v) => a + v, 0) / win.length;
    rawPoints.push({ v: sog, y: filtered });
    const idx = bucketIndex(sog);
    let bucket = buckets.get(idx);
    if (!bucket) { bucket = { sum: 0, count: 0 }; buckets.set(idx, bucket); }
    bucket.sum += filtered;
    bucket.count += 1;
  }
  const history = [];
  for (const [idx, bucket] of buckets) history.push({ v: idx * DRAG_BUCKET_KT, y: bucket.sum / bucket.count, n: bucket.count });
  history.sort((a, b) => a.v - b.v);
  return { points: rawPoints, history };
}

export function beaconConfig() {
  return BEACONS.map((b) => ({ key: b.key, label: b.label, color: b.color }));
}

export function getForceInputs() {
  return { cd: drag.cd, area: drag.area, rho: RHO };
}

function estimateForce(sogKn) {
  const vms = sogKn * 0.514444;
  return 0.5 * RHO * drag.cd * drag.area * vms * vms; // Newtons
}

/* ======================================================================
   Panel DOM + rendering
   ====================================================================== */
const btnOpen   = document.getElementById("btn-drag-analysis");
const modal     = document.getElementById("modal-drag-analysis");
const btnClose  = document.getElementById("drag-panel-close");
const chartWrap = document.getElementById("drag-chart-wrap");
const canvas    = document.getElementById("drag-chart-canvas");
const ctx       = canvas ? canvas.getContext("2d") : null;
const tooltip   = document.getElementById("drag-tooltip");

const toggle333 = document.getElementById("drag-toggle-333");
const toggle334 = document.getElementById("drag-toggle-334");

const roSog   = document.getElementById("drag-ro-sog");
const roForce = document.getElementById("drag-ro-force");
const roR333  = document.getElementById("drag-ro-r333");
const roR334  = document.getElementById("drag-ro-r334");
const inCd    = document.getElementById("drag-in-cd");
const inArea  = document.getElementById("drag-in-area");
const historyTbody = document.getElementById("drag-history-tbody");
const footerN = document.getElementById("drag-footer-n");

const MARGIN = { top: 22, right: 24, bottom: 42, left: 62 };
let cssW = 0, cssH = 0, dpr = window.devicePixelRatio || 1;
let panelOpen = false;
let hoverSog = null;

function resizeCanvas() {
  if (!chartWrap || !canvas) return;
  const r = chartWrap.getBoundingClientRect();
  cssW = Math.max(r.width, 50); cssH = Math.max(r.height, 50);
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = cssW + "px";
  canvas.style.height = cssH + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function axisBounds() {
  const currentSog = drag.lastSog !== null ? drag.lastSog : 0;
  const observedMax = Number.isFinite(drag.sogMax) ? drag.sogMax : 0;
  const vMax = Math.max(Math.max(observedMax, currentSog) + 0.3, 1.0);

  let yMax = 50;
  for (const b of BEACONS) {
    for (const p of historyPoints(b.key)) if (p.y > yMax) yMax = p.y;
  }
  return { vMax, yMax: yMax * 1.15 };
}

function area() {
  return { x0: MARGIN.left, y0: MARGIN.top, x1: cssW - MARGIN.right, y1: cssH - MARGIN.bottom, w: cssW - MARGIN.left - MARGIN.right, h: cssH - MARGIN.top - MARGIN.bottom };
}

function render() {
  if (!ctx) return;
  if (!cssW || !cssH) resizeCanvas();
  ctx.clearRect(0, 0, cssW, cssH);
  const a = area();
  const { vMax, yMax } = axisBounds();
  const xToPx = (v) => a.x0 + (v / vMax) * a.w;
  const yToPx = (y) => a.y1 - (y / yMax) * a.h;

  const currentSog = drag.lastSog !== null ? drag.lastSog : 0;

  // current-speed marker line
  ctx.save();
  const px0 = xToPx(currentSog);
  ctx.strokeStyle = "rgba(255,180,84,0.6)";
  ctx.setLineDash([4, 4]); ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(px0, a.y0); ctx.lineTo(px0, a.y1); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#ffb454"; ctx.font = "12px 'JetBrains Mono', monospace";
  ctx.textAlign = "left";
  ctx.fillText("NOW  " + currentSog.toFixed(2) + " KN", px0 + 8, a.y0 + 15);
  ctx.restore();

  // grid
  ctx.save();
  ctx.strokeStyle = "rgba(23,48,73,0.55)";
  ctx.fillStyle = "#8fa8bd";
  ctx.font = "12.5px 'JetBrains Mono', monospace";
  ctx.lineWidth = 1;
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  const yStep = yMax > 600 ? 150 : yMax > 200 ? 50 : 20;
  for (let y = 0; y <= yMax; y += yStep) {
    const py = yToPx(y);
    ctx.beginPath(); ctx.moveTo(a.x0, py); ctx.lineTo(a.x1, py); ctx.stroke();
    ctx.fillText(y.toFixed(0), a.x0 - 10, py);
  }
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  const vStep = vMax > 4 ? 1 : 0.5;
  for (let v = 0; v <= vMax + 1e-6; v += vStep) {
    const pxv = xToPx(v);
    ctx.beginPath(); ctx.moveTo(pxv, a.y0); ctx.lineTo(pxv, a.y1); ctx.stroke();
    ctx.fillText(v.toFixed(1), pxv, a.y1 + 8);
  }
  ctx.save(); ctx.translate(16, a.y0 + a.h / 2); ctx.rotate(-Math.PI / 2);
  ctx.font = "11.5px 'JetBrains Mono', monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("LP RANGE (M)", 0, 0);
  ctx.restore();
  ctx.textAlign = "center"; ctx.textBaseline = "alphabetic"; ctx.font = "11.5px 'JetBrains Mono', monospace";
  ctx.fillText("VESSEL SOG (KN)", a.x0 + a.w / 2, cssH - 7);
  ctx.restore();

  ctx.save();
  ctx.beginPath(); ctx.rect(a.x0, a.y0, a.w, a.h); ctx.clip();

  for (const bd of BEACONS) {
    const b = drag.beacons[bd.key];

    // scatter cloud — every raw sample actually measured
    ctx.save();
    ctx.fillStyle = bd.color;
    ctx.globalAlpha = 0.22;
    for (const p of b.ring) {
      const pxp = xToPx(p.v), pyp = yToPx(p.y);
      ctx.beginPath(); ctx.arc(pxp, pyp, 2.4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();

    const hist = historyPoints(bd.key);
    if (hist.length < 2) continue;

    // history line — connects the real per-speed averages, nothing beyond them
    ctx.save();
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.shadowColor = bd.glow; ctx.shadowBlur = 7;
    ctx.strokeStyle = bd.color; ctx.lineWidth = 2.5;
    ctx.beginPath();
    hist.forEach((p, i) => {
      const pxp = xToPx(p.v), pyp = yToPx(p.y);
      if (i === 0) ctx.moveTo(pxp, pyp); else ctx.lineTo(pxp, pyp);
    });
    ctx.stroke();
    ctx.restore();

    // per-bucket markers, sized by how many samples back that average —
    // more samples at a speed = a bigger, more confident-looking dot.
    ctx.save();
    ctx.fillStyle = bd.color;
    for (const p of hist) {
      const pxp = xToPx(p.v), pyp = yToPx(p.y);
      const r = Math.max(2, Math.min(6, 2 + Math.sqrt(p.n)));
      ctx.beginPath(); ctx.arc(pxp, pyp, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  if (hoverSog !== null) {
    ctx.strokeStyle = "rgba(216,230,242,0.3)";
    ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
    const pxp = xToPx(hoverSog);
    ctx.beginPath(); ctx.moveTo(pxp, a.y0); ctx.lineTo(pxp, a.y1); ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}

function updateReadouts(sogOverride) {
  const hovering = sogOverride !== null && sogOverride !== undefined;
  const sog = hovering ? sogOverride : (drag.lastSog !== null ? drag.lastSog : 0);

  // Not hovering ("now"): show the real last-observed/smoothed LP Range.
  // Hovering elsewhere on the chart: show the nearest speed bucket that was
  // actually measured — never a projection.
  const r333 = hovering ? nearestHistoryPoint("333", sog) : (drag.beacons["333"].lastFiltered !== null ? { y: drag.beacons["333"].lastFiltered } : null);
  const r334 = hovering ? nearestHistoryPoint("334", sog) : (drag.beacons["334"].lastFiltered !== null ? { y: drag.beacons["334"].lastFiltered } : null);

  if (roSog) roSog.innerHTML = sog.toFixed(2) + '<span class="unit">kn</span>';
  if (roForce) roForce.innerHTML = (estimateForce(sog) / 1000).toFixed(2) + '<span class="unit">kN</span>';
  if (roR333) roR333.innerHTML = !drag.enabled["333"] ? "OFF" : r333 ? r333.y.toFixed(0) + '<span class="unit">m</span>' : '—';
  if (roR334) roR334.innerHTML = !drag.enabled["334"] ? "OFF" : r334 ? r334.y.toFixed(0) + '<span class="unit">m</span>' : '—';
  if (footerN) footerN.textContent = (drag.beacons["333"].n + drag.beacons["334"].n) + " observed samples this session";
}

function buildHistoryTable() {
  if (!historyTbody) return;
  historyTbody.innerHTML = "";
  const h333 = historyPoints("333");
  const h334 = historyPoints("334");
  if (!h333.length && !h334.length) {
    historyTbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--text-dim);padding:12px 4px;">No data yet — history builds as the vessel moves at different speeds.</td></tr>';
    return;
  }
  const map333 = new Map(h333.map((p) => [p.v, p]));
  const map334 = new Map(h334.map((p) => [p.v, p]));
  const allV = Array.from(new Set([...h333.map((p) => p.v), ...h334.map((p) => p.v)])).sort((a, b) => a - b);

  const currentSog = drag.lastSog !== null ? drag.lastSog : 0;
  let nearestV = null;
  for (const v of allV) if (nearestV === null || Math.abs(v - currentSog) < Math.abs(nearestV - currentSog)) nearestV = v;

  function cell(enabled, p) {
    if (!enabled) return "OFF";
    return p ? `${p.y.toFixed(0)}m &middot;${p.n}` : "&mdash;";
  }

  for (const v of allV) {
    const tr = document.createElement("tr");
    if (v === nearestV) tr.className = "now-row";
    tr.innerHTML = `<td>${v.toFixed(1)} kn</td>` +
      `<td class="c333">${cell(drag.enabled["333"], map333.get(v))}</td>` +
      `<td class="c334">${cell(drag.enabled["334"], map334.get(v))}</td>`;
    historyTbody.appendChild(tr);
  }
}

function refreshAll() {
  resizeCanvas();
  render();
  updateReadouts(hoverSog);
  buildHistoryTable();
}

export function openPanel() {
  panelOpen = true;
  modal.classList.add("open");
  refreshAll();
}
function closePanel() {
  panelOpen = false;
  modal.classList.remove("open");
}

if (btnOpen) btnOpen.addEventListener("click", openPanel);
if (btnClose) btnClose.addEventListener("click", closePanel);
if (modal) modal.addEventListener("click", (e) => { if (e.target === modal) closePanel(); });

if (inCd) inCd.addEventListener("input", () => {
  const v = parseFloat(inCd.value);
  if (Number.isFinite(v) && v > 0) { drag.cd = v; localStorage.setItem("sv_drag_cd", String(v)); updateReadouts(hoverSog); }
});
if (inArea) inArea.addEventListener("input", () => {
  const v = parseFloat(inArea.value);
  if (Number.isFinite(v) && v > 0) { drag.area = v; localStorage.setItem("sv_drag_area", String(v)); updateReadouts(hoverSog); }
});

// Sync checkbox UI to the persisted enabled state, and wire toggling —
// switching off only gates future ingestion (see comment on drag.enabled),
// so nothing is cleared here, just re-rendered to reflect the change.
function wireBeaconToggle(el, key) {
  if (!el) return;
  el.checked = drag.enabled[key];
  el.addEventListener("change", () => {
    drag.enabled[key] = el.checked;
    localStorage.setItem("sv_drag_enabled_" + key, String(el.checked));
    if (panelOpen) refreshAll();
  });
}
wireBeaconToggle(toggle333, "333");
wireBeaconToggle(toggle334, "334");

if (canvas) {
  canvas.addEventListener("mousemove", (e) => {
    const a = area();
    const rect = canvas.getBoundingClientRect();
    const { vMax } = axisBounds();
    const pxv = e.clientX - rect.left;
    let v = ((pxv - a.x0) / a.w) * vMax;
    v = Math.max(0, Math.min(vMax, v));
    hoverSog = v;
    render();
    updateReadouts(v);

    const p333 = drag.enabled["333"] ? nearestHistoryPoint("333", v) : null;
    const p334 = drag.enabled["334"] ? nearestHistoryPoint("334", v) : null;

    tooltip.style.display = "block";
    tooltip.style.left = Math.min(pxv + 14, cssW - 215) + "px";
    const anchorY = Math.max(p333 ? p333.y : 0, p334 ? p334.y : 0);
    const yToPxLocal = (y) => a.y1 - (y / axisBounds().yMax) * a.h;
    tooltip.style.top = (yToPxLocal(anchorY) - 10) + "px";
    tooltip.innerHTML =
      `<div class="row"><span class="k">SOG</span><span class="v">${v.toFixed(2)} kn</span></div>` +
      `<div class="row"><span class="k" style="color:var(--red)">TMS333</span><span class="v">${p333 ? p333.y.toFixed(0) + " m (n=" + p333.n + ")" : "—"}</span></div>` +
      `<div class="row"><span class="k" style="color:var(--green)">TMS334</span><span class="v">${p334 ? p334.y.toFixed(0) + " m (n=" + p334.n + ")" : "—"}</span></div>` +
      `<div class="row"><span class="k">nearest measured speed</span><span class="v"></span></div>`;
  });
  canvas.addEventListener("mouseleave", () => {
    hoverSog = null;
    if (tooltip) tooltip.style.display = "none";
    render();
    updateReadouts(null);
  });
}

window.addEventListener("resize", () => { if (panelOpen) refreshAll(); });
