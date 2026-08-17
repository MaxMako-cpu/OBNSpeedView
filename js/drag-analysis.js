/* ======================================================================
   OBN SpeedView — Drag Analysis panel

   Live status bars — Vessel Speed, LP Range, and estimated Drag Force —
   shown per TMS (333/334), so the current risk is readable at a glance.
   Purely derived from fields already on the wire (IFR SOG,
   TMS{333,334}_LP Range, TMS{333,334}_LP Vertical distance) — no new
   telemetry.

   Design notes:
   - LP Range, as computed by 4DNav, is already the horizontal beacon-to-
     transceiver distance (confirmed against an earlier wrong assumption
     that it was a slant range needing a Pythagorean split against LP
     Vertical Distance — it isn't, so there is no geometric transform for
     the Range bar itself). This is LP Range itself, smoothed over a
     small sample-count window (DRAG_FILTER_WINDOW) to cut sample noise,
     mirroring the same derivation the backend also computes for its own
     "live" WS message fields. Recomputed independently here (rather than
     consumed from the WS message) so live and loaded-archive rows go
     through the exact same code path — archived rows never carry the
     backend's derived fields since those aren't persisted.
   - A gap between valid samples > DRAG_MAX_GAP_SEC resets that beacon's
     smoothing windows (fix dropout — don't average across the gap).
   - Drag force is a per-beacon geometric tension-balance estimate, not a
     speed-squared drag equation: a body hanging on a cable under sideways
     load satisfies horizontal_force / submerged_weight ≈
     horizontal_offset / vertical_depth, so
       F_TMS ≈ submerged_weight × (LP_Range_TMS / LP_VerticalDistance_TMS)
     computed independently from each beacon's own Range and Vertical
     Distance. This deliberately replaced an earlier shared vessel-speed-
     based (F = ½·ρ·Cd·A·v²) estimate that could never differ between the
     two beacons, since none of its inputs did — this one naturally
     differs per TMS because its geometry does. Vessel speed still shows
     as its own bar for context (it's the reason Range moves in the first
     place) but is no longer a term in the force formula itself.
   - No history, no fitting, no prediction — earlier designs tried both
     and neither held up under real-world testing. This panel shows the
     current measured value only, colored by the LP Range risk
     thresholds (RANGE_SAFE_MAX / RANGE_CAUTION_MAX below).
   - historyForBeacon() is kept (bucketed-average derivation, unchanged)
     purely for js/report.js's region-scoped PDF panel, which still shows
     a trend across a selected time window — that's a different, already
     time-bounded context where a historical view makes sense. It's a
     one-shot computation over a passed-in rows array, independent of
     this module's own (now snapshot-only) live state.
   ====================================================================== */
const DRAG_FILTER_WINDOW = 5;     // samples — smooths raw noise before display
const DRAG_MAX_GAP_SEC   = 5.0;   // seconds — dropout gap resets the smoothing windows
const DRAG_BUCKET_KT     = 0.1;   // speed-bucket width, used only by historyForBeacon (report.js)
const G                  = 9.81;  // m/s^2

// Bar scale ceilings (independent per metric — these have unrelated units)
const SPEED_MAX = 5;     // kt
const RANGE_MAX = 1000;  // m
const FORCE_MAX = 150;   // kN — the Range/VDist ratio can exceed 1, so peak forces run well above the old speed-based estimate's range

// LP Range risk thresholds
const RANGE_SAFE_MAX    = 500; // < this: safe (green)
const RANGE_CAUTION_MAX = 700; // < this: caution (amber); >= this: warning (red)

// Minimum vertical distance (m) before the Range/VDist ratio is treated as
// too ill-conditioned to trust (a TMS reported as almost directly at the
// transceiver's own depth would blow the ratio up without meaning anything).
const MIN_VDIST_M = 0.5;

