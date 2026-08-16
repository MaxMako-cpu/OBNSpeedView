/* ======================================================================
   OBN SpeedView — canvas chart renderer

   render() is composed via two explicit extension points instead of the
   window.render / window.drawCurveWithPulse monkey-patching the original
   single-file version relied on:
     - setCurveDrawer(fn)     lets lp-live.js swap in a pulse-aware drawer
                              for the u333/u334 curves (falls back to the
                              plain drawCurve below when not set).
     - addOverlayRenderer(fn) lets alt-overlay.js register its mini-chart
                              redraw to run after every main render() call.
   Both are registered once during each module's init(), before the first
   real render() call, so behavior matches the original file exactly.
   ====================================================================== */
import { state } from './state.js';
import { pad2, rgba, nearestIdxByEpoch } from './utils.js';
import { COLOR_LOG } from './constants.js';

export const canvas   = document.getElementById("chart-canvas");
export const ctx      = canvas.getContext("2d");
const chartWrap  = document.getElementById("chart-wrap");
const chartEmpty = document.getElementById("chart-empty");
const MARGIN = { top:16, right:18, bottom:30, left:50 };
let dpr=window.devicePixelRatio||1, cssW=0, cssH=0;

export function resizeCanvas() {
  const rect=chartWrap.getBoundingClientRect();
  cssW=Math.max(rect.width,50); cssH=Math.max(rect.height,50);
  dpr=window.devicePixelRatio||1;
  canvas.width=Math.round(cssW*dpr); canvas.height=Math.round(cssH*dpr);
  canvas.style.width=cssW+"px"; canvas.style.height=cssH+"px";
  ctx.setTransform(dpr,0,0,dpr,0,0);
}
export function plotArea(){return{x0:MARGIN.left,y0:MARGIN.top,x1:cssW-MARGIN.right,y1:cssH-MARGIN.bottom,w:cssW-MARGIN.left-MARGIN.right,h:cssH-MARGIN.top-MARGIN.bottom};}
export function xToPx(epoch,area){const span=state.viewX1-state.viewX0;return span<=0?area.x0:area.x0+((epoch-state.viewX0)/span)*area.w;}
export function pxToX(px,area){return state.viewX0+((px-area.x0)/area.w)*(state.viewX1-state.viewX0);}

// Uses state._visYMax (set by drawGrid each frame) so curves track the same
// scale as the axis labels; falls back to state.yMax before the first grid draw.
export function yToPx(val, area) {
  const ym = (state._visYMax && state._visYMax > 0) ? state._visYMax : (state.yMax || 1);
  return area.y1 - ((val - 0) / (ym - 0)) * area.h;
}

function computeVisibleYMax(area) {
  // Compute yMax from data visible in current viewport
  if (!state.minuteTrack || !state.minuteTrack.length) return state.yMax;
  let max = -Infinity;
  for (const p of state.minuteTrack) {
    if (p.epoch < state.viewX0 || p.epoch > state.viewX1) continue;
    for (const k of ["ifr","u334","u333"]) {
      const v = p[k];
      if (v !== null && Number.isFinite(v) && state.visible[k] && v > max) max = v;
    }
  }
  return Number.isFinite(max) && max > 0 ? max * 1.15 : state.yMax;
}

