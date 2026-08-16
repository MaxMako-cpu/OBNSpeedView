/* ======================================================================
   OBN SpeedView — region report modal + PDF generation
   ====================================================================== */
import { state } from './state.js';
import { fmtHMS, fmtHM, fmtDate } from './utils.js';
import { showMessageModal, setStatus } from './modals.js';
import { fitRowsForBeacon, beaconConfig, getForceInputs } from './drag-analysis.js';

// window.jspdf is loaded globally via <script> from CDN.

/* ======================================================================
   Report panel definitions
   ====================================================================== */
const REPORT_C_IFR="#c026d3",REPORT_C_COG="#0284c7",REPORT_C_333="#dc2626",REPORT_C_334="#16a34a";
const REPORT_SINGLE_PANELS={sog_333:{title:"UHD333 · Speed Over Ground",ylabel:"SOG (knots)",field:"UHD333 SOG (knot)",color:REPORT_C_333},sog_334:{title:"UHD334 · Speed Over Ground",ylabel:"SOG (knots)",field:"UHD334 SOG (knot)",color:REPORT_C_334},depth_333:{title:"UHD333 · Depth",ylabel:"Depth (m)",field:"UHD333 Depth (m)",color:REPORT_C_333},depth_334:{title:"UHD334 · Depth",ylabel:"Depth (m)",field:"UHD334 Depth (m)",color:REPORT_C_334},alt_333:{title:"UHD333 · Altimeter",ylabel:"Altimeter (m)",field:"UHD333 Altimeter (m)",color:REPORT_C_333},alt_334:{title:"UHD334 · Altimeter",ylabel:"Altimeter (m)",field:"UHD334 Altimeter (m)",color:REPORT_C_334},lp_range_333:{title:"UHD333 · LP Range",ylabel:"Range (m)",field:"TMS333_LP Range (m)",color:REPORT_C_333},lp_range_334:{title:"UHD334 · LP Range",ylabel:"Range (m)",field:"TMS334_LP Range (m)",color:REPORT_C_334},lp_vdist_333:{title:"UHD333 · LP Vertical Distance",ylabel:"Vert. Dist. (m)",field:"TMS333_LP Vertical distance (m)",color:REPORT_C_333},lp_vdist_334:{title:"UHD334 · LP Vertical Distance",ylabel:"Vert. Dist. (m)",field:"TMS334_LP Vertical distance (m)",color:REPORT_C_334},lp_declination_333:{title:"UHD333 · LP Declination",ylabel:"Declination (deg)",field:"TMS333_LP Declination",color:REPORT_C_333},lp_declination_334:{title:"UHD334 · LP Declination",ylabel:"Declination (deg)",field:"TMS334_LP Declination",color:REPORT_C_334}};
const PAIRED_SUFFIXES=["sog","depth","alt","lp_range","lp_vdist","lp_declination"];
const PAIRED_LABELS={sog:"Speed Over Ground",depth:"Depth",alt:"Altimeter",lp_range:"LP Range",lp_vdist:"LP Vertical Distance",lp_declination:"LP Declination"};

const modalReport=document.getElementById("modal-report"),beaconCheckGrid=document.getElementById("beacon-check-grid");
(function(){for(const s of PAIRED_SUFFIXES)for(const b of["333","334"]){const key=`${s}_${b}`,lbl=document.createElement("label");lbl.className="panel-check-row";lbl.innerHTML=`<input type="checkbox" data-key="${key}" checked> ${PAIRED_LABELS[s]}`;beaconCheckGrid.appendChild(lbl);}})();
function allReportCheckboxes(){return Array.from(modalReport.querySelectorAll('input[type=checkbox][data-key]'));}
document.getElementById("btn-report").addEventListener("click",()=>{if(!state.df||!state.minuteTrack){showMessageModal("warn","Load Speed Data first","Load the Speed Data CSV before generating a report.");return;}if(!state.regions.length){showMessageModal("warn","No regions selected",'Click "SELECT REGIONS" and drag to mark at least one time window.');return;}modalReport.classList.add("open");});
document.getElementById("report-cancel").addEventListener("click",()=>modalReport.classList.remove("open"));
modalReport.addEventListener("click",(e)=>{if(e.target===modalReport)modalReport.classList.remove("open");});
document.getElementById("report-select-all").addEventListener("click",()=>allReportCheckboxes().forEach(c=>c.checked=true));
document.getElementById("report-select-none").addEventListener("click",()=>allReportCheckboxes().forEach(c=>c.checked=false));