const BEACONS = [
  // color is only used by js/report.js's PDF scatter/trend page (the live
  // panel below colors its bars by LP Range status, not beacon identity).
  { key: "333", label: "TMS333", rangeField: "TMS333_LP Range (m)", vdistField: "TMS333_LP Vertical distance (m)", color: "#ff4d6a" },
  { key: "334", label: "TMS334", rangeField: "TMS334_LP Range (m)", vdistField: "TMS334_LP Vertical distance (m)", color: "#3ee07a" },
];

function freshBeaconState() {
  return {
    rangeWindow: [],
    vdistWindow: [],
    lastEpoch: null,
    lastFilteredRange: null, // most recent real (smoothed) LP Range
    lastFilteredVDist: null, // most recent real (smoothed) LP Vertical Distance
    n: 0,                     // raw sample count ever seen this session, shown in the footer as a trust signal
  };
}

function loadEnabled(key) {
  const v = localStorage.getItem("sv_drag_enabled_" + key);
  return v === null ? true : v === "true";
}

// Default estimated from the TMS's known 3000kg air weight and duplex
// stainless steel's density (~7800 kg/m^3), accounting for buoyancy:
//   3000 * (1 - 1025/7800) ~= 2606 kg
// This assumes a solid block, which the real TMS isn't (it's a frame with
// internal electronics/void space) — hence tunable, not hardcoded.
const DEFAULT_SUBMERGED_WEIGHT_KG = 2606;

const drag = {
  submergedWeightKg: parseFloat(localStorage.getItem("sv_drag_weight_kg")) || DEFAULT_SUBMERGED_WEIGHT_KG,
  lastSog: null,
  // Per-beacon on/off — switched off when a TMS is on deck and its LP Range
  // is known-corrupt, so it never gets ingested. Doesn't touch the last
  // good reading already shown — only gates future samples.
  enabled: { "333": loadEnabled("333"), "334": loadEnabled("334") },
  beacons: { "333": freshBeaconState(), "334": freshBeaconState() },
};

function resetAll() {
  drag.lastSog = null;
  drag.beacons["333"] = freshBeaconState();
  drag.beacons["334"] = freshBeaconState();
}

function ingestPoint(key, lpRange, lpVDist, epoch) {
  const b = drag.beacons[key];
  const dt = (Number.isFinite(epoch) && b.lastEpoch !== null) ? Math.max(0, epoch - b.lastEpoch) : null;

  if (dt !== null && dt > DRAG_MAX_GAP_SEC) {
    b.rangeWindow.length = 0; // dropout — don't average pre/post-gap raw samples together
    b.vdistWindow.length = 0;
  }

  b.rangeWindow.push(lpRange);
  if (b.rangeWindow.length > DRAG_FILTER_WINDOW) b.rangeWindow.shift();
  b.lastFilteredRange = b.rangeWindow.reduce((a, v) => a + v, 0) / b.rangeWindow.length;

  b.vdistWindow.push(lpVDist);
  if (b.vdistWindow.length > DRAG_FILTER_WINDOW) b.vdistWindow.shift();
  b.lastFilteredVDist = b.vdistWindow.reduce((a, v) => a + v, 0) / b.vdistWindow.length;

  b.lastEpoch = epoch;
  b.n += 1;
}

// Called on the same day-boundary resets everything else in the app already
// does (regions, events, LP alert zones) — a new UTC day starts fresh
// rather than showing a stale reading from the previous day.
export function reset() {
  resetAll();
  if (panelOpen) updateBars();
}

export function ingestRow(row) {
  if (!row) return;
  const sog = row["IFR SOG (knot)"];
  if (sog !== null && sog !== undefined && Number.isFinite(sog)) drag.lastSog = sog;

  for (const b of BEACONS) {
    if (!drag.enabled[b.key]) continue;
    const range = row[b.rangeField];
    const vdist = row[b.vdistField];
    if (range === null || range === undefined || !Number.isFinite(range)) continue;
    if (vdist === null || vdist === undefined || !Number.isFinite(vdist)) continue;
    ingestPoint(b.key, range, vdist, row.epoch);
  }

  if (panelOpen) updateBars();
}