function drawGrid(area) {
  ctx.save();
  // Use visible yMax so scale tracks zoom
  const visYMax = computeVisibleYMax(area);
  const step = visYMax > 6 ? Math.ceil(visYMax / 6) : (visYMax > 2 ? 1 : 0.5);
  ctx.strokeStyle="rgba(23,48,73,0.55)"; ctx.lineWidth=1;
  ctx.fillStyle="#6f8aa3"; ctx.font="10px 'JetBrains Mono',monospace";
  ctx.textAlign="right"; ctx.textBaseline="middle";
  // Override yToPx for this frame using visYMax
  const yToPxVis = v => area.y1 - ((v - 0) / (visYMax - 0 || 1)) * area.h;
  for (let v = 0; v <= visYMax; v += step) {
    const py = yToPxVis(v);
    ctx.beginPath(); ctx.moveTo(area.x0, py); ctx.lineTo(area.x1, py); ctx.stroke();
    ctx.fillText(v.toFixed(step < 1 ? 1 : 0), area.x0 - 8, py);
  }
  if (state.dayStartEpoch !== null) {
    ctx.textAlign="center"; ctx.textBaseline="top";
    for (let h = 0; h < 24; h++) {
      const ep = state.dayStartEpoch + h * 3600;
      if (ep < state.viewX0 - 1 || ep > state.viewX1 + 1) continue;
      const px = xToPx(ep, area);
      ctx.beginPath(); ctx.moveTo(px, area.y0); ctx.lineTo(px, area.y1); ctx.stroke();
      ctx.fillText(pad2(h)+":00", px, area.y1 + 6);
    }
  }
  ctx.save(); ctx.translate(14, area.y0 + area.h / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillStyle="#6f8aa3"; ctx.font="9.5px 'JetBrains Mono',monospace";
  ctx.textAlign="center"; ctx.textBaseline="middle";
  ctx.fillText("SPEED OVER GROUND (KNOTS)", 0, 0); ctx.restore();
  ctx.restore();
  // Store visYMax so curves use the same scale
  state._visYMax = visYMax;
}

// ── Catmull-Rom spline stroke helper ─────────────────────────────────
// pts: array of [x, y]. Draws a smooth curve through all points.
export function catmullRomStroke(ctx, pts, tension = 0.5) {
  if (pts.length < 2) return;
  if (pts.length === 2) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    ctx.lineTo(pts[1][0], pts[1][1]);
    ctx.stroke();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(i - 1, 0)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(i + 2, pts.length - 1)];
    const cp1x = p1[0] + (p2[0] - p0[0]) * tension / 3;
    const cp1y = p1[1] + (p2[1] - p0[1]) * tension / 3;
    const cp2x = p2[0] - (p3[0] - p1[0]) * tension / 3;
    const cp2y = p2[1] - (p3[1] - p1[1]) * tension / 3;
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2[0], p2[1]);
  }
  ctx.stroke();
}

export function catmullRomPath(ctx, pts, tension = 0.5) {
  if (pts.length < 2) return;
  ctx.moveTo(pts[0][0], pts[0][1]);
  if (pts.length === 2) { ctx.lineTo(pts[1][0], pts[1][1]); return; }
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(i - 1, 0)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(i + 2, pts.length - 1)];
    const cp1x = p1[0] + (p2[0] - p0[0]) * tension / 3;
    const cp1y = p1[1] + (p2[1] - p0[1]) * tension / 3;
    const cp2x = p2[0] - (p3[0] - p1[0]) * tension / 3;
    const cp2y = p2[1] - (p3[1] - p1[1]) * tension / 3;
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2[0], p2[1]);
  }
}

export function drawCurve(points,key,color,area){
  const segs=[];let cur=[];
  for(const p of points){const v=p[key];if(v===null||!Number.isFinite(v)){if(cur.length>1)segs.push(cur);cur=[];continue;}cur.push([xToPx(p.epoch,area),yToPx(v,area)]);}
  if(cur.length>1)segs.push(cur);if(!segs.length)return;
  ctx.save();ctx.lineJoin="round";ctx.lineCap="round";
  // Glow pass
  ctx.shadowColor=rgba(color,0.85);ctx.shadowBlur=9;ctx.strokeStyle=rgba(color,0.55);ctx.lineWidth=1.6;
  for(const s of segs){catmullRomStroke(ctx,s);}
  // Core line
  ctx.shadowBlur=0;ctx.strokeStyle=color;ctx.lineWidth=1.0;
  for(const s of segs){catmullRomStroke(ctx,s);}
  ctx.restore();
}

function drawLogMarkers(area){
  if(!state.events||!state.events.length)return;
  if(state.showNodeFixes)return; // hidden when node fixes active
  ctx.save();
  for(const ev of state.events){if(ev.epoch<state.viewX0||ev.epoch>state.viewX1)continue;const px=xToPx(ev.epoch,area);ctx.beginPath();ctx.setLineDash([2,3]);ctx.strokeStyle=rgba(COLOR_LOG,0.5);ctx.lineWidth=1;ctx.moveTo(px,area.y0);ctx.lineTo(px,area.y1);ctx.stroke();}
  ctx.setLineDash([]);ctx.restore();
}