document.getElementById("report-ok").addEventListener("click",async()=>{
  const selected=new Set(allReportCheckboxes().filter(c=>c.checked).map(c=>c.dataset.key));
  modalReport.classList.remove("open");setStatus("Generating report…");
  await new Promise(r=>setTimeout(r,30));
  try{const blob=await generateRegionReportPdf(selected);const url=URL.createObjectURL(blob);const a=document.createElement("a");const ds=fmtDate(state.dayStartEpoch);a.href=url;a.download=`IFR_Investigation_Report_${ds}.pdf`;document.body.appendChild(a);a.click();document.body.removeChild(a);setTimeout(()=>URL.revokeObjectURL(url),4000);setStatus(`Report saved: ${state.regions.length} region(s) — IFR_Investigation_Report_${ds}.pdf`);}
  catch(err){showMessageModal("error","Error",`Could not generate report:\n${err.message}`);setStatus("Report generation failed");}
});

function logEntriesInWindow(start,end){return state.events.filter(e=>e.epoch>=start&&e.epoch<=end);}

/* ======================================================================
   PDF report generation
   ====================================================================== */
const REPORT_PAGE_W=612,REPORT_PAGE_H=792,REPORT_MARGIN=40;
function makeOffscreenCanvas(wPx,hPx,scale=2){const c=document.createElement("canvas");c.width=wPx*scale;c.height=hPx*scale;const cx=c.getContext("2d");cx.scale(scale,scale);return{canvas:c,cx,w:wPx,h:hPx};}

function drawReportPanel(cx,w,h,opts){
  const{title,ylabel,series,winStart,winEnd,logEvents,withLogLabels}=opts;
  const padL=46,padR=20,padT=22,padB=22,plotW=w-padL-padR,plotH=h-padT-padB;
  cx.fillStyle="#ffffff";cx.fillRect(0,0,w,h);
  let yMin=Infinity,yMax=-Infinity;
  for(const s of series)for(const p of s.points)if(p.val!==null&&Number.isFinite(p.val)){if(p.val<yMin)yMin=p.val;if(p.val>yMax)yMax=p.val;}
  const hasData=Number.isFinite(yMin)&&Number.isFinite(yMax);
  if(!hasData){yMin=0;yMax=1;}if(yMax-yMin<1e-6){yMax+=1;yMin-=1;}
  const pad=(yMax-yMin)*0.08;yMin-=pad;yMax+=pad;
  if(opts.fixedYRange){yMin=opts.fixedYRange[0];yMax=opts.fixedYRange[1];}
  const xP=(ep)=>padL+((ep-winStart)/Math.max(winEnd-winStart,1))*plotW;
  const yP=(v)=>padT+plotH-((v-yMin)/(yMax-yMin))*plotH;
  cx.strokeStyle="#e5e7eb";cx.lineWidth=0.7;cx.font="7.5px 'JetBrains Mono',monospace";cx.fillStyle="#4b5563";cx.textAlign="right";cx.textBaseline="middle";
  for(let i=0;i<=4;i++){const v=yMin+(i/4)*(yMax-yMin);const py=yP(v);cx.beginPath();cx.moveTo(padL,py);cx.lineTo(w-padR,py);cx.stroke();cx.fillText(v.toFixed(Math.abs(v)<10?2:1),padL-5,py);}
  if(!hasData){cx.fillStyle="#9ca3af";cx.font="italic 9px 'JetBrains Mono',monospace";cx.textAlign="center";cx.fillText("No data in window",padL+plotW/2,padT+plotH/2);}
  else{for(const s of series){cx.strokeStyle=s.color;cx.lineWidth=1.3;cx.lineJoin="round";cx.beginPath();let started=false;for(const p of s.points){if(p.val===null||!Number.isFinite(p.val)){started=false;continue;}const px=xP(p.epoch),py=yP(p.val);if(!started){cx.moveTo(px,py);started=true;}else cx.lineTo(px,py);}cx.stroke();}if(series.length>1){let lx=w-padR-6;cx.font="7px 'JetBrains Mono',monospace";cx.textAlign="right";let ly=padT+9;for(const s of series){cx.fillStyle=s.color;cx.fillText(s.label,lx,ly);ly+=9;}}}
  for(const ev of logEvents){const px=xP(ev.epoch);cx.strokeStyle="rgba(217,119,6,0.7)";cx.lineWidth=0.8;cx.setLineDash([1.5,2]);cx.beginPath();cx.moveTo(px,padT);cx.lineTo(px,padT+plotH);cx.stroke();cx.setLineDash([]);if(withLogLabels){cx.fillStyle="#d97706";cx.font="6px 'JetBrains Mono',monospace";cx.textAlign="center";cx.fillText(fmtHM(ev.epoch),px,padT-3);}}
  cx.strokeStyle="#9ca3af";cx.lineWidth=0.8;cx.beginPath();cx.moveTo(padL,padT);cx.lineTo(padL,padT+plotH);cx.lineTo(w-padR,padT+plotH);cx.stroke();
  cx.fillStyle="#4b5563";cx.font="7px 'JetBrains Mono',monospace";cx.textBaseline="top";
  for(let i=0;i<=4;i++){const ep=winStart+(i/4)*(winEnd-winStart);cx.textAlign=i===0?"left":i===4?"right":"center";cx.fillText(fmtHMS(ep),xP(ep),padT+plotH+4);}
  cx.fillStyle="#374151";cx.font="bold 9.5px 'JetBrains Mono',monospace";cx.textAlign="left";cx.textBaseline="alphabetic";cx.fillText(title,2,11);
  cx.save();cx.translate(11,padT+plotH/2);cx.rotate(-Math.PI/2);cx.fillStyle="#4b5563";cx.font="8px 'JetBrains Mono',monospace";cx.textAlign="center";cx.fillText(ylabel,0,0);cx.restore();
}

