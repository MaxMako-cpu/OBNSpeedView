/* ======================================================================
   OBN SpeedView — LP LIVE Monitor (live-mode LP range pulse + speed-up overlay)
   ====================================================================== */
import { state } from './state.js';
import { render, ctx, xToPx, yToPx, catmullRomStroke, drawCurve, setCurveDrawer } from './render.js';
import { isLiveMode } from './websocket.js';
import { showMessageModal, setStatus, showToast } from './modals.js';

const speedupOverlay = document.getElementById("speedup-overlay");
const btnLpLive      = document.getElementById("btn-lp-live");
const modalLpLive    = document.getElementById("modal-lp-live");

// Pulse animation — runs continuously when lp live is enabled
let _lpLivePulseRaf = null;
let _lpLivePulseVal = 0; // 0..1

function _lpLivePulseLoop() {
  _lpLivePulseVal = (Date.now() % 1200) / 1200; // 1.2s cycle
  render(); // re-render with current pulse value
  _lpLivePulseRaf = requestAnimationFrame(_lpLivePulseLoop);
}

function _startLpLivePulse() {
  if (!_lpLivePulseRaf) _lpLivePulseLoop();
}
export function _stopLpLivePulse() {
  if (_lpLivePulseRaf) { cancelAnimationFrame(_lpLivePulseRaf); _lpLivePulseRaf = null; }
  // Final render without pulse
  render();
}

export function updateSpeedupOverlay() {
  const lp = state.lpLive;
  const bothAlert = lp.alert333 && lp.alert334;
  if (bothAlert && lp.enabled && isLiveMode()) {
    speedupOverlay.style.display = "flex";
  } else {
    speedupOverlay.style.display = "none";
  }
}

export function updateLpLiveButton() {
  const lp = state.lpLive;
  btnLpLive.classList.toggle("active", lp.enabled);
  if (lp.enabled) {
    btnLpLive.textContent = `LP LIVE  ·  <${lp.threshold}m`;
  } else {
    btnLpLive.textContent = "LP LIVE";
  }
}

// Called on every live row — checks LP range values
export function checkLpLive(row) {
  const lp = state.lpLive;
  if (!lp.enabled || !isLiveMode()) return;

  // IFR speed suppress: if IFR SOG >= ifrSpeedThreshold (and threshold > 0), silence all alerts
  if (lp.ifrSpeedThreshold > 0) {
    const ifrSog = row["IFR SOG (knot)"];
    if (ifrSog !== null && Number.isFinite(ifrSog) && ifrSog >= lp.ifrSpeedThreshold) {
      lp.alert333 = false;
      lp.alert334 = false;
      updateSpeedupOverlay();
      return;
    }
  }

  const r333 = row["TMS333_LP Range (m)"];
  const r334 = row["TMS334_LP Range (m)"];
  if (r333 !== null && Number.isFinite(r333)) lp.alert333 = r333 < lp.threshold;
  if (r334 !== null && Number.isFinite(r334)) lp.alert334 = r334 < lp.threshold;

  updateSpeedupOverlay();
}

// Pulse-aware curve drawer, registered as render.js's active curve drawer below.
function drawCurveWithPulse(points, key, color, area) {
  const lp = state.lpLive;
  let needsPulse = false;
  if (lp.enabled && isLiveMode()) {
    if (key === "u333" && lp.alert333) needsPulse = true;
    if (key === "u334" && lp.alert334) needsPulse = true;
  }

  if (!needsPulse) {
    drawCurve(points, key, color, area);
    return;
  }

  // Aggressive pulse: sine 0..1
  const sine = 0.5 - 0.5 * Math.cos(_lpLivePulseVal * 2 * Math.PI);

  const segs = [];
  let cur = [];
  for (const p of points) {
    const v = p[key];
    if (v === null || !Number.isFinite(v)) { if (cur.length > 1) segs.push(cur); cur = []; continue; }
    cur.push([xToPx(p.epoch, area), yToPx(v, area)]);
  }
  if (cur.length > 1) segs.push(cur);
  if (!segs.length) return;

  const drawSegs = () => {
    for (const s of segs) { catmullRomStroke(ctx, s); }
  };

  ctx.save();
  ctx.lineJoin = "round"; ctx.lineCap = "round";

  // Pass 1 — wide soft halo (very thick, very transparent)
  ctx.globalAlpha = 0.12 + sine * 0.30;  // 0.12..0.42
  ctx.strokeStyle = color;
  ctx.lineWidth   = 12 + sine * 14;       // thinner halo: 12..26px
  ctx.shadowColor = color;
  ctx.shadowBlur  = 0;
  ctx.filter      = `blur(${3 + sine * 6}px)`;
  drawSegs();

  // Pass 2 — medium glow ring
  ctx.filter      = "none";
  ctx.globalAlpha = 0.35 + sine * 0.45;  // 0.35..0.80
  ctx.strokeStyle = color;
  ctx.lineWidth   = 4 + sine * 5;         // thinner: 4..9
  ctx.shadowColor = color;
  ctx.shadowBlur  = 20 + sine * 30;       // glow stays bright: 20..50
  drawSegs();

  // Pass 3 — crisp core line
  ctx.shadowBlur  = 6 + sine * 14;
  ctx.globalAlpha = 1;
  ctx.strokeStyle = color;
  ctx.lineWidth   = 1.5;
  drawSegs();

  ctx.restore();
}
setCurveDrawer(drawCurveWithPulse);

// Modal wiring
btnLpLive.addEventListener("click", () => {
  document.getElementById("lp-live-threshold").value = state.lpLive.threshold;
  document.getElementById("lp-live-ifr-threshold").value = state.lpLive.ifrSpeedThreshold || 0;
  modalLpLive.classList.add("open");
});
document.getElementById("lp-live-cancel").addEventListener("click", () => modalLpLive.classList.remove("open"));
modalLpLive.addEventListener("click", e => { if (e.target === modalLpLive) modalLpLive.classList.remove("open"); });

document.getElementById("lp-live-disable").addEventListener("click", () => {
  state.lpLive.enabled  = false;
  state.lpLive.alert333 = false;
  state.lpLive.alert334 = false;
  _stopLpLivePulse();
  updateSpeedupOverlay();
  updateLpLiveButton();
  modalLpLive.classList.remove("open");
  setStatus("LP Live monitor disabled.");
});

document.getElementById("lp-live-ok").addEventListener("click", () => {
  const thr = parseFloat(document.getElementById("lp-live-threshold").value);
  if (!Number.isFinite(thr) || thr < 0) { showMessageModal("warn", "Invalid threshold", "Enter a valid positive number."); return; }
  const ifrThr = parseFloat(document.getElementById("lp-live-ifr-threshold").value) || 0;
  state.lpLive.threshold = thr;
  state.lpLive.ifrSpeedThreshold = ifrThr;
  state.lpLive.enabled   = true;
  state.lpLive.alert333  = false;
  state.lpLive.alert334  = false;
  _startLpLivePulse();
  updateLpLiveButton();
  modalLpLive.classList.remove("open");
  const ifrNote = ifrThr > 0 ? `  ·  suppress ≥${ifrThr}kn` : "";
  setStatus(`LP Live monitor active — threshold ${thr} m${ifrNote}`);
  showToast(`LP Live ON — ${thr} m${ifrNote}`);
});
