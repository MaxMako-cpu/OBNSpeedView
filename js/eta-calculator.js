/* ======================================================================
   OBN SpeedView — ETA Calculator panel

   Plan a route to a final WP as a series of legs (each with its own
   distance + planned speed), see the resulting Planned ETA (UTC + local),
   then track a live Actual ETA against it using the vessel's real live
   speed (IFR SOG, already on the wire — no new telemetry).

   Design notes:
   - Distance covered since "Calculate & Start" is dead-reckoned as
     current speed x elapsed time — there's no WP coordinate entered, only
     a distance figure, so this can't know the vessel's true bearing to
     the WP. It assumes the vessel is closing on the WP at its current
     speed. Real course deviations (survey lines, holding, transit not
     yet started) will make the live estimate drift from reality — see
     the panel's own footer note.
   - Only fed from genuinely live rows (see ingestLiveRow(), wired from
     live-data.js's handleLiveRow — never from archive-day loads/replays,
     since instantly replaying a day's rows would make "elapsed time"
     meaningless for this tool). Tracking keeps running in the background
     even while the panel is closed, same as Drag Analysis, so reopening
     it reflects current progress immediately — the ETA CALCULATOR button
     itself picks up the app's existing ".tbtn.active" convention while a
     plan is running, so that's visible even with the panel closed.
   - The plan is an ordered list of items: LEGS (distance + speed) and ROV
     DEPLOY/RECOVERY holds (a fixed duration, zero distance, vessel
     expected at 0kt). Planned ETA is the sum of every item's own
     duration — a leg's duration is distance/speed, a hold's is just its
     given hours+minutes. Live dead-reckoning doesn't need to know about
     holds at all: it only ever integrates real distance from real speed,
     and a genuine hold shows up naturally as ~0 distance progress for
     that stretch, no special-casing required.
   - "Current segment" (which leg or hold you're nominally in) has to be
     tracked by ELAPSED TIME against the plan, not by distance — a hold
     has no distance dimension, so a distance-based walk could never
     represent "currently in a hold" at all. See currentSegmentIndex().
   - Actual ETA projects from the SPEED_SMOOTH_WINDOW-sample average of
     live speed (same smoothing convention as Drag Analysis) so it
     doesn't jitter wildly with every noisy sample; distance-covered
     integration itself uses each row's own instantaneous speed x dt,
     since smoothing that would distort the cumulative total.
   - No fitting, no prediction beyond simple dead-reckoning — the whole
     point is comparing a fixed plan against real live progress.
   ====================================================================== */
import { showToast } from './modals.js';

const KT_TO_MPS = 0.514444;
const SPEED_SMOOTH_WINDOW = 5;        // samples — matches Drag Analysis' smoothing window
const MAX_INTEGRATION_GAP_SEC = 30;   // seconds — a gap longer than this isn't integrated (avoid a fake distance jump after a dropout)
const MIN_HISTORY_INTERVAL_SEC = 5;   // seconds — minimum spacing between chart history points, bounds growth on long transits
const HISTORY_MAX_POINTS = 20000;     // hard cap safety net

const CHART_MARGIN = { top: 10, right: 14, bottom: 22, left: 56 };
const CHART_FONT = "10px 'JetBrains Mono', Consolas, monospace";

function loadTzMode() {
  const v = localStorage.getItem("sv_eta_tz_mode");
  return v === "manual" ? "manual" : "auto";
}
function loadTzOffset() {
  const v = parseFloat(localStorage.getItem("sv_eta_tz_offset"));
  return Number.isFinite(v) ? v : 0;
}

let tzMode = loadTzMode();
let tzOffsetHr = loadTzOffset();

// ---- item form state (ordered legs + ROV deploy/recovery holds) ----
let items = [{ id: 1, type: "leg", dist: null, speed: null }];
let nextItemId = 2;

// ---- live plan state ----
let plan = null;          // { name, totalDist, durSec, items:[{type,dist,speed,durationSec,cumStart,cumEnd}], startEpoch, plannedEtaEpoch }
let coveredDist = 0;
let lastEpoch = null;     // most recent live row's epoch, for dead-reckoning integration
const speedWindow = [];   // recent live SOG samples, for the Actual ETA projection
const history = [];       // [{epoch, actualEtaEpoch}] — feeds the chart

