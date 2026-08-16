/* ======================================================================
   OBN SpeedView — Altimeter mini-overlays + draggable/resizable panels
   ====================================================================== */
import { state } from './state.js';
import { catmullRomPath, catmullRomStroke, addOverlayRenderer } from './render.js';

// ── Altimeter mini-overlays ───────────────────────────────────────────
const ALT_WINDOW = 5 * 60; // 5 minutes in seconds

function drawAltOverlay(canvasId, valueId, titleId, field, color, cursorEpoch) {
  const cv  = document.getElementById(canvasId);
  const val = document.getElementById(valueId);
  const ttl = document.getElementById(titleId);
  if (!cv) return;

  cv.parentElement.style.borderColor = color + "44";
  ttl.style.color = color;

  const ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);

  if (!state.df || !state.df.length) {
    val.textContent = "—";
    val.style.color = "var(--text-dim)";
    return;
  }

  const lastEpoch = state.df[state.df.length - 1].epoch;
  const center = (cursorEpoch !== null && cursorEpoch !== undefined) ? cursorEpoch : lastEpoch;
  const t0 = center - ALT_WINDOW / 2;
  const t1 = center + ALT_WINDOW / 2;

  const pts = state.df.filter(r => r.epoch >= t0 && r.epoch <= t1 && r[field] !== null && Number.isFinite(r[field]));

  if (!pts.length) {
    val.textContent = "—";
    val.style.color = "var(--text-dim)";
    ctx.strokeStyle = "rgba(23,48,73,0.6)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 2; i++) {
      const y = Math.round(H * i / 2) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    return;
  }

  let yMin = Infinity, yMax = -Infinity;
  for (const p of pts) { if (p[field] < yMin) yMin = p[field]; if (p[field] > yMax) yMax = p[field]; }
  const yRange = Math.max(yMax - yMin, 5) || 5;  // minimum 5m range
  const pad = yRange * 0.12;
  const ya = yMin - pad, yb = yMax + pad;

  const xScale = W / (t1 - t0);
  const yScale = H / (yb - ya);
  const toX = e => (e - t0) * xScale;
  const toY = v => H - (v - ya) * yScale;

  // Grid
  ctx.strokeStyle = "rgba(23,48,73,0.7)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 2; i++) {
    const y = Math.round(H * i / 2) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  // Center cursor line
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(toX(center), 0); ctx.lineTo(toX(center), H); ctx.stroke();
  ctx.setLineDash([]);

  // Glow fill — Catmull-Rom path for smooth fill
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, color + "33");
  grad.addColorStop(1, color + "00");
  const altPts = pts.map(p => [toX(p.epoch), toY(p[field])]);
  ctx.beginPath();
  ctx.moveTo(toX(pts[0].epoch), H);
  catmullRomPath(ctx, altPts);
  ctx.lineTo(toX(pts[pts.length-1].epoch), H);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line — Catmull-Rom smooth
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  catmullRomStroke(ctx, altPts);

  // Closest value to cursor
  let closest = pts[0], minDist = Math.abs(pts[0].epoch - center);
  for (const p of pts) {
    const d = Math.abs(p.epoch - center);
    if (d < minDist) { minDist = d; closest = p; }
  }
  const v = closest[field];
  val.textContent = Number.isFinite(v) ? v.toFixed(1) + " m" : "—";
  val.style.color = color;
}

export function renderAltOverlays() {
  const cursor = state.hoverEpoch;
  drawAltOverlay("alt-canvas-334","alt-value-334","alt-title-334","UHD334 Altimeter (m)",state.color334,cursor);
  drawAltOverlay("alt-canvas-333","alt-value-333","alt-title-333","UHD333 Altimeter (m)",state.color333,cursor);
}

// Registered to run after every main render() (replaces the original's
// window.render monkey-patching — see render.js's addOverlayRenderer).
addOverlayRenderer(renderAltOverlays);

const chartCanvas = document.getElementById("chart-canvas");
if (chartCanvas) {
  chartCanvas.addEventListener("mousemove", () => renderAltOverlays());
  chartCanvas.addEventListener("mouseleave", () => renderAltOverlays());
}

window.addEventListener("load", () => {
  renderAltOverlays();
});

// ── Alt overlay drag & resize ─────────────────────────────────────────
function makeDraggable(el) {
  let ox=0, oy=0, sx=0, sy=0, dragging=false;

  // Save/restore position from localStorage
  const key = "sv_alt_pos_" + el.id;
  const saved = localStorage.getItem(key);
  if (saved) {
    try {
      const {top,left,width,height} = JSON.parse(saved);
      el.style.top    = top;
      el.style.left   = left;
      el.style.right  = "";
      if (width)  el.style.width  = width;
      if (height) el.style.height = height;
    } catch(e) {}
  }

  function savePos() {
    localStorage.setItem(key, JSON.stringify({
      top:    el.style.top,
      left:   el.style.left,
      width:  el.style.width,
      height: el.style.height
    }));
  }

  el.addEventListener("mousedown", e => {
    // Ignore resize handle (bottom-right corner ~16px)
    const r = el.getBoundingClientRect();
    if (e.clientX > r.right - 18 && e.clientY > r.bottom - 18) return;
    dragging = true;
    ox = e.clientX; oy = e.clientY;
    sx = el.offsetLeft; sy = el.offsetTop;
    el.style.cursor = "grabbing";
    el.style.right = "";
    e.preventDefault();
  });

  document.addEventListener("mousemove", e => {
    if (!dragging) return;
    const dx = e.clientX - ox, dy = e.clientY - oy;
    const parent = el.parentElement;
    const pr = parent.getBoundingClientRect();
    let nx = sx + dx, ny = sy + dy;
    // Clamp inside parent
    nx = Math.max(0, Math.min(nx, pr.width  - el.offsetWidth));
    ny = Math.max(0, Math.min(ny, pr.height - el.offsetHeight));
    el.style.left = nx + "px";
    el.style.top  = ny + "px";
  });

  document.addEventListener("mouseup", e => {
    if (!dragging) return;
    dragging = false;
    el.style.cursor = "grab";
    savePos();
  });

  // Watch resize via ResizeObserver
  new ResizeObserver(() => {
    savePos();
    // Sync canvas resolution to display size
    const cv = el.querySelector("canvas");
    if (cv) {
      const rect = cv.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        cv.width  = Math.round(rect.width);
        cv.height = Math.round(rect.height);
      }
    }
    renderAltOverlays();
  }).observe(el);
}

window.addEventListener("load", () => {
  ["alt-overlay-334", "alt-overlay-333", "node-count"].forEach(id => {
    const el = document.getElementById(id);
    if (el) makeDraggable(el);
  });
});