function seriesPoints(rows,field,m0,m1){const out=[];for(const r of rows){if(r.epoch<m0||r.epoch>m1)continue;out.push({epoch:r.epoch,val:r[field]});}return out;}

// Vessel SOG vs LP Range scatter + fitted trend for a region's rows —
// same derivation (js/drag-analysis.js::fitRowsForBeacon) as the live
// Drag Analysis panel, just region-scoped instead of whole-session.
function drawDragAnalysisPanel(cx,w,h,rows){
  const padL=46,padR=20,padT=22,padB=40,plotW=w-padL-padR,plotH=h-padT-padB;
  cx.fillStyle="#ffffff";cx.fillRect(0,0,w,h);
  cx.fillStyle="#374151";cx.font="bold 9.5px 'JetBrains Mono',monospace";cx.textAlign="left";cx.textBaseline="alphabetic";
  cx.fillText("DRAG ANALYSIS — Vessel SOG vs LP Range",2,11);

  const beacons=beaconConfig();
  const results=beacons.map(bd=>({bd,...fitRowsForBeacon(rows,bd.key)}));
  let sogMax=0,yMax=0,anyPoints=false;
  for(const r of results)for(const p of r.points){anyPoints=true;if(p.v>sogMax)sogMax=p.v;if(p.y>yMax)yMax=p.y;}

  if(!anyPoints){
    cx.fillStyle="#9ca3af";cx.font="italic 9px 'JetBrains Mono',monospace";cx.textAlign="center";
    cx.fillText("No speed / LP Range data in this window",padL+plotW/2,padT+plotH/2);
    return;
  }
  sogMax=Math.max(sogMax,0.5)*1.15; yMax=Math.max(yMax,10)*1.15;
  const xP=(v)=>padL+(v/sogMax)*plotW, yP=(y)=>padT+plotH-(y/yMax)*plotH;

  cx.strokeStyle="#e5e7eb";cx.lineWidth=0.7;cx.font="7.5px 'JetBrains Mono',monospace";cx.fillStyle="#4b5563";
  cx.textAlign="right";cx.textBaseline="middle";
  for(let i=0;i<=4;i++){const y=(i/4)*yMax,py=yP(y);cx.beginPath();cx.moveTo(padL,py);cx.lineTo(w-padR,py);cx.stroke();cx.fillText(y.toFixed(0),padL-5,py);}
  cx.textAlign="center";cx.textBaseline="top";
  for(let i=0;i<=4;i++){const v=(i/4)*sogMax,px=xP(v);cx.beginPath();cx.moveTo(px,padT);cx.lineTo(px,padT+plotH);cx.stroke();cx.fillText(v.toFixed(1),px,padT+plotH+4);}

  for(const{bd,points,fit}of results){
    cx.save();cx.fillStyle=bd.color;cx.globalAlpha=0.45;
    for(const p of points){const px=xP(p.v),py=yP(p.y);cx.beginPath();cx.arc(px,py,1.4,0,Math.PI*2);cx.fill();}
    cx.restore();
    if(fit){
      cx.strokeStyle=bd.color;cx.lineWidth=1.3;cx.lineJoin="round";cx.beginPath();
      let started=false;const step=Math.max(sogMax/120,0.01);
      for(let v=0;v<=sogMax;v+=step){const y=Math.max(0,fit.at(v)),px=xP(v),py=yP(y);if(!started){cx.moveTo(px,py);started=true;}else cx.lineTo(px,py);}
      cx.stroke();
    }
  }

  let lx=w-padR-6,ly=padT+9;cx.font="7px 'JetBrains Mono',monospace";cx.textAlign="right";
  for(const{bd}of results){cx.fillStyle=bd.color;cx.fillText(bd.label,lx,ly);ly+=9;}

  cx.strokeStyle="#9ca3af";cx.lineWidth=0.8;cx.beginPath();cx.moveTo(padL,padT);cx.lineTo(padL,padT+plotH);cx.lineTo(w-padR,padT+plotH);cx.stroke();
  cx.save();cx.translate(11,padT+plotH/2);cx.rotate(-Math.PI/2);cx.fillStyle="#4b5563";cx.font="8px 'JetBrains Mono',monospace";cx.textAlign="center";cx.fillText("LP RANGE (M)",0,0);cx.restore();
  cx.fillStyle="#4b5563";cx.font="7px 'JetBrains Mono',monospace";cx.textAlign="center";cx.textBaseline="top";
  cx.fillText("VESSEL SOG (KN)",padL+plotW/2,padT+plotH+16);

  const{cd,area,rho}=getForceInputs();
  const peakSog=sogMax/1.15;
  const forceKnAt=(sog)=>{const vms=sog*0.514444;return(0.5*rho*cd*area*vms*vms/1000);};
  cx.fillStyle="#6b7280";cx.font="6.5px 'JetBrains Mono',monospace";cx.textAlign="left";cx.textBaseline="top";
  cx.fillText(`Est. drag force @ ${peakSog.toFixed(1)}kt peak SOG: ${forceKnAt(peakSog).toFixed(1)}kN  (Cd=${cd.toFixed(2)}, A=${area.toFixed(2)}m², ρ=${rho}kg/m³ — approximate)`,padL,h-9);
}