function drawNodeFixMarkers(area){
  if(!state.showNodeFixes||!state.nodeFixes.length)return;
  ctx.save();
  for(const fix of state.nodeFixes){
    if(fix.epoch<state.viewX0||fix.epoch>state.viewX1)continue;
    const px=xToPx(fix.epoch,area);
    const color=fix.uhd==="UHD333"?state.color333:state.color334;
    ctx.beginPath();ctx.setLineDash([2,3]);
    ctx.strokeStyle=rgba(color,0.6);ctx.lineWidth=1.2;
    ctx.moveTo(px,area.y0);ctx.lineTo(px,area.y1);ctx.stroke();
  }
  ctx.setLineDash([]);ctx.restore();
}

export function updateNodeCount(){
  const el=document.getElementById("node-count");
  if(!state.showNodeFixes){el.style.display="none";return;}
  const fixes=state.nodeFixes;
  const n333=fixes.filter(f=>f.uhd==="UHD333").length;
  const n334=fixes.filter(f=>f.uhd==="UHD334").length;
  el.style.display="flex";
  // Rebuild inner content
  let inner = document.getElementById("node-count-inner");
  if (!inner) {
    inner = document.createElement("div");
    inner.id = "node-count-inner";
    el.appendChild(inner);
    // ResizeObserver — scale font proportionally to box width
    new ResizeObserver(() => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const size = Math.max(9, Math.min(w * 0.09, h * 0.28));
      inner.style.fontSize = size + "px";
    }).observe(el);
  }
  inner.innerHTML =
    `<span style="color:${state.color333}" class="nc-val">UHD333 </span>` +
    `<span class="nc-val" style="color:${state.color333}">${n333}</span>` +
    `<br>` +
    `<span style="color:${state.color334}" class="nc-val">UHD334 </span>` +
    `<span class="nc-val" style="color:${state.color334}">${n334}</span>` +
    `<br>` +
    `<span class="nc-total">TOTAL ${n333+n334}</span>`;
  // Trigger resize to set initial font size
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const size = Math.max(9, Math.min(w * 0.09, h * 0.28));
  inner.style.fontSize = size + "px";
}

function drawSavedRegions(area){
  ctx.save();
  for(const r of state.regions){const x0=xToPx(Math.max(r.start,state.viewX0),area),x1=xToPx(Math.min(r.end,state.viewX1),area);if(x1<area.x0||x0>area.x1)continue;ctx.fillStyle="rgba(255,180,84,0.10)";ctx.fillRect(x0,area.y0,x1-x0,area.h);ctx.strokeStyle="rgba(255,180,84,0.55)";ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x0,area.y0);ctx.lineTo(x0,area.y1);ctx.moveTo(x1,area.y0);ctx.lineTo(x1,area.y1);ctx.stroke();}
  ctx.restore();
}

// Draw one alert channel's zones with its own color and opacity
function drawAlertChannel(channel, opacity, area) {
  if (!channel.enabled || !channel.zones.length) return;
  ctx.fillStyle = rgba(channel.color, opacity);
  for (const z of channel.zones) {
    const x0=xToPx(Math.max(z.start,state.viewX0),area);
    const x1=xToPx(Math.min(z.end,state.viewX1),area);
    if (x1<area.x0||x0>area.x1||x1<=x0) continue;
    ctx.fillRect(x0,area.y0,x1-x0,area.h);
  }
  ctx.strokeStyle=rgba(channel.color,Math.min(opacity+0.2,1));
  ctx.lineWidth=1;
  for (const z of channel.zones) {
    const x0=xToPx(Math.max(z.start,state.viewX0),area);
    const x1=xToPx(Math.min(z.end,state.viewX1),area);
    if (x1<area.x0||x0>area.x1) continue;
    ctx.beginPath();ctx.moveTo(x0,area.y0);ctx.lineTo(x0,area.y1);ctx.moveTo(x1,area.y0);ctx.lineTo(x1,area.y1);ctx.stroke();
  }
}

