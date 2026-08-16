/* ======================================================================
   OBN SpeedView — region management (report time-window selection)
   ====================================================================== */
import { state } from './state.js';
import { fmtHMS } from './utils.js';
import { render } from './render.js';

const regionChipsEl=document.getElementById("region-chips");
const regionHintEl=document.getElementById("region-hint");

export function createRegion(x0,x1){const id=state.nextRegionId++;state.regions.push({id,start:x0,end:x1});renderRegionChips();refreshRegionHint();}
export function removeRegion(id){state.regions=state.regions.filter(r=>r.id!==id);renderRegionChips();refreshRegionHint();render();}
export function renderRegionChips(){
  regionChipsEl.innerHTML="";
  state.regions.forEach((r,i)=>{
    const chip=document.createElement("div");chip.className="chip";chip.innerHTML=`<span>#${i+1}  ${fmtHMS(r.start)}–${fmtHMS(r.end)}</span>`;
    const btn=document.createElement("button");btn.textContent="✕";btn.addEventListener("click",()=>removeRegion(r.id));
    chip.appendChild(btn);regionChipsEl.appendChild(chip);
  });
}
export function refreshRegionHint(){
  if(state.selectMode)return;
  regionHintEl.textContent=state.regions.length>0?`${state.regions.length} region(s) marked. Click "GENERATE REPORT" to build the PDF.`:'Click "SELECT REGIONS", then drag on the chart to mark a window for the report.';
  regionHintEl.classList.remove("active");
}
