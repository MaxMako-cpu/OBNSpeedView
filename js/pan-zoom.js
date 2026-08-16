/* ======================================================================
   OBN SpeedView — mouse pan/zoom interaction, view-window ownership
   ====================================================================== */
import { state } from './state.js';
import { fmtHMS } from './utils.js';
import { canvas, render, plotArea, xToPx, pxToX, resizeCanvas } from './render.js';
import { getBucketSec, buildTrack } from './csv.js';
import { createRegion } from './regions.js';
import { updateReadout, clearReadout } from './readout.js';
import { setStatus, showToast } from './modals.js';
import { isLiveMode } from './websocket.js';

let isPanning=false,panStartPx=null,panStartViewX0=null,panStartViewX1=null;
let _userPanned=false; // when true, suppress live auto-scroll
let _lastInteractionTime=0; // timestamp of last user pan/zoom
const RECENTER_DELAY = 3 * 60 * 1000; // 3 minutes in ms

let _scrollLocked = false; // when true: user can pan/zoom freely, no auto-recenter ever

export function getUserPanned() { return _userPanned; }
export function setUserPanned(v) { _userPanned = v; }
export function isScrollLocked() { return _scrollLocked; }

// Auto-recenter: fires every 10s, recenter if idle > 3min
setInterval(() => {
  if (!isLiveMode() || !_userPanned || !state.df || !state.df.length) return;
  if (_scrollLocked) return; // scroll lock active — never recenter
  if (Date.now() - _lastInteractionTime < RECENTER_DELAY) return;
  // Recenter: keep current zoom span, place latest data at ~75% from left
  // so there's room on right for incoming data — matches "фото 2" look
  const latestEpoch = state.df[state.df.length - 1].epoch;
  const span = state.viewX1 - state.viewX0;
  state.viewX0 = latestEpoch - span * 0.75;
  state.viewX1 = latestEpoch + span * 0.25;
  _userPanned = false; // resume autoscroll from this position
  render();
  setStatus(`LIVE  ·  ${fmtHMS(latestEpoch)}  ·  ${state.df.length.toLocaleString()} samples today`);
}, 10000);

function _markInteraction() {
  _lastInteractionTime = Date.now();
}
function clientXToEpoch(cx){return pxToX(cx-canvas.getBoundingClientRect().left,plotArea());}

canvas.addEventListener("mousedown",(e)=>{
  if(!state.minuteTrack)return;
  if(state.selectMode){state.dragStart=clientXToEpoch(e.clientX);state.dragCurrent=state.dragStart;}
  else{isPanning=true;panStartPx=e.clientX;panStartViewX0=state.viewX0;panStartViewX1=state.viewX1;}
});

window.addEventListener("mousemove",(e)=>{
  if(!state.minuteTrack)return;
  const rect=canvas.getBoundingClientRect();
  const inside=e.clientX>=rect.left&&e.clientX<=rect.right&&e.clientY>=rect.top&&e.clientY<=rect.bottom;
  if(state.dragStart!==null){state.dragCurrent=clientXToEpoch(e.clientX);render();return;}
  if(isPanning){
    const area=plotArea(),span=panStartViewX1-panStartViewX0;
    const dxE=((e.clientX-panStartPx)/area.w)*span;
    let nx0=panStartViewX0-dxE,nx1=panStartViewX1-dxE;
    if(state.dayStartEpoch!==null){const lo=state.dayStartEpoch-60,hi=state.dayStartEpoch+86460;if(nx0<lo){nx1+=(lo-nx0);nx0=lo;}if(nx1>hi){nx0-=(nx1-hi);nx1=hi;}}
    state.viewX0=nx0;state.viewX1=nx1;render();return;
  }
  if(inside&&!state.selectMode){state.hoverEpoch=clientXToEpoch(e.clientX);updateReadout(state.hoverEpoch);render();}
  else if(!inside&&state.hoverEpoch!==null){state.hoverEpoch=null;clearReadout();render();}
});

window.addEventListener("mouseup",()=>{
  if(state.dragStart!==null){
    const x0=Math.min(state.dragStart,state.dragCurrent),x1=Math.max(state.dragStart,state.dragCurrent);
    state.dragStart=null;state.dragCurrent=null;
    if(x1-x0>=2)createRegion(x0,x1);render();
  }
  if(isPanning){ _userPanned=true; _markInteraction(); }
  isPanning=false;
});

canvas.addEventListener("wheel",(e)=>{
  if(!state.minuteTrack)return;e.preventDefault();
  const area=plotArea(),anchor=pxToX(e.clientX-canvas.getBoundingClientRect().left,area);
  const zf=e.deltaY>0?1.15:1/1.15;
  let span=Math.max(30,Math.min(86520,(state.viewX1-state.viewX0)*zf));
  const ratio=(anchor-state.viewX0)/(state.viewX1-state.viewX0||1);
  let nx0=anchor-ratio*span,nx1=nx0+span;
  if(state.dayStartEpoch!==null){const lo=state.dayStartEpoch-60,hi=state.dayStartEpoch+86460;if(nx0<lo){nx1+=(lo-nx0);nx0=lo;}if(nx1>hi){nx0-=(nx1-hi);nx1=hi;}}
  _userPanned=true; _markInteraction();
  state.viewX0=nx0;state.viewX1=nx1;
  // AGAGA: rebuild track if bucket resolution changed
  if(state.df&&state.df.length&&state.dayStartEpoch!==null){
    const newBucket=getBucketSec(state.viewX1-state.viewX0);
    if(newBucket!==state.currentBucket){state.currentBucket=newBucket;state.minuteTrack=buildTrack(state.df,state.dayStartEpoch,newBucket);}
  }
  render();
},{passive:false});

document.getElementById("btn-reset-zoom").addEventListener("click",()=>{if(state.dayStartEpoch===null)return;state.viewX0=state.dayStartEpoch;state.viewX1=state.dayStartEpoch+86400-1;_userPanned=false;render();});

// ── SCROLL lock button ─────────────────────────────────────────────────
const btnScroll = document.getElementById("btn-scroll");
btnScroll.addEventListener("click", () => {
  _scrollLocked = !_scrollLocked;
  btnScroll.classList.toggle("active", _scrollLocked);
  btnScroll.style.color = _scrollLocked ? "var(--cyan)" : "";
  if (_scrollLocked) {
    _userPanned = true; // freeze autoscroll immediately
    showToast("Scroll locked — free pan & zoom");
  } else {
    _userPanned = false; // re-enable autoscroll
    showToast("Scroll unlocked — auto-follow resumed");
  }
});