async function generateRegionReportPdf(selectedPanels){
  const{jsPDF}=window.jspdf;const doc=new jsPDF({unit:"pt",format:"letter"});
  let showSog=selectedPanels.has("ifr_sog"),showCog=selectedPanels.has("ifr_cog");
  let showDrag=selectedPanels.has("drag_analysis");
  let activePanels=Object.keys(REPORT_SINGLE_PANELS).filter(k=>selectedPanels.has(k));
  if(!showSog&&!showCog&&!showDrag&&!activePanels.length){showSog=true;showCog=true;showDrag=true;activePanels=Object.keys(REPORT_SINGLE_PANELS);}
  const regions=state.regions.slice().sort((a,b)=>a.start-b.start);
  const ds=fmtDate(state.dayStartEpoch);
  doc.setFont("helvetica","bold");doc.setFontSize(18);doc.setTextColor(17,24,39);doc.text("IFR Speed Investigation Report",REPORT_MARGIN,64);
  doc.setFont("helvetica","normal");doc.setFontSize(10.5);doc.setTextColor(107,114,128);doc.text(`${ds} UTC   |   ${regions.length} region(s) selected`,REPORT_MARGIN,82);
  doc.setDrawColor(209,213,219);doc.setLineWidth(1);doc.line(REPORT_MARGIN,94,REPORT_PAGE_W-REPORT_MARGIN,94);
  if(regions.length>0){
    let ty=120;const colX=[REPORT_MARGIN,REPORT_MARGIN+50,REPORT_MARGIN+150,REPORT_MARGIN+250,REPORT_MARGIN+340];
    doc.setFont("helvetica","bold");doc.setFontSize(9);doc.setTextColor(55,65,81);["#","Start (UTC)","End (UTC)","Duration","Log entries"].forEach((h,i)=>doc.text(h,colX[i],ty));ty+=8;doc.setDrawColor(229,231,235);doc.line(REPORT_MARGIN,ty,REPORT_PAGE_W-REPORT_MARGIN,ty);ty+=14;
    doc.setFont("helvetica","normal");doc.setTextColor(31,41,55);
    regions.forEach((r,i)=>{const dur=r.end-r.start,mins=Math.floor(dur/60),secs=Math.floor(dur%60),nLog=logEntriesInWindow(r.start,r.end).length;[`#${i+1}`,fmtHMS(r.start),fmtHMS(r.end),`${mins}m ${String(secs).padStart(2,"0")}s`,`${nLog} entr${nLog===1?"y":"ies"}`].forEach((c,ci)=>doc.text(c,colX[ci],ty));ty+=16;});
  }
  for(let i=0;i<regions.length;i++){
    const r=regions[i];doc.addPage();const wEvs=logEntriesInWindow(r.start,r.end);let y=REPORT_MARGIN;
    doc.setFont("helvetica","bold");doc.setFontSize(15);doc.setTextColor(17,24,39);doc.text(`Region #${i+1}`,REPORT_MARGIN,y+14);y+=28;
    doc.setFont("helvetica","normal");doc.setFontSize(10);doc.setTextColor(107,114,128);const dur=r.end-r.start,mins=Math.floor(dur/60),secs=Math.floor(dur%60);doc.text(`${fmtHMS(r.start)} - ${fmtHMS(r.end)} UTC   |   Duration: ${mins}m ${String(secs).padStart(2,"0")}s   |   ${ds}`,REPORT_MARGIN,y);y+=10;doc.setDrawColor(209,213,219);doc.line(REPORT_MARGIN,y,REPORT_PAGE_W-REPORT_MARGIN,y);y+=14;
    const panelW=REPORT_PAGE_W-2*REPORT_MARGIN,panelH=95,panelGap=10,pageBottom=REPORT_PAGE_H-REPORT_MARGIN;
    const ensureSpace=(n)=>{if(y+n>pageBottom){doc.addPage();y=REPORT_MARGIN;doc.setFont("helvetica","bold");doc.setFontSize(10);doc.setTextColor(107,114,128);doc.text(`Region #${i+1} (continued)`,REPORT_MARGIN,y);y+=16;}};
    const drawOnePanel=(title,ylabel,series,withLabels,fixedYRange)=>{ensureSpace(panelH);const off=makeOffscreenCanvas(panelW,panelH,2.5);drawReportPanel(off.cx,panelW,panelH,{title,ylabel,series,winStart:r.start,winEnd:r.end,logEvents:wEvs,withLogLabels:withLabels,fixedYRange});doc.addImage(off.canvas.toDataURL("image/png"),"PNG",REPORT_MARGIN,y,panelW,panelH);y+=panelH+panelGap;};
    if(showSog){drawOnePanel("VESSEL · IFR Speed Over Ground","SOG (knots)",[{points:seriesPoints(state.df,"IFR SOG (knot)",r.start,r.end),color:REPORT_C_IFR,label:"IFR SOG"}],true);}
    if(showCog){drawOnePanel("VESSEL · IFR Course Over Ground","COG (deg)",[{points:seriesPoints(state.df,"IFR COG",r.start,r.end),color:REPORT_C_COG,label:"IFR COG"}],!showSog,[0,360]);}
    for(const key of activePanels){const p=REPORT_SINGLE_PANELS[key];drawOnePanel(p.title,p.ylabel,[{points:seriesPoints(state.df,p.field,r.start,r.end),color:p.color,label:""}],false);}
    if(showDrag){
      const dragH=170;ensureSpace(dragH);
      const off=makeOffscreenCanvas(panelW,dragH,2.5);
      const regionRows=state.df.filter(row=>row.epoch>=r.start&&row.epoch<=r.end);
      drawDragAnalysisPanel(off.cx,panelW,dragH,regionRows);
      doc.addImage(off.canvas.toDataURL("image/png"),"PNG",REPORT_MARGIN,y,panelW,dragH);
      y+=dragH+panelGap;
    }
    ensureSpace(24);doc.setFont("helvetica","bold");doc.setFontSize(8.5);doc.setTextColor(55,65,81);doc.text("LOG ENTRIES IN THIS WINDOW",REPORT_MARGIN,y+7);y+=16;
    const logW=REPORT_PAGE_W-2*REPORT_MARGIN-4,lineH=8.6;
    if(wEvs.length>0){doc.setTextColor(31,41,55);for(const ev of wEvs){const line=`${fmtHM(ev.epoch)}${ev.code?` [${ev.code}]`:""}  ${ev.remark}`;const wrapped=doc.splitTextToSize(line,logW);ensureSpace(wrapped.length*lineH);doc.setFont("helvetica","normal");doc.setFontSize(7.6);doc.setTextColor(31,41,55);doc.text(wrapped,REPORT_MARGIN,y);y+=wrapped.length*lineH;}}
    else{doc.setTextColor(156,163,175);doc.setFont("helvetica","italic");doc.text("No log entries fall within this window.",REPORT_MARGIN,y);}
  }
  return doc.output("blob");
}
