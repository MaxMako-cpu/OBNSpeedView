/* ======================================================================
   OBN SpeedView — status/toast feedback, message/question modals,
   colors dialog wiring, LP range/decl alert modal wiring
   ====================================================================== */
import { state } from './state.js';
import { render } from './render.js';
import { computeAlertZones, updateLpAlertButton } from './alerts.js';
import { applyColorChange } from './readout.js';

/* ---- status bar / toast ---- */
const sampleCountEl=document.getElementById("sample-count");
const statusbarEl=document.getElementById("statusbar-text");
export function setStatus(msg){statusbarEl.textContent=msg;}
export function showToast(msg,ms=2400){const t=document.getElementById("toast");t.textContent=msg;t.classList.add("show");clearTimeout(showToast._tid);showToast._tid=setTimeout(()=>t.classList.remove("show"),ms);}
export function updateSampleCount(n){const c=n!==undefined?n:state.events.length;sampleCountEl.innerHTML=c>0?`<span class="dot"></span>${c} log events loaded`:"";}

/* ======================================================================
   Message / question modals
   ====================================================================== */
const modalMessage=document.getElementById("modal-message"),modalMessageIcon=document.getElementById("modal-message-icon"),modalMessageTitle=document.getElementById("modal-message-title"),modalMessageBody=document.getElementById("modal-message-body"),modalMessageActions=document.getElementById("modal-message-actions");
export function showMessageModal(kind,title,text){modalMessageIcon.className="modal-icon "+(kind==="error"?"error":"warn");modalMessageIcon.textContent=kind==="error"?"✕":"!";modalMessageTitle.textContent=title;modalMessageBody.textContent=text;modalMessageActions.innerHTML="";const ok=document.createElement("button");ok.className="primary";ok.textContent="OK";ok.addEventListener("click",()=>modalMessage.classList.remove("open"));modalMessageActions.appendChild(ok);modalMessage.classList.add("open");}
export function showQuestionModal(title,text,onYes){modalMessageIcon.className="modal-icon question";modalMessageIcon.textContent="?";modalMessageTitle.textContent=title;modalMessageBody.textContent=text;modalMessageActions.innerHTML="";const no=document.createElement("button");no.textContent="No";no.addEventListener("click",()=>modalMessage.classList.remove("open"));const yes=document.createElement("button");yes.className="primary";yes.textContent="Yes";yes.addEventListener("click",()=>{modalMessage.classList.remove("open");onYes();});modalMessageActions.appendChild(no);modalMessageActions.appendChild(yes);modalMessage.classList.add("open");}
modalMessage.addEventListener("click",(e)=>{if(e.target===modalMessage)modalMessage.classList.remove("open");});

/* ---- colors dialog ---- */
const modalColors=document.getElementById("modal-colors"),colorIfrInput=document.getElementById("color-ifr"),color334Input=document.getElementById("color-334"),color333Input=document.getElementById("color-333");
document.getElementById("btn-colors").addEventListener("click",()=>{colorIfrInput.value=state.colorIfr;color334Input.value=state.color334;color333Input.value=state.color333;modalColors.classList.add("open");});
document.getElementById("colors-close").addEventListener("click",()=>modalColors.classList.remove("open"));
modalColors.addEventListener("click",(e)=>{if(e.target===modalColors)modalColors.classList.remove("open");});
colorIfrInput.addEventListener("input",()=>applyColorChange("ifr",colorIfrInput.value));
color334Input.addEventListener("input",()=>applyColorChange("334",color334Input.value));
color333Input.addEventListener("input",()=>applyColorChange("333",color333Input.value));

/* ======================================================================
   LP Range Alert modal wiring
   ====================================================================== */
const modalLpRange     = document.getElementById("modal-lp-range");
const btnLpRange       = document.getElementById("btn-lp-range");
const lpRangeThreshold = document.getElementById("lp-range-threshold");
const lpRangeColor333  = document.getElementById("lp-range-color-333");
const lpRangeColor334  = document.getElementById("lp-range-color-334");
const lpRangeCheck333  = document.getElementById("lp-range-333");
const lpRangeCheck334  = document.getElementById("lp-range-334");

btnLpRange.addEventListener("click",()=>{
  if(!state.df){showMessageModal("warn","Load Speed Data first","Load the Speed Data CSV before using LP Range Alert.");return;}
  const la=state.lpAlert;
  lpRangeThreshold.value  = la.rangeThreshold;
  lpRangeColor333.value   = la.range333.color;
  lpRangeColor334.value   = la.range334.color;
  lpRangeCheck333.checked = la.range333.enabled;
  lpRangeCheck334.checked = la.range334.enabled;
  modalLpRange.classList.add("open");
});
document.getElementById("lp-range-cancel").addEventListener("click",()=>modalLpRange.classList.remove("open"));
modalLpRange.addEventListener("click",(e)=>{if(e.target===modalLpRange)modalLpRange.classList.remove("open");});