export function rebuildFromRows(rows) {
  resetAll();
  if (rows) for (const row of rows) ingestRow(row);
  if (panelOpen) updateBars();
}

function bucketIndex(sog) {
  return Math.round(sog / DRAG_BUCKET_KT);
}

// Sorted (by speed) array of { v, y, n } — the real per-bucket average LP
// Range for every speed observed in the given rows, and how many samples
// backed that average. Each raw point also carries its own smoothed
// Vertical Distance (vdist) so report.js can derive a force estimate for
// the region without duplicating the smoothing logic. Used only by
// js/report.js for a region's PDF page; see the module doc-comment above
// for why the live panel doesn't use this.
export function historyForBeacon(rows, beaconKey) {
  const bd = BEACONS.find((x) => x.key === beaconKey);
  const rawPoints = [];
  const buckets = new Map();
  const rangeWin = [];
  const vdistWin = [];
  for (const row of rows) {
    const sog = row["IFR SOG (knot)"];
    const range = row[bd.rangeField];
    const vdist = row[bd.vdistField];
    if (sog === null || sog === undefined || !Number.isFinite(sog)) continue;
    if (range === null || range === undefined || !Number.isFinite(range)) continue;
    rangeWin.push(range);
    if (rangeWin.length > DRAG_FILTER_WINDOW) rangeWin.shift();
    const filteredRange = rangeWin.reduce((a, v) => a + v, 0) / rangeWin.length;

    let filteredVDist = null;
    if (vdist !== null && vdist !== undefined && Number.isFinite(vdist)) {
      vdistWin.push(vdist);
      if (vdistWin.length > DRAG_FILTER_WINDOW) vdistWin.shift();
      filteredVDist = vdistWin.reduce((a, v) => a + v, 0) / vdistWin.length;
    }

    rawPoints.push({ v: sog, y: filteredRange, vdist: filteredVDist });
    const idx = bucketIndex(sog);
    let bucket = buckets.get(idx);
    if (!bucket) { bucket = { sum: 0, count: 0 }; buckets.set(idx, bucket); }
    bucket.sum += filteredRange;
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
  return { submergedWeightKg: drag.submergedWeightKg };
}

// F ~= submerged_weight * (LP_Range / LP_Vertical_Distance) — see the
// module doc-comment for the tension-balance derivation.
function estimateForce(rangeM, vdistM) {
  if (rangeM === null || vdistM === null || !(vdistM >= MIN_VDIST_M)) return null;
  const weightN = drag.submergedWeightKg * G;
  return weightN * (rangeM / vdistM); // Newtons
}

function rangeStatus(m) {
  if (m < RANGE_SAFE_MAX) return "safe";
  if (m < RANGE_CAUTION_MAX) return "caution";
  return "warning";
}

/* ======================================================================
   Panel DOM + rendering — plain DOM bars, no canvas
   ====================================================================== */
const btnOpen   = document.getElementById("btn-drag-analysis");
const modal     = document.getElementById("modal-drag-analysis");
const btnClose  = document.getElementById("drag-panel-close");
const inWeight  = document.getElementById("drag-in-weight");
const footerN   = document.getElementById("drag-footer-n");

let panelOpen = false;

function barEls(key) {
  return {
    speedVal:  document.getElementById(`drag-${key}-speed-val`),
    speedFill: document.getElementById(`drag-${key}-speed-fill`),
    rangeVal:  document.getElementById(`drag-${key}-range-val`),
    rangeStat: document.getElementById(`drag-${key}-range-status`),
    rangeFill: document.getElementById(`drag-${key}-range-fill`),
    forceVal:  document.getElementById(`drag-${key}-force-val`),
    forceFill: document.getElementById(`drag-${key}-force-fill`),
  };
}

function updateGroup(key) {
  const els = barEls(key);
  const b = drag.beacons[key];
  const enabled = drag.enabled[key];
  const sog = drag.lastSog !== null ? drag.lastSog : 0;

  if (els.speedVal) els.speedVal.innerHTML = enabled ? sog.toFixed(2) + '<span class="unit"> kn</span>' : '<span class="drag-bar-off">off</span>';
  if (els.speedFill) els.speedFill.style.height = enabled ? Math.min(100, (sog / SPEED_MAX) * 100) + "%" : "0%";

  if (!enabled || b.lastFilteredRange === null) {
    if (els.rangeVal) els.rangeVal.innerHTML = !enabled ? '<span class="drag-bar-off">off</span>' : '&mdash;';
    if (els.rangeStat) els.rangeStat.textContent = "";
    if (els.rangeFill) { els.rangeFill.style.height = "0%"; els.rangeFill.className = "drag-bar-fill"; }
    if (els.forceVal) els.forceVal.innerHTML = !enabled ? '<span class="drag-bar-off">off</span>' : '&mdash;';
    if (els.forceFill) els.forceFill.style.height = "0%";
    return;
  }

  const rangeM = b.lastFilteredRange;
  const status = rangeStatus(rangeM);
  if (els.rangeVal) els.rangeVal.innerHTML = rangeM.toFixed(0) + '<span class="unit"> m</span>';
  if (els.rangeStat) { els.rangeStat.textContent = status.toUpperCase(); els.rangeStat.className = "drag-bar-status status-" + status; }
  if (els.rangeFill) { els.rangeFill.style.height = Math.min(100, (rangeM / RANGE_MAX) * 100) + "%"; els.rangeFill.className = "drag-bar-fill range-" + status; }

  const forceN = estimateForce(rangeM, b.lastFilteredVDist);
  const forceKn = forceN !== null ? forceN / 1000 : null;
  if (els.forceVal) els.forceVal.innerHTML = forceKn !== null ? forceKn.toFixed(1) + '<span class="unit"> kN</span>' : '&mdash;';
  if (els.forceFill) els.forceFill.style.height = forceKn !== null ? Math.min(100, (forceKn / FORCE_MAX) * 100) + "%" : "0%";
}

function updateBars() {
  updateGroup("333");
  updateGroup("334");
  if (footerN) footerN.textContent = (drag.beacons["333"].n + drag.beacons["334"].n) + " observed samples this session";
}

export function openPanel() {
  panelOpen = true;
  modal.classList.add("open");
  updateBars();
}
function closePanel() {
  panelOpen = false;
  modal.classList.remove("open");
}

if (btnOpen) btnOpen.addEventListener("click", openPanel);
if (btnClose) btnClose.addEventListener("click", closePanel);
if (modal) modal.addEventListener("click", (e) => { if (e.target === modal) closePanel(); });

if (inWeight) inWeight.addEventListener("input", () => {
  const v = parseFloat(inWeight.value);
  if (Number.isFinite(v) && v > 0) { drag.submergedWeightKg = v; localStorage.setItem("sv_drag_weight_kg", String(v)); updateBars(); }
});

// Sync checkbox UI to the persisted enabled state, and wire toggling —
// switching off only gates future ingestion (see comment on drag.enabled),
// so the last good reading stays visible until re-enabled.
function wireBeaconToggle(key) {
  const el = document.getElementById("drag-toggle-" + key);
  if (!el) return;
  el.checked = drag.enabled[key];
  el.addEventListener("change", () => {
    drag.enabled[key] = el.checked;
    localStorage.setItem("sv_drag_enabled_" + key, String(el.checked));
    if (panelOpen) updateBars();
  });
}
wireBeaconToggle("333");
wireBeaconToggle("334");

// "Advanced" disclosure for the submerged-weight force input
const advToggle = document.getElementById("drag-adv-toggle");
const advBody   = document.getElementById("drag-adv-body");
if (advToggle && advBody) {
  advToggle.addEventListener("click", () => {
    const open = advBody.classList.toggle("open");
    advToggle.classList.toggle("open", open);
  });
}
