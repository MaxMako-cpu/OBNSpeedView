/* ======================================================================
   OBN SpeedView — generic utilities (no state/DOM dependency)
   ====================================================================== */

export function safeFloat(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "" || s === "--" || s === "N/A" || s === "nan" || s === "NaN") return null;
    const f = parseFloat(s);
    return Number.isFinite(f) ? f : null;
  }
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : null;
}
export function fmt(v, digits = 3) {
  return (v === null || v === undefined || Number.isNaN(v)) ? "—" : v.toFixed(digits);
}
export function parseTsToEpoch(s) {
  if (!s) return null;
  let str = String(s).trim();
  if (!str) return null;

  // Format: M/D/YYYY HH:MM or M/D/YYYY HH:MM:SS  (node fix CSV as seen in Excel)
  const mdyMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (mdyMatch) {
    const [,mo,dy,yr,hh,mm,ss] = mdyMatch;
    const iso = `${yr}-${mo.padStart(2,"0")}-${dy.padStart(2,"0")}T${hh.padStart(2,"0")}:${mm}:${(ss||"00").padStart(2,"0")}Z`;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : t / 1000;
  }

  // Format: YYYY-MM-DD HH:MM:SS or YYYY-MM-DD HH:MM:SS.mmm  (bridge output)
  const ymdMatch = str.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
  if (ymdMatch) {
    const iso = `${ymdMatch[1]}T${ymdMatch[2]}Z`;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : t / 1000;
  }

  // Standard ISO fallback
  let iso = str.replace(" ", "T");
  if (!/Z$|[+-]\d\d:\d\d$/.test(iso)) iso += "Z";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t / 1000;
}
export function epochToDate(e) { return new Date(e * 1000); }
export function pad2(n) { return String(n).padStart(2, "0"); }
export function fmtHMS(e) { const d=epochToDate(e); return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`; }
export function fmtHM(e)  { const d=epochToDate(e); return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`; }
export function fmtDate(e){ const d=epochToDate(e); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())}`; }
export function dayStartOf(e) { return Math.floor(e / 86400) * 86400; }

export function hexToRgb(hex){const h=hex.replace("#","");const n=parseInt(h.length===3?h.split("").map(c=>c+c).join(""):h,16);return{r:(n>>16)&255,g:(n>>8)&255,b:n&255};}
export function rgba(hex,a){const{r,g,b}=hexToRgb(hex);return`rgba(${r},${g},${b},${a})`;}

// ---------------------------------------------------------------------
// Nearest-neighbor search
// ---------------------------------------------------------------------
export function nearestIdxByEpoch(epochs, xEpoch) {
  if (!epochs||!epochs.length) return null;
  let lo=0,hi=epochs.length;
  while(lo<hi){const mid=(lo+hi)>>1;if(epochs[mid]<xEpoch)lo=mid+1;else hi=mid;}
  if(lo<=0)return 0;if(lo>=epochs.length)return epochs.length-1;
  return(xEpoch-epochs[lo-1])<=(epochs[lo]-xEpoch)?lo-1:lo;
}
export function nearestEvent(events,xEpoch,viewSpan) {
  if (!events||!events.length) return null;
  const epochs=events.map(e=>e.epoch);
  let lo=0,hi=epochs.length;
  while(lo<hi){const mid=(lo+hi)>>1;if(epochs[mid]<xEpoch)lo=mid+1;else hi=mid;}
  const cands=[];if(lo>0)cands.push(lo-1);if(lo<epochs.length)cands.push(lo);
  if(!cands.length)return null;
  let best=cands[0];for(const c of cands)if(Math.abs(epochs[c]-xEpoch)<Math.abs(epochs[best]-xEpoch))best=c;
  return Math.abs(epochs[best]-xEpoch)<=Math.max(Math.max(viewSpan,1)*0.01,2)?events[best]:null;
}
