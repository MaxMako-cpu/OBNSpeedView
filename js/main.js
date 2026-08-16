/* ======================================================================
   OBN SpeedView — entry point

   Imports every module so their top-level DOM wiring (event listeners,
   render.js's curve-drawer / overlay-renderer registration, etc.) runs
   exactly once, in this fixed order, before the initial render() call
   below. Some modules (report.js, pan-zoom.js, lp-live.js, alt-overlay.js,
   live-data.js, drag-analysis.js) are imported purely for their side
   effects — nothing here consumes their exports directly, but their
   button/canvas wiring must still execute.
   ====================================================================== */
import { state } from './state.js';
import { fmtDate } from './utils.js';
import { loadSpeedCsvText, applySpeedData } from './csv.js';
import { loadLogWorkbook } from './log.js';
import { updateLpAlertButton } from './alerts.js';
import { render, resizeCanvas, updateNodeCount } from './render.js';
import { applyReadoutColors, clearReadout } from './readout.js';
import { refreshRegionHint, renderRegionChips } from './regions.js';
import { showMessageModal, showQuestionModal, setStatus, showToast, updateSampleCount } from './modals.js';
import { getWs, requestLogViaWs } from './websocket.js';
import './pan-zoom.js';
import './report.js';
import './lp-live.js';
import './live-data.js';
import './alt-overlay.js';
import './drag-analysis.js';

const chartWrap    = document.getElementById("chart-wrap");
const regionHintEl = document.getElementById("region-hint");

/* ======================================================================
   Legend series toggles
   ====================================================================== */
document.querySelectorAll(".legend-item").forEach(el=>{
  el.addEventListener("click",()=>{const s=el.getAttribute("data-series"),k=s==="ifr"?"ifr":s==="334"?"u334":"u333";state.visible[k]=!state.visible[k];el.classList.toggle("off",!state.visible[k]);render();});
});

/* ======================================================================
   Speed Data CSV file input
   ====================================================================== */
const fileSpeedInput=document.getElementById("file-speed");
document.getElementById("btn-load-speed").addEventListener("click",()=>fileSpeedInput.click());
fileSpeedInput.addEventListener("change",()=>{
  const file=fileSpeedInput.files[0];fileSpeedInput.value="";if(!file)return;
  const reader=new FileReader();
  reader.onload=()=>{try{const rows=loadSpeedCsvText(reader.result);applySpeedData(rows);renderRegionChips();refreshRegionHint();updateSampleCount();resizeCanvas();render();setStatus(`Loaded ${rows.length.toLocaleString()} samples from ${file.name} — ${fmtDate(state.dayStartEpoch)}`);}catch(err){showMessageModal("error","Error",`Could not read speed CSV:\n${err.message}`);}};
  reader.onerror=()=>showMessageModal("error","Error","Could not read the selected file.");
  reader.readAsText(file);
});

/* ======================================================================
   Online Log file input
   ====================================================================== */
const fileLogInput=document.getElementById("file-log");
const btnUpdateLog=document.getElementById("btn-update-log");

document.getElementById("btn-load-log").addEventListener("click",()=>{
  if(!state.df){showMessageModal("warn","Load Speed Data first","Load the Speed Data CSV before loading the log.");return;}
  fileLogInput.click();
});

fileLogInput.addEventListener("change",()=>{
  const file=fileLogInput.files[0];fileLogInput.value="";if(!file)return;
  btnUpdateLog.disabled=false;
  const reader=new FileReader();
  reader.onload=()=>{
    try{
      state.events=loadLogWorkbook(reader.result,state.dayStartEpoch);
      updateSampleCount(state.events.length);
      render();
      setStatus(`Log: ${state.events.length} events from ${file.name} — ${new Date().toLocaleTimeString()}`);
    }catch(err){showMessageModal("error","Error",`Could not read log file:\n${err.message}`);}
  };
  reader.onerror=()=>{
    btnUpdateLog.disabled=true;
    showToast("Log file changed on disk — please re-select with LOAD LOG");
    setStatus("Log file stale — click LOAD LOG to re-select");
  };
  reader.readAsArrayBuffer(file);
});

btnUpdateLog.addEventListener("click",()=>{
  const ws = getWs();
  if(ws&&ws.readyState===WebSocket.OPEN){
    requestLogViaWs();
  } else {
    showToast("Not connected to bridge — use LOAD LOG to pick file manually");
  }
});

/* ======================================================================
   Select-regions mode, node fixes toggle, clear data
   ====================================================================== */
const btnSelect=document.getElementById("btn-select");
btnSelect.addEventListener("click",()=>{
  state.selectMode=!state.selectMode;btnSelect.classList.toggle("active",state.selectMode);chartWrap.classList.toggle("select-mode",state.selectMode);
  if(state.selectMode){regionHintEl.textContent='Selection mode ON — drag left-to-right on the chart to mark a window.';regionHintEl.classList.add("active");}
  else{regionHintEl.classList.remove("active");refreshRegionHint();}
});

const btnNodeFixes = document.getElementById("btn-node-fixes");
btnNodeFixes.addEventListener("click", () => {
  state.showNodeFixes = !state.showNodeFixes;
  btnNodeFixes.classList.toggle("active", state.showNodeFixes);
  if(!state.showNodeFixes){
    document.getElementById("ro-fix").style.display="none";
    document.getElementById("node-count").style.display="none";
  }
  updateNodeCount();
  render();
  showToast(state.showNodeFixes ? "Node Fixes ON" : "Node Fixes OFF");
});

document.getElementById("btn-clear").addEventListener("click",()=>{
  if(!state.df&&!state.events.length&&!state.regions.length)return;
  showQuestionModal("Clear data","This removes the currently loaded Speed Data, Online Log, and any marked regions. Continue?",()=>{
    state.df=null;state._dfEpochs=null;state.minuteTrack=null;state.dayStartEpoch=null;state.events=[];state.nodeFixes=[];state.regions=[];state.nextRegionId=1;state.viewX0=null;state.viewX1=null;state.hoverEpoch=null;
    const la=state.lpAlert;la.active=false;for(const ch of[la.range333,la.range334,la.decl333,la.decl334])ch.zones=[];
    updateLpAlertButton();if(state.selectMode)btnSelect.click();renderRegionChips();
    regionHintEl.textContent='Click "SELECT REGIONS", then drag on the chart to mark a window for the report.';
    updateSampleCount(0);clearReadout();render();setStatus("Data cleared. Load Speed Data CSV to begin");
  });
});

/* ======================================================================
   Init
   ====================================================================== */
window.addEventListener("load", () => {
  document.getElementById("dot-ifr").style.background = state.colorIfr;
  document.getElementById("dot-334").style.background = state.color334;
  document.getElementById("dot-333").style.background = state.color333;
  applyReadoutColors();
});

resizeCanvas();
render();
