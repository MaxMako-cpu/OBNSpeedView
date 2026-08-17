/* ======================================================================
   OBN SpeedView — Drag Analysis panel

   Tracks how TMS333/334 LP Range responds to vessel SOG, live and on
   loaded archive days. Purely derived from fields already on the wire
   (IFR SOG, TMS{333,334}_LP Range) — no new telemetry.

   Design notes (see conversation for the full rationale):
   - LP Range, as computed by 4DNav, is already the horizontal beacon-to-
     transceiver distance (confirmed against an earlier wrong assumption
     that it was a slant range needing a Pythagorean split against LP
     Vertical Distance — it isn't, so there is no geometric transform
     here at all). This is LP Range itself, smoothed over a small
     sample-count window (DRAG_FILTER_WINDOW) to cut sample noise before
     it feeds the fit, mirroring the same derivation the backend also
     computes for its own "live" WS message fields. Recomputed
     independently here (rather than consumed from the WS message) so
     live and loaded-archive rows go through the exact same code path —
     archived rows never carry the backend's derived fields since those
     aren't persisted.
   - A gap between valid samples > DRAG_MAX_GAP_SEC resets that beacon's
     smoothing window (fix dropout — don't average across the gap).
   - The live fit is a weighted linear regression of LP Range on SOG^2
     (not SOG) — matching the drag-force relationship (F ~ v^2) rather
     than an unconstrained free-form quadratic that could curve back
     down at high speed or swing wildly on extrapolation. The fitted
     slope k is clamped >= 0: LP Range increasing with speed is the only
     physically sane direction for a towed body.
   - Weighting decays exponentially by elapsed time (DRAG_FIT_HALFLIFE_SEC),
     applied to the running sums on every sample in O(1), so the fit
     tracks current conditions — a sample from hours ago fades out rather
     than permanently anchoring the curve alongside brand-new data.
   - Every prediction carries a standard-error estimate (the textbook
     prediction-interval formula for weighted simple linear regression,
     computed from the same running sums) that grows the further a speed
     is from the weighted center of what's actually been observed — so
     "we're extrapolating past real data" is visible, not silently
     presented as equally precise as the fitted region.
   - Running sums are maintained in O(1) per sample, decayed rather than
     reset, so the fit is always current without rescanning history. A
     separate capped ring buffer holds raw points only for the scatter
     cloud's visual texture — decoupled from the fit itself.
   ====================================================================== */
const DRAG_FILTER_WINDOW    = 5;     // samples
const DRAG_MAX_GAP_SEC      = 5.0;   // seconds
const DRAG_RING_CAP         = 3000;  // raw scatter points kept per beacon
const DRAG_FIT_HALFLIFE_SEC = 900;   // 15 min — how fast the live fit forgets old samples
const DRAG_DECAY_LAMBDA     = Math.LN2 / DRAG_FIT_HALFLIFE_SEC;
const PREDICT_HORIZON_KT    = 2.0;   // how far past current/max-observed speed to predict
const PREDICT_STEP_KT       = 0.1;
const RHO                   = 1025;  // seawater density, kg/m^3 — fixed

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
    n: 0,               // raw sample count ever seen (gates "insufficient data", not fit-weighted)
    // Exponentially-decayed weighted sums for the y = baseline + k*v^2 fit
    // (u = v^2). Decayed by elapsed time on every ingest — see
    // DRAG_FIT_HALFLIFE_SEC — so old samples fade rather than persisting
    // at full weight forever.
    Sw: 0, Su: 0, Suu: 0, Sy: 0, Suy: 0, Syy: 0,
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
  // is known-corrupt, so it never gets ingested into that beacon's fit.
  // Doesn't touch already-accumulated data — only gates future samples, so
  // valid data collected before switching off stays in the fit.
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