function drawLpAlertZones(area) {
  if (!state.lpAlert.active) return;
  const la=state.lpAlert;
  ctx.save();
  // LP Range zones — opacity 0.28
  drawAlertChannel(la.range333, 0.28, area);
  drawAlertChannel(la.range334, 0.28, area);
  // LP Declination zones — opacity 0.22 (slightly lower so they read as secondary)
  drawAlertChannel(la.decl333, 0.22, area);
  drawAlertChannel(la.decl334, 0.22, area);
  ctx.restore();
}

function drawDragRegion(area){
  if(state.dragStart===null||state.dragCurrent===null)return;
  const x0e=Math.min(state.dragStart,state.dragCurrent),x1e=Math.max(state.dragStart,state.dragCurrent);
  const x0=xToPx(x0e,area),x1=xToPx(x1e,area);
  ctx.save();ctx.fillStyle="rgba(127,212,255,0.14)";ctx.fillRect(x0,area.y0,x1-x0,area.h);ctx.strokeStyle="#7fd4ff";ctx.lineWidth=1;ctx.shadowColor="rgba(127,212,255,0.7)";ctx.shadowBlur=6;ctx.beginPath();ctx.moveTo(x0,area.y0);ctx.lineTo(x0,area.y1);ctx.moveTo(x1,area.y0);ctx.lineTo(x1,area.y1);ctx.stroke();ctx.restore();
}

function drawHoverCrosshair(area){
  if(state.hoverEpoch===null||state.hoverEpoch<state.viewX0||state.hoverEpoch>state.viewX1)return;
  const px=xToPx(state.hoverEpoch,area);
  ctx.save();ctx.strokeStyle="rgba(216,230,242,0.5)";ctx.setLineDash([4,4]);ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(px,area.y0);ctx.lineTo(px,area.y1);ctx.stroke();ctx.setLineDash([]);ctx.restore();
  if(state.minuteTrack){
    const idx=nearestIdxByEpoch(state.minuteTrack.map(p=>p.epoch),state.hoverEpoch);
    if(idx!==null){const row=state.minuteTrack[idx];const px2=xToPx(row.epoch,area);for(const[key,color,vis]of[["ifr",state.colorIfr,state.visible.ifr],["u334",state.color334,state.visible.u334],["u333",state.color333,state.visible.u333]]){const v=row[key];if(!vis||v===null||!Number.isFinite(v))continue;const py=yToPx(v,area);ctx.save();ctx.shadowColor=rgba(color,0.9);ctx.shadowBlur=10;ctx.fillStyle="#050a12";ctx.strokeStyle=color;ctx.lineWidth=2;ctx.beginPath();ctx.arc(px2,py,4.5,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.restore();}}
  }
}

// ── Extension points (replace the original's window.render / window.drawCurveWithPulse monkey-patching) ──
let curveDrawer = drawCurve;
export function setCurveDrawer(fn) { curveDrawer = fn; }

const overlayRenderers = [];
export function addOverlayRenderer(fn) { overlayRenderers.push(fn); }

export function render(){
  if(!cssW||!cssH)resizeCanvas();
  ctx.clearRect(0,0,cssW,cssH);
  if(!state.minuteTrack){
    chartEmpty.classList.remove("hidden");
  } else {
    chartEmpty.classList.add("hidden");
    const area=plotArea();
    ctx.save();ctx.beginPath();ctx.rect(area.x0,area.y0,area.w,area.h);ctx.clip();
    drawSavedRegions(area);
    drawLpAlertZones(area);
    drawLogMarkers(area);
    drawNodeFixMarkers(area);
    if(state.visible.u334)curveDrawer(state.minuteTrack,"u334",state.color334,area);
    if(state.visible.u333)curveDrawer(state.minuteTrack,"u333",state.color333,area);
    if(state.visible.ifr) drawCurve(state.minuteTrack,"ifr",state.colorIfr,area);
    drawDragRegion(area);drawHoverCrosshair(area);
    ctx.restore();drawGrid(area);
  }
  for (const fn of overlayRenderers) fn();
}

window.addEventListener("resize",()=>{resizeCanvas();render();});