let panelOpen = false;

/* ---- time formatting ---- */
function fmtHMS(epochSec, offsetHr) {
  const ms = offsetHr ? (epochSec + offsetHr * 3600) * 1000 : epochSec * 1000;
  const d = new Date(ms);
  const p2 = (n) => String(n).padStart(2, "0");
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
}
function fmtLocal(epochSec) {
  if (tzMode === "auto") {
    return new Date(epochSec * 1000).toLocaleTimeString([], { hour12: false });
  }
  return fmtHMS(epochSec, tzOffsetHr) + ` (UTC${tzOffsetHr >= 0 ? "+" : ""}${tzOffsetHr})`;
}
function fmtDur(sec) {
  if (sec === null || !Number.isFinite(sec)) return "&mdash;";
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

/* ---- item math (legs + ROV deploy/recovery holds) ---- */
function legDurationSec(leg) {
  if (!(leg.dist > 0) || !(leg.speed > 0)) return null;
  return leg.dist / (leg.speed * KT_TO_MPS);
}
function holdDurationSec(hold) {
  const total = (hold.hours || 0) * 3600 + (hold.minutes || 0) * 60;
  return total > 0 ? total : null;
}
function itemDurationSec(item) {
  return item.type === "hold" ? holdDurationSec(item) : legDurationSec(item);
}
function computeTotals() {
  let totalDist = 0, totalDurSec = 0, complete = items.length > 0;
  for (const item of items) {
    const dur = itemDurationSec(item);
    if (dur === null) { complete = false; continue; }
    if (item.type === "leg") totalDist += item.dist;
    totalDurSec += dur;
  }
  return { totalDist, totalDurSec, complete };
}
// Which item (leg or hold) the plan should currently be in, based on real
// ELAPSED TIME against the plan's cumulative per-item duration — not
// distance, since a hold has no distance dimension to walk against (see
// module doc-comment).
function currentSegmentIndex(elapsedSec, planItems) {
  for (let i = 0; i < planItems.length; i++) {
    if (elapsedSec < planItems[i].cumEnd || i === planItems.length - 1) return i;
  }
  return planItems.length - 1;
}

/* ======================================================================
   DOM refs
   ====================================================================== */
const btnOpen  = document.getElementById("btn-eta-calc");
const modal    = document.getElementById("modal-eta-calculator");
const btnClose = document.getElementById("eta-panel-close");

const formCard   = document.getElementById("eta-form-card");
const liveState  = document.getElementById("eta-live-state");
const inName     = document.getElementById("eta-in-name");
const legsListEl = document.getElementById("eta-legs-list");
const btnAddLeg  = document.getElementById("eta-btn-add-leg");
const btnAddHold = document.getElementById("eta-btn-add-hold");
const totalPreviewEl = document.getElementById("eta-total-preview");
const btnCalc    = document.getElementById("eta-btn-calc");
const btnReset   = document.getElementById("eta-btn-reset");

const tzChips    = document.querySelectorAll(".eta-tz-chip");
const inTzOffset = document.getElementById("eta-in-tz-offset");
const tzHintEl   = document.getElementById("eta-tz-hint");

const sumName  = document.getElementById("eta-sum-name");
const sumDist  = document.getElementById("eta-sum-dist");
const sumLeg   = document.getElementById("eta-sum-leg");
const sumStart = document.getElementById("eta-sum-start");
const plannedUtcEl   = document.getElementById("eta-planned-utc");
const plannedLocalEl = document.getElementById("eta-planned-local");
const actualUtcEl    = document.getElementById("eta-actual-utc");
const actualLocalEl  = document.getElementById("eta-actual-local");
const adjustBadge = document.getElementById("eta-adjust-badge");
const adjustIcon  = document.getElementById("eta-adjust-icon");
const adjustText  = document.getElementById("eta-adjust-text");

const canvasChart = document.getElementById("eta-chart");
const ctxChart    = canvasChart ? canvasChart.getContext("2d") : null;

/* ======================================================================
   Item list rendering (legs + ROV deploy/recovery holds)
   ====================================================================== */
// Full rebuild only on structural changes (add/remove an item). Editing a
// field only patches that row's duration text + the total — rebuilding
// the whole list on every keystroke would drop input focus.
function renderLegs() {
  if (!legsListEl) return;
  let legN = 0, holdN = 0;
  const ordinals = new Map();
  for (const it of items) ordinals.set(it, it.type === "leg" ? ++legN : ++holdN);

  legsListEl.innerHTML = items.map((it) => {
    const removeBtn = `<button class="eta-leg-remove ${items.length <= 1 ? "hidden" : ""}" data-id="${it.id}" title="Remove">&times;</button>`;
    if (it.type === "hold") {
      const dur = holdDurationSec(it);
      return `
      <div class="eta-leg-row eta-hold-row" data-id="${it.id}">
        <span class="eta-leg-num eta-hold-badge">H${ordinals.get(it)}</span>
        <input type="number" class="eta-hold-hours" value="${it.hours ?? ""}" min="0" step="1" placeholder="hr" data-id="${it.id}">
        <input type="number" class="eta-hold-minutes" value="${it.minutes ?? ""}" min="0" max="59" step="1" placeholder="min" data-id="${it.id}">
        <span class="eta-leg-dur">${dur === null ? "&mdash;" : fmtDur(dur)}</span>
        ${removeBtn}
      </div>`;
    }
    const dur = legDurationSec(it);
    return `
    <div class="eta-leg-row" data-id="${it.id}">
      <span class="eta-leg-num">${ordinals.get(it)}</span>
      <input type="number" class="eta-leg-dist" value="${it.dist ?? ""}" min="1" step="10" placeholder="m" data-id="${it.id}">
      <input type="number" class="eta-leg-speed" value="${it.speed ?? ""}" min="0.1" step="0.1" placeholder="kt" data-id="${it.id}">
      <span class="eta-leg-dur">${dur === null ? "&mdash;" : "~" + fmtDur(dur)}</span>
      ${removeBtn}
    </div>`;
  }).join("");

  legsListEl.querySelectorAll(".eta-leg-dist").forEach((el) => el.addEventListener("input", (e) => {
    const it = items.find((x) => x.id === +e.target.dataset.id);
    it.dist = e.target.value === "" ? null : parseFloat(e.target.value);
    updateComputedOnly();
  }));
  legsListEl.querySelectorAll(".eta-leg-speed").forEach((el) => el.addEventListener("input", (e) => {
    const it = items.find((x) => x.id === +e.target.dataset.id);
    it.speed = e.target.value === "" ? null : parseFloat(e.target.value);
    updateComputedOnly();
  }));
  legsListEl.querySelectorAll(".eta-hold-hours").forEach((el) => el.addEventListener("input", (e) => {
    const it = items.find((x) => x.id === +e.target.dataset.id);
    it.hours = e.target.value === "" ? null : parseFloat(e.target.value);
    updateComputedOnly();
  }));
  legsListEl.querySelectorAll(".eta-hold-minutes").forEach((el) => el.addEventListener("input", (e) => {
    const it = items.find((x) => x.id === +e.target.dataset.id);
    it.minutes = e.target.value === "" ? null : parseFloat(e.target.value);
    updateComputedOnly();
  }));
  legsListEl.querySelectorAll(".eta-leg-remove").forEach((el) => el.addEventListener("click", (e) => {
    if (items.length <= 1) return;
    items = items.filter((x) => x.id !== +e.target.dataset.id);
    renderLegs();
  }));
  updateComputedOnly();
}

function updateComputedOnly() {
  if (!legsListEl) return;
  legsListEl.querySelectorAll(".eta-leg-row").forEach((row) => {
    const it = items.find((x) => x.id === +row.dataset.id);
    const durEl = row.querySelector(".eta-leg-dur");
    if (!it || !durEl) return;
    const dur = itemDurationSec(it);
    durEl.innerHTML = dur === null ? "&mdash;" : (it.type === "hold" ? fmtDur(dur) : "~" + fmtDur(dur));
  });
  updatePreview();
}

function updatePreview() {
  if (!totalPreviewEl) return;
  const { totalDist, totalDurSec, complete } = computeTotals();
  if (!complete) {
    totalPreviewEl.innerHTML = "Fill in every leg (distance &amp; speed) and hold (duration) to see the total.";
    return;
  }
  const legCount = items.filter((it) => it.type === "leg").length;
  const holdCount = items.filter((it) => it.type === "hold").length;
  const holdPart = holdCount ? ` &middot; ${holdCount} ROV hold${holdCount > 1 ? "s" : ""}` : "";
  totalPreviewEl.innerHTML = `Total distance: <b>${totalDist.toLocaleString()} m</b> across ${legCount} leg${legCount !== 1 ? "s" : ""}${holdPart} &middot; planned duration <b>~${fmtDur(totalDurSec)}</b>`;
}

if (btnAddLeg) btnAddLeg.addEventListener("click", () => {
  const lastLeg = [...items].reverse().find((it) => it.type === "leg");
  items.push({ id: nextItemId++, type: "leg", dist: lastLeg ? lastLeg.dist : null, speed: lastLeg ? lastLeg.speed : null });
  renderLegs();
});
if (btnAddHold) btnAddHold.addEventListener("click", () => {
  items.push({ id: nextItemId++, type: "hold", hours: null, minutes: null });
  renderLegs();
});

renderLegs();

/* ======================================================================
   Local time mode
   ====================================================================== */
function applyTzUi() {
  tzChips.forEach((c) => c.classList.toggle("active", c.dataset.mode === tzMode));
  if (inTzOffset) {
    inTzOffset.classList.toggle("show", tzMode === "manual");
    inTzOffset.value = tzOffsetHr;
  }
  if (tzHintEl) tzHintEl.textContent = tzMode === "auto" ? "using browser timezone" : "fixed UTC offset";
}
tzChips.forEach((chip) => chip.addEventListener("click", () => {
  tzMode = chip.dataset.mode;
  localStorage.setItem("sv_eta_tz_mode", tzMode);
  applyTzUi();
  if (plan) updateLiveView();
}));
if (inTzOffset) inTzOffset.addEventListener("input", (e) => {
  const v = parseFloat(e.target.value);
  if (Number.isFinite(v)) {
    tzOffsetHr = v;
    localStorage.setItem("sv_eta_tz_offset", String(v));
    if (plan) updateLiveView();
  }
});
applyTzUi();

/* ======================================================================
   Calculate / Reset
   ====================================================================== */
if (btnCalc) btnCalc.addEventListener("click", () => {
  const { totalDist, totalDurSec, complete } = computeTotals();
  if (!complete || totalDist <= 0) {
    showToast("Fill in every leg (distance & speed) and hold (duration) first");
    return;
  }
  const startEpoch = lastEpoch !== null ? lastEpoch : Date.now() / 1000;

  // Frozen snapshot with cumulative TIME boundaries per item, for live
  // "current segment" lookup and the chart's hold-window shading.
  let cum = 0;
  const frozenItems = items.map((it) => {
    const dur = itemDurationSec(it);
    const cumStart = cum;
    cum += dur;
    return it.type === "hold"
      ? { type: "hold", durationSec: dur, cumStart, cumEnd: cum }
      : { type: "leg", dist: it.dist, speed: it.speed, durationSec: dur, cumStart, cumEnd: cum };
  });

  plan = {
    name: inName && inName.value.trim() ? inName.value.trim() : "Final WP",
    totalDist,
    durSec: totalDurSec,
    items: frozenItems,
    startEpoch,
    plannedEtaEpoch: startEpoch + totalDurSec,
  };
  coveredDist = 0;
  speedWindow.length = 0;
  history.length = 0;

  if (formCard) formCard.classList.add("hide");
  if (liveState) liveState.classList.add("show");
  if (btnOpen) btnOpen.classList.add("active"); // visible proof tracking continues even with the panel closed
  updateLiveView();
});

if (btnReset) btnReset.addEventListener("click", () => {
  plan = null;
  coveredDist = 0;
  speedWindow.length = 0;
  history.length = 0;
  if (formCard) formCard.classList.remove("hide");
  if (liveState) liveState.classList.remove("show");
  if (btnOpen) btnOpen.classList.remove("active");
});

/* ======================================================================
   Live ingestion — called from live-data.js on genuinely live rows only
   (never from archive-day loads/replays — see module doc-comment).
   ====================================================================== */
export function ingestLiveRow(row) {
  if (!row) return;
  const sog = row["IFR SOG (knot)"];
  const epoch = row.epoch;
  const validSog = sog !== null && sog !== undefined && Number.isFinite(sog);

  if (validSog) {
    speedWindow.push(sog);
    if (speedWindow.length > SPEED_SMOOTH_WINDOW) speedWindow.shift();
  }

  if (Number.isFinite(epoch)) {
    if (plan && validSog && lastEpoch !== null) {
      const dt = epoch - lastEpoch;
      if (dt > 0 && dt <= MAX_INTEGRATION_GAP_SEC) {
        coveredDist = Math.min(plan.totalDist, coveredDist + sog * KT_TO_MPS * dt);
      }
    }
    lastEpoch = epoch;
  }

  if (plan) recomputeActual(epoch);
  if (panelOpen) updateLiveView();
}

function smoothedSpeedKt() {
  if (!speedWindow.length) return null;
  return speedWindow.reduce((a, b) => a + b, 0) / speedWindow.length;
}

function recomputeActual(epoch) {
  if (!plan || !Number.isFinite(epoch)) return;
  const remaining = plan.totalDist - coveredDist;
  const speed = smoothedSpeedKt();

  let actualEtaEpoch;
  if (remaining <= 0) {
    actualEtaEpoch = epoch;
  } else if (speed === null || speed <= 0) {
    actualEtaEpoch = null;
  } else {
    actualEtaEpoch = epoch + remaining / (speed * KT_TO_MPS);
  }

  if (actualEtaEpoch !== null) {
    if (!history.length || epoch - history[history.length - 1].epoch >= MIN_HISTORY_INTERVAL_SEC) {
      history.push({ epoch, actualEtaEpoch });
      if (history.length > HISTORY_MAX_POINTS) history.shift();
    }
  }
}

function speedAdjustment(epoch) {
  if (!plan) return null;
  const remaining = plan.totalDist - coveredDist;
  if (remaining <= 0) return { state: "arrived" };
  const timeRemainingToPlannedSec = plan.plannedEtaEpoch - epoch;
  const speed = smoothedSpeedKt();
  if (speed === null) return { state: "waiting" };
  if (timeRemainingToPlannedSec <= 0) return { state: "passed", remaining };
  const requiredSpeedKt = (remaining / timeRemainingToPlannedSec) / KT_TO_MPS;
  const delta = requiredSpeedKt - speed;
  if (Math.abs(delta) < 0.05) return { state: "ok" };
  return { state: delta > 0 ? "up" : "down", requiredSpeedKt, delta };
}

/* ======================================================================
   Live view rendering — DOM + canvas
   ====================================================================== */
function resizeChartCanvas(canvas) {
  if (!canvas || !canvas.parentElement) return { w: 0, h: 0 };
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(0, Math.round(rect.width));
  const h = Math.max(0, Math.round(rect.height));
  if (w < 2 || h < 2) return { w: 0, h: 0 };
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}

function drawChart() {
  if (!canvasChart || !ctxChart || !plan) return;
  const { w, h } = resizeChartCanvas(canvasChart);
  if (w < 10 || h < 10) return;
  ctxChart.clearRect(0, 0, w, h);

  const nowEpoch = lastEpoch !== null ? lastEpoch : plan.startEpoch;
  const elapsedNow = nowEpoch - plan.startEpoch;
  const xMax = Math.max(elapsedNow * 1.08, 600);

  const allEta = [plan.plannedEtaEpoch, ...history.map((p) => p.actualEtaEpoch)];
  let yMin = Math.min(...allEta), yMax = Math.max(...allEta);
  const pad = Math.max(120, (yMax - yMin) * 0.3); // >= 2 min padding (seconds)
  yMin -= pad; yMax += pad;

  const x0 = CHART_MARGIN.left, y0 = CHART_MARGIN.top, x1 = w - CHART_MARGIN.right, y1 = h - CHART_MARGIN.bottom;
  const pw = Math.max(1, x1 - x0), ph = Math.max(1, y1 - y0);
  const xToPx = (sec) => x0 + (sec / xMax) * pw;
  const yToPx = (epoch) => y1 - ((epoch - yMin) / (yMax - yMin)) * ph;

  ctxChart.save();
  ctxChart.strokeStyle = "rgba(23,48,73,0.5)";
  ctxChart.fillStyle = "#6f8aa3";
  ctxChart.font = CHART_FONT;
  ctxChart.lineWidth = 1;
  ctxChart.textAlign = "right"; ctxChart.textBaseline = "middle";
  for (let i = 0; i <= 4; i++) {
    const epoch = yMin + (yMax - yMin) * (i / 4);
    const py = yToPx(epoch);
    ctxChart.beginPath(); ctxChart.moveTo(x0, py); ctxChart.lineTo(x1, py); ctxChart.stroke();
    ctxChart.fillText(fmtHMS(epoch), x0 - 6, py);
  }
  ctxChart.textAlign = "center"; ctxChart.textBaseline = "top";
  const xMaxMin = xMax / 60;
  const xStepMin = Math.max(1, Math.round(xMaxMin / 6));
  for (let m = 0; m <= xMaxMin; m += xStepMin) {
    const px = xToPx(m * 60);
    ctxChart.beginPath(); ctxChart.moveTo(px, y0); ctxChart.lineTo(px, y1); ctxChart.stroke();
    ctxChart.fillText(m + "m", px, y1 + 5);
  }
  ctxChart.restore();

  ctxChart.save();
  ctxChart.beginPath(); ctxChart.rect(x0, y0, pw, ph); ctxChart.clip();

  // Planned ROV Deploy/Recovery windows — shaded bands on the timeline
  ctxChart.fillStyle = "rgba(255,180,84,0.10)";
  for (const it of plan.items) {
    if (it.type !== "hold") continue;
    const xA = xToPx(it.cumStart), xB = xToPx(it.cumEnd);
    ctxChart.fillRect(xA, y0, Math.max(1, xB - xA), ph);
  }

  ctxChart.strokeStyle = "#8fa8bd"; ctxChart.lineWidth = 1.5; ctxChart.setLineDash([5, 4]);
  const plannedPy = yToPx(plan.plannedEtaEpoch);
  ctxChart.beginPath(); ctxChart.moveTo(x0, plannedPy); ctxChart.lineTo(x1, plannedPy); ctxChart.stroke();
  ctxChart.setLineDash([]);

  if (history.length > 1) {
    ctxChart.strokeStyle = "#7fd4ff"; ctxChart.lineWidth = 2;
    ctxChart.shadowColor = "rgba(127,212,255,0.7)"; ctxChart.shadowBlur = 4;
    ctxChart.beginPath();
    history.forEach((p, i) => {
      const px = xToPx(p.epoch - plan.startEpoch), py = yToPx(p.actualEtaEpoch);
      if (i === 0) ctxChart.moveTo(px, py); else ctxChart.lineTo(px, py);
    });
    ctxChart.stroke();
    const last = history[history.length - 1];
    ctxChart.shadowBlur = 8; ctxChart.fillStyle = "#7fd4ff";
    ctxChart.beginPath();
    ctxChart.arc(xToPx(last.epoch - plan.startEpoch), yToPx(last.actualEtaEpoch), 3.5, 0, Math.PI * 2);
    ctxChart.fill();
  }
  ctxChart.restore();
}

function updateLiveView() {
  if (!plan) return;
  const nowEpoch = lastEpoch !== null ? lastEpoch : plan.startEpoch;

  if (sumName) sumName.textContent = plan.name;
  if (sumDist) sumDist.textContent = plan.totalDist.toLocaleString() + " m";
  if (sumStart) sumStart.textContent = fmtHMS(plan.startEpoch) + " UTC";

  const elapsedSec = Math.max(0, nowEpoch - plan.startEpoch);
  const si = currentSegmentIndex(elapsedSec, plan.items);
  const seg = plan.items[si];
  if (sumLeg) {
    if (seg.type === "hold") {
      const remain = Math.max(0, seg.cumEnd - elapsedSec);
      sumLeg.textContent = `ROV Deploy/Recovery — ${fmtDur(remain)} remaining`;
    } else {
      const legOrdinal = plan.items.slice(0, si + 1).filter((it) => it.type === "leg").length;
      const totalLegs = plan.items.filter((it) => it.type === "leg").length;
      sumLeg.textContent = `Leg ${legOrdinal} of ${totalLegs} (${seg.speed.toFixed(1)} kt planned)`;
    }
  }

  if (plannedUtcEl) plannedUtcEl.textContent = fmtHMS(plan.plannedEtaEpoch);
  if (plannedLocalEl) plannedLocalEl.textContent = fmtLocal(plan.plannedEtaEpoch);

  const lastActual = history.length ? history[history.length - 1].actualEtaEpoch : null;
  if (actualUtcEl) actualUtcEl.textContent = lastActual !== null ? fmtHMS(lastActual) : "—";
  if (actualLocalEl) actualLocalEl.textContent = lastActual !== null ? fmtLocal(lastActual) : "—";

  const adj = speedAdjustment(nowEpoch);
  if (adjustBadge && adjustIcon && adjustText) {
    if (!adj || adj.state === "waiting") {
      adjustBadge.className = "eta-adjust-badge ok";
      adjustIcon.textContent = "…";
      adjustText.textContent = "Waiting for live speed data…";
    } else if (adj.state === "arrived") {
      adjustBadge.className = "eta-adjust-badge ok";
      adjustIcon.textContent = "✓";
      adjustText.textContent = "Arrived at WP";
    } else if (adj.state === "passed") {
      adjustBadge.className = "eta-adjust-badge up";
      adjustIcon.textContent = "⚠";
      adjustText.innerHTML = `Planned ETA has passed &mdash; <b>${adj.remaining.toFixed(0)} m</b> still remaining`;
    } else if (adj.state === "ok") {
      adjustBadge.className = "eta-adjust-badge ok";
      adjustIcon.textContent = "✓";
      adjustText.textContent = "On schedule — current speed matches what's needed to hit the planned ETA";
    } else if (adj.state === "up") {
      adjustBadge.className = "eta-adjust-badge up";
      adjustIcon.textContent = "▲";
      adjustText.innerHTML = `Speed up by <b>+${adj.delta.toFixed(2)} kt</b> (to ${adj.requiredSpeedKt.toFixed(2)} kt) to hit the planned ETA`;
    } else {
      adjustBadge.className = "eta-adjust-badge down";
      adjustIcon.textContent = "▼";
      adjustText.innerHTML = `You have <b>${Math.abs(adj.delta).toFixed(2)} kt</b> to spare &mdash; could slow to ${adj.requiredSpeedKt.toFixed(2)} kt and still hit the planned ETA`;
    }
  }

  drawChart();
}

/* ======================================================================
   Panel open/close
   ====================================================================== */
export function openPanel() {
  panelOpen = true;
  if (modal) modal.classList.add("open");
  if (plan) {
    updateLiveView();
    requestAnimationFrame(() => { if (plan) drawChart(); });
  }
}
function closePanel() {
  panelOpen = false;
  if (modal) modal.classList.remove("open");
}

if (btnOpen) btnOpen.addEventListener("click", openPanel);
if (btnClose) btnClose.addEventListener("click", closePanel);
if (modal) modal.addEventListener("click", (e) => { if (e.target === modal) closePanel(); });
window.addEventListener("resize", () => { if (panelOpen && plan) drawChart(); });