function ingestPoint(key, sog, lpRange, epoch) {
  const b = drag.beacons[key];
  const dt = (Number.isFinite(epoch) && b.lastEpoch !== null) ? Math.max(0, epoch - b.lastEpoch) : null;

  if (dt !== null && dt > DRAG_MAX_GAP_SEC) {
    b.window.length = 0; // dropout — don't average pre/post-gap raw samples together
  }

  b.window.push(lpRange);
  if (b.window.length > DRAG_FILTER_WINDOW) b.window.shift();
  const filtered = b.window.reduce((a, v) => a + v, 0) / b.window.length;

  // Decay the fit's running sums by elapsed time before adding this sample,
  // so older contributions shrink smoothly instead of being remembered at
  // full weight forever. A gap large enough to also reset the smoothing
  // window above decays this by the same (large) factor automatically —
  // no separate gap-handling needed here.
  if (dt !== null) {
    const decay = Math.exp(-DRAG_DECAY_LAMBDA * dt);
    b.Sw *= decay; b.Su *= decay; b.Suu *= decay;
    b.Sy *= decay; b.Suy *= decay; b.Syy *= decay;
  }

  const u = sog * sog;
  b.Sw += 1;
  b.Su += u;
  b.Suu += u * u;
  b.Sy += filtered;
  b.Suy += u * filtered;
  b.Syy += filtered * filtered;
  b.n += 1;

  b.lastEpoch = epoch;
  b.lastFiltered = filtered;

  b.ring.push({ v: sog, y: filtered });
  if (b.ring.length > DRAG_RING_CAP) b.ring.shift();

  if (sog < drag.sogMin) drag.sogMin = sog;
  if (sog > drag.sogMax) drag.sogMax = sog;
  drag.lastSog = sog;
}

// Called on the same day-boundary resets everything else in the app already
// does (regions, events, LP alert zones) — a new UTC day starts the
// speed/LP-range correlation fresh rather than blending across days.
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
  if (panelOpen) { render(); updateReadouts(hoverSog); buildPredictionTable(); }
}

// Weighted simple linear regression of y (LP Range) on u = v^2 (SOG^2) —
// y = baseline + k*u — from pre-accumulated (possibly decayed) sums.
// Physically constrained: k is clamped >= 0 (LP Range can't physically
// decrease with speed for a towed body); if the unconstrained fit wants
// k < 0, it's refit with k pinned to 0 (plain weighted mean — "no speed
// dependence detected yet") rather than reporting a backwards slope.
// stdAt(v) is the standard prediction-interval formula for weighted simple
// linear regression: it's smallest near the weighted center of the speeds
// actually observed and grows the further a speed is from that center in
// either direction — i.e. it's honest about extrapolation risk.
// Returns null if there's too little speed^2 variation to solve stably.
function solveDragModelFromSums(Sw, Su, Suu, Sy, Suy, Syy) {
  if (!(Sw > 1e-6)) return null;
  const D = Sw * Suu - Su * Su; // = Sw * Sxx
  if (!Number.isFinite(D) || Math.abs(D) < 1e-6) return null; // near-singular — not enough speed variation

  let baseline = (Suu * Sy - Su * Suy) / D;
  let k = (Sw * Suy - Su * Sy) / D;
  if (!Number.isFinite(baseline) || !Number.isFinite(k)) return null;

  if (k < 0) {
    k = 0;
    baseline = Sy / Sw;
  }

  const rss = Syy - 2 * (baseline * Sy + k * Suy) + baseline * baseline * Sw + 2 * baseline * k * Su + k * k * Suu;
  const residualVar = Math.max(0, rss / Sw);
  const xbar = Su / Sw;
  const Sxx = D / Sw;
  if (!(Sxx > 1e-6)) return null;

  return {
    n: Sw,
    at: (v) => baseline + k * v * v,
    slopeAt: (v) => 2 * k * v,
    stdAt: (v) => {
      const u = v * v;
      const variance = residualVar * (1 + 1 / Sw + ((u - xbar) * (u - xbar)) / Sxx);
      return Math.sqrt(Math.max(0, variance));
    },
  };
}

// Fit from this session's live-accumulated, exponentially-decayed running
// sums (O(1) per sample, always current — see DRAG_FIT_HALFLIFE_SEC).
function computeFit(key) {
  const b = drag.beacons[key];
  if (b.n < 10) return null;
  return solveDragModelFromSums(b.Sw, b.Su, b.Suu, b.Sy, b.Suy, b.Syy);
}