document.getElementById("lp-range-clear").addEventListener("click",()=>{
  state.lpAlert.range333.zones=[];state.lpAlert.range334.zones=[];
  modalLpRange.classList.remove("open");updateLpAlertButton();render();setStatus("LP Range Alert cleared.");
});

document.getElementById("lp-range-ok").addEventListener("click",()=>{
  const thr=parseFloat(lpRangeThreshold.value);
  if(!Number.isFinite(thr)||thr<0){showMessageModal("warn","Invalid threshold","Enter a valid positive number.");return;}
  const la=state.lpAlert;
  la.rangeThreshold      = thr;
  la.range333.color      = lpRangeColor333.value;  la.range333.enabled = lpRangeCheck333.checked;
  la.range334.color      = lpRangeColor334.value;  la.range334.enabled = lpRangeCheck334.checked;
  la.range333.zones = la.range333.enabled ? computeAlertZones(state.df,"TMS333_LP Range (m)",thr) : [];
  la.range334.zones = la.range334.enabled ? computeAlertZones(state.df,"TMS334_LP Range (m)",thr) : [];
  modalLpRange.classList.remove("open");updateLpAlertButton();render();
  const parts=[];
  if(la.range333.zones.length)parts.push(`333: ${la.range333.zones.length} zone(s)`);
  if(la.range334.zones.length)parts.push(`334: ${la.range334.zones.length} zone(s)`);
  if(parts.length){setStatus(`LP Range Alert active — threshold ${thr}m — ${parts.join(", ")}`);showToast(`Range alert: ${parts.join(", ")}`);}
  else{setStatus(`LP Range Alert: no zones above ${thr}m.`);showToast("No zones found.");}
});

/* ======================================================================
   LP Declination Alert modal wiring
   ====================================================================== */
const modalLpDecl     = document.getElementById("modal-lp-decl");
const btnLpDecl       = document.getElementById("btn-lp-decl");
const lpDeclThreshold = document.getElementById("lp-decl-threshold");
const lpDeclColor333  = document.getElementById("lp-decl-color-333");
const lpDeclColor334  = document.getElementById("lp-decl-color-334");
const lpDeclCheck333  = document.getElementById("lp-decl-333");
const lpDeclCheck334  = document.getElementById("lp-decl-334");

btnLpDecl.addEventListener("click",()=>{
  if(!state.df){showMessageModal("warn","Load Speed Data first","Load the Speed Data CSV before using LP Declination Alert.");return;}
  const la=state.lpAlert;
  lpDeclThreshold.value  = la.declThreshold;
  lpDeclColor333.value   = la.decl333.color;
  lpDeclColor334.value   = la.decl334.color;
  lpDeclCheck333.checked = la.decl333.enabled;
  lpDeclCheck334.checked = la.decl334.enabled;
  modalLpDecl.classList.add("open");
});
document.getElementById("lp-decl-cancel").addEventListener("click",()=>modalLpDecl.classList.remove("open"));
modalLpDecl.addEventListener("click",(e)=>{if(e.target===modalLpDecl)modalLpDecl.classList.remove("open");});

document.getElementById("lp-decl-clear").addEventListener("click",()=>{
  state.lpAlert.decl333.zones=[];state.lpAlert.decl334.zones=[];
  modalLpDecl.classList.remove("open");updateLpAlertButton();render();setStatus("LP Declination Alert cleared.");
});

document.getElementById("lp-decl-ok").addEventListener("click",()=>{
  const thr=parseFloat(lpDeclThreshold.value);
  if(!Number.isFinite(thr)||thr<0){showMessageModal("warn","Invalid threshold","Enter a valid positive number.");return;}
  const la=state.lpAlert;
  la.declThreshold      = thr;
  la.decl333.color      = lpDeclColor333.value;  la.decl333.enabled = lpDeclCheck333.checked;
  la.decl334.color      = lpDeclColor334.value;  la.decl334.enabled = lpDeclCheck334.checked;
  la.decl333.zones = la.decl333.enabled ? computeAlertZones(state.df,"TMS333_LP Declination",thr) : [];
  la.decl334.zones = la.decl334.enabled ? computeAlertZones(state.df,"TMS334_LP Declination",thr) : [];
  modalLpDecl.classList.remove("open");updateLpAlertButton();render();
  const parts=[];
  if(la.decl333.zones.length)parts.push(`333: ${la.decl333.zones.length} zone(s)`);
  if(la.decl334.zones.length)parts.push(`334: ${la.decl334.zones.length} zone(s)`);
  if(parts.length){setStatus(`LP Decl Alert active — threshold ${thr}° — ${parts.join(", ")}`);showToast(`Decl alert: ${parts.join(", ")}`);}
  else{setStatus(`LP Decl Alert: no zones above ${thr}°.`);showToast("No zones found.");}
});