// Fit from an arbitrary rows slice (e.g. a report region's time window) —
// independent of the live session state, for one-shot use by report.js.
// Applies the same SMA smoothing over the slice's samples in order, but
// unweighted/undecayed — a report region is already a fixed, user-chosen
// window, so every sample in it counts equally rather than fading by age.
export function fitRowsForBeacon(rows, beaconKey) {
  const bd = BEACONS.find((x) => x.key === beaconKey);
  const points = [];
  const win = [];
  for (const row of rows) {
    const sog = row["IFR SOG (knot)"];
    const range = row[bd.rangeField];
    if (sog === null || sog === undefined || !Number.isFinite(sog)) continue;
    if (range === null || range === undefined || !Number.isFinite(range)) continue;
    win.push(range);
    if (win.length > DRAG_FILTER_WINDOW) win.shift();
    const filtered = win.reduce((a, v) => a + v, 0) / win.length;
    points.push({ v: sog, y: filtered });
  }
  if (points.length < 10) return { points, fit: null };
  let Sw = 0, Su = 0, Suu = 0, Sy = 0, Suy = 0, Syy = 0;
  for (const p of points) {
    const u = p.v * p.v;
    Sw += 1; Su += u; Suu += u * u;
    Sy += p.y; Suy += u * p.y; Syy += p.y * p.y;
  }
  return { points, fit: solveDragModelFromSums(Sw, Su, Suu, Sy, Suy, Syy) };
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
const sens333 = document.getElementById("drag-sens-333");
const sens334 = document.getElementById("drag-sens-334");
const inCd    = document.getElementById("drag-in-cd");
const inArea  = document.getElementById("drag-in-area");
const predictTbody = document.getElementById("drag-predict-tbody");
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
  let vMax = Math.max(observedMax, currentSog) + PREDICT_HORIZON_KT;
  vMax = Math.max(vMax, 2.0);

  let yMax = 50;
  for (const b of BEACONS) {
    const fit = computeFit(b.key);
    if (!fit) continue;
    for (let v = 0; v <= vMax; v += vMax / 30) {
      // Include the confidence band's upper edge so it's never clipped.
      const y = Math.max(0, fit.at(v) + fit.stdAt(v));
      if (y > yMax) yMax = y;
    }
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
  const observedMax = Number.isFinite(drag.sogMax) ? drag.sogMax : currentSog;
  const observedMin = Number.isFinite(drag.sogMin) ? drag.sogMin : 0;
  const predictFrom = Math.max(currentSog, observedMax);

  // prediction zone shading + divider
  ctx.save();
  const px0 = xToPx(predictFrom);
  ctx.fillStyle = "rgba(255,180,84,0.06)";
  ctx.fillRect(px0, a.y0, a.x1 - px0, a.h);
  ctx.strokeStyle = "rgba(255,180,84,0.6)";
  ctx.setLineDash([4, 4]); ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(px0, a.y0); ctx.lineTo(px0, a.y1); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#ffb454"; ctx.font = "12px 'JetBrains Mono', monospace";
  ctx.textAlign = "left";
  ctx.fillText("CURRENT  " + currentSog.toFixed(2) + " KN", px0 + 8, a.y0 + 15);
  ctx.fillStyle = "rgba(255,180,84,0.75)";
  ctx.fillText("PREDICTED →", px0 + 8, a.y1 - 10);
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
    const fit = computeFit(bd.key);

    // confidence band (±1 std, the prediction-interval formula) — drawn
    // first so the scatter/lines/marker sit on top of it.
    if (fit) {
      ctx.save();
      ctx.fillStyle = bd.color;
      ctx.globalAlpha = 0.10;
      ctx.beginPath();
      const bandStep = Math.max(vMax / 100, 0.01);
      let firstUpper = true;
      const lowerPts = [];
      for (let v = 0; v <= vMax + 1e-6; v += bandStep) {
        const std = fit.stdAt(v);
        const yHi = Math.max(0, fit.at(v) + std);
        const yLo = Math.max(0, fit.at(v) - std);
        const pxp = xToPx(v);
        if (firstUpper) { ctx.moveTo(pxp, yToPx(yHi)); firstUpper = false; } else ctx.lineTo(pxp, yToPx(yHi));
        lowerPts.push([pxp, yToPx(yLo)]);
      }
      for (let i = lowerPts.length - 1; i >= 0; i--) ctx.lineTo(lowerPts[i][0], lowerPts[i][1]);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // scatter cloud
    ctx.save();
    ctx.fillStyle = bd.color;
    ctx.globalAlpha = 0.25;
    for (const p of b.ring) {
      const pxp = xToPx(p.v), pyp = yToPx(p.y);
      ctx.beginPath(); ctx.arc(pxp, pyp, 2.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();

    if (!fit) continue;

    // observed segment — solid, across the actually-observed speed range
    ctx.save();
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.shadowColor = bd.glow; ctx.shadowBlur = 7;
    ctx.strokeStyle = bd.color; ctx.lineWidth = 2;
    ctx.beginPath();
    const step = Math.max(vMax / 200, 0.01);
    let started = false;
    for (let v = observedMin; v <= observedMax; v += step) {
      const pxp = xToPx(v), pyp = yToPx(Math.max(0, fit.at(v)));
      if (!started) { ctx.moveTo(pxp, pyp); started = true; } else ctx.lineTo(pxp, pyp);
    }
    ctx.stroke();

    // predicted segment — dashed, from current/observed-max out to the horizon
    ctx.shadowBlur = 5;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    started = false;
    for (let v = predictFrom; v <= vMax + 1e-6; v += step) {
      const pxp = xToPx(v), pyp = yToPx(Math.max(0, fit.at(v)));
      if (!started) { ctx.moveTo(pxp, pyp); started = true; } else ctx.lineTo(pxp, pyp);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // current-speed marker
    ctx.save();
    const pxp = xToPx(currentSog), pyp = yToPx(Math.max(0, fit.at(currentSog)));
    ctx.beginPath();
    ctx.fillStyle = "#050a12"; ctx.strokeStyle = bd.color; ctx.lineWidth = 2;
    ctx.shadowColor = bd.glow; ctx.shadowBlur = 10;
    ctx.arc(pxp, pyp, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  if (hoverSog !== null) {
    ctx.strokeStyle = "rgba(216,230,242,0.35)";
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
  const fit333 = computeFit("333");
  const fit334 = computeFit("334");

  // Not hovering ("now"): show the real last-observed/smoothed LP Range, not
  // a regression estimate — early in a session or with noisy data the fit can
  // read differently from what was actually just measured. While hovering
  // elsewhere on the chart, there's no "real" sample at that speed, so the
  // fit is the only thing that can answer "what would it be at this speed".
  const r333 = hovering ? (fit333 ? Math.max(0, fit333.at(sog)) : null) : drag.beacons["333"].lastFiltered;
  const r334 = hovering ? (fit334 ? Math.max(0, fit334.at(sog)) : null) : drag.beacons["334"].lastFiltered;

  if (roSog) roSog.innerHTML = sog.toFixed(2) + '<span class="unit">kn</span>';
  if (roForce) roForce.innerHTML = (estimateForce(sog) / 1000).toFixed(2) + '<span class="unit">kN</span>';
  if (roR333) roR333.innerHTML = !drag.enabled["333"] ? "OFF" : (r333 !== null && r333 !== undefined) ? r333.toFixed(0) + '<span class="unit">m</span>' : '—';
  if (roR334) roR334.innerHTML = !drag.enabled["334"] ? "OFF" : (r334 !== null && r334 !== undefined) ? r334.toFixed(0) + '<span class="unit">m</span>' : '—';
  if (sens333) sens333.textContent = !drag.enabled["333"] ? "beacon switched off" : fit333 ? fmtSlope(fit333.slopeAt(sog)) : "insufficient data";
  if (sens334) sens334.textContent = !drag.enabled["334"] ? "beacon switched off" : fit334 ? fmtSlope(fit334.slopeAt(sog)) : "insufficient data";
  if (footerN) footerN.textContent = (drag.beacons["333"].n + drag.beacons["334"].n) + " observed samples this session";
}
function fmtSlope(perKt) {
  const per01 = perKt / 10;
  return (per01 >= 0 ? "+" : "") + per01.toFixed(1) + " m / +0.1kt";
}

function fmtCell(enabled, fit, v) {
  if (!enabled) return "OFF";
  if (!fit) return "—";
  return `${Math.max(0, fit.at(v)).toFixed(0)} ±${fit.stdAt(v).toFixed(0)} m`;
}

function buildPredictionTable() {
  if (!predictTbody) return;
  predictTbody.innerHTML = "";
  const fit333 = computeFit("333");
  const fit334 = computeFit("334");
  if ((!fit333 && !fit334) || (!drag.enabled["333"] && !drag.enabled["334"])) {
    const msg = (!drag.enabled["333"] && !drag.enabled["334"])
      ? "Both beacons switched off — enable at least one to see a prediction."
      : "Not enough speed variation yet — keep tracking to build a fit.";
    predictTbody.innerHTML = `<tr><td colspan="3" style="text-align:center;color:var(--text-dim);padding:12px 4px;">${msg}</td></tr>`;
    return;
  }
  const currentSog = drag.lastSog !== null ? drag.lastSog : 0;
  const observedMax = Number.isFinite(drag.sogMax) ? drag.sogMax : currentSog;
  const startFrom = Math.max(currentSog, observedMax);
  const horizon = startFrom + PREDICT_HORIZON_KT;

  const nowTr = document.createElement("tr");
  nowTr.className = "now-row";
  nowTr.innerHTML = `<td>${currentSog.toFixed(2)} kn</td>` +
    `<td class="c333">${fmtCell(drag.enabled["333"], fit333, currentSog)}</td>` +
    `<td class="c334">${fmtCell(drag.enabled["334"], fit334, currentSog)}</td>`;
  predictTbody.appendChild(nowTr);

  const startStep = Math.ceil(startFrom / PREDICT_STEP_KT) * PREDICT_STEP_KT;
  for (let v = Math.round(startStep * 10) / 10; v <= horizon + 1e-6; v = Math.round((v + PREDICT_STEP_KT) * 10) / 10) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${v.toFixed(1)} kn</td>` +
      `<td class="c333">${fmtCell(drag.enabled["333"], fit333, v)}</td>` +
      `<td class="c334">${fmtCell(drag.enabled["334"], fit334, v)}</td>`;
    predictTbody.appendChild(tr);
  }
}

function refreshAll() {
  resizeCanvas();
  render();
  updateReadouts(hoverSog);
  buildPredictionTable();
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

    const fit333 = computeFit("333"), fit334 = computeFit("334");
    const y333 = fit333 ? Math.max(0, fit333.at(v)) : null;
    const y334 = fit334 ? Math.max(0, fit334.at(v)) : null;
    const s333 = fit333 ? fit333.stdAt(v) : null;
    const s334 = fit334 ? fit334.stdAt(v) : null;
    const currentSog = drag.lastSog !== null ? drag.lastSog : 0;
    const observedMax = Math.max(currentSog, Number.isFinite(drag.sogMax) ? drag.sogMax : currentSog);
    const stateLabel = v <= observedMax ? "observed fit" : "predicted";

    tooltip.style.display = "block";
    tooltip.style.left = Math.min(pxv + 14, cssW - 215) + "px";
    const anchorY = Math.max(y333 || 0, y334 || 0);
    const yToPxLocal = (y) => a.y1 - (y / axisBounds().yMax) * a.h;
    tooltip.style.top = (yToPxLocal(anchorY) - 10) + "px";
    tooltip.innerHTML =
      `<div class="row"><span class="k">SOG</span><span class="v">${v.toFixed(2)} kn</span></div>` +
      `<div class="row"><span class="k" style="color:var(--red)">TMS333</span><span class="v">${y333 !== null ? y333.toFixed(0) + " ±" + s333.toFixed(0) + " m" : "—"}</span></div>` +
      `<div class="row"><span class="k" style="color:var(--green)">TMS334</span><span class="v">${y334 !== null ? y334.toFixed(0) + " ±" + s334.toFixed(0) + " m" : "—"}</span></div>` +
      `<div class="row"><span class="k">${stateLabel}</span><span class="v"></span></div>`;
  });
  canvas.addEventListener("mouseleave", () => {
    hoverSog = null;
    if (tooltip) tooltip.style.display = "none";
    render();
    updateReadouts(null);
  });
}

window.addEventListener("resize", () => { if (panelOpen) refreshAll(); });
