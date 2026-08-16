/* ======================================================================
   OBN SpeedView — CSV loading, track aggregation, applying loaded data
   ====================================================================== */
import { state } from './state.js';
import { safeFloat, parseTsToEpoch, dayStartOf } from './utils.js';
import { NUMERIC_FIELDS } from './constants.js';
import { updateLpAlertButton } from './alerts.js';

// Papa (PapaParse) is loaded globally via <script> from CDN.
/* global Papa */

export function loadSpeedCsvText(csvText) {
  const parsed = Papa.parse(csvText, { header:true, skipEmptyLines:true });
  const fields = parsed.meta.fields || [];
  const tsCol = fields.includes("TimeStamp (Utc)") ? "TimeStamp (Utc)" : fields[0];
  const rows = [];
  for (const raw of parsed.data) {
    const epoch = parseTsToEpoch(raw[tsCol]);
    if (epoch === null) continue;
    const row = { epoch };
    for (const f of NUMERIC_FIELDS) row[f] = f in raw ? safeFloat(raw[f]) : null;
    rows.push(row);
  }
  rows.sort((a,b) => a.epoch - b.epoch);
  if (!rows.length) throw new Error("No valid timestamped rows found in CSV.");
  return rows;
}

// ---------------------------------------------------------------------
// Adaptive track aggregation (AGAGA)
// Bucket size adapts to current zoom level for higher fidelity at detail view
// ---------------------------------------------------------------------
const SOG_KEYS = { ifr:"IFR SOG (knot)", u334:"UHD334 SOG (knot)", u333:"UHD333 SOG (knot)" };

export function getBucketSec(viewSpan) {
  if (viewSpan < 10 * 60)   return 5;   // < 10 min on screen → 5-sec buckets
  if (viewSpan < 60 * 60)   return 15;  // < 1 hour           → 15-sec buckets
  if (viewSpan < 4 * 60 * 60) return 30; // < 4 hours          → 30-sec buckets
  return 60;                              // full day view       → 60-sec buckets
}

export function buildTrack(rows, dayStartEpoch, bucketSec) {
  bucketSec = bucketSec || 60;
  const dayEnd = dayStartEpoch + 86400;
  const buckets = new Map();
  for (const row of rows) {
    if (row.epoch < dayStartEpoch || row.epoch >= dayEnd) continue;
    const m = Math.floor(row.epoch / bucketSec) * bucketSec;
    let b = buckets.get(m);
    if (!b) { b={ifr:[0,0],u334:[0,0],u333:[0,0]}; buckets.set(m,b); }
    for (const k of Object.keys(SOG_KEYS)) { const v=row[SOG_KEYS[k]]; if(v!==null){b[k][0]+=v;b[k][1]+=1;} }
  }
  const track = [];
  for (let m=dayStartEpoch; m<dayEnd; m+=bucketSec) {
    const b=buckets.get(m), pt={epoch:m};
    for (const k of Object.keys(SOG_KEYS)) pt[k]=(b&&b[k][1]>0)?b[k][0]/b[k][1]:null;
    track.push(pt);
  }
  return track;
}

// Legacy alias — used by live row handler and archive loader (always starts at 60s)
export function buildMinuteTrack(rows, dayStartEpoch) {
  return buildTrack(rows, dayStartEpoch, 60);
}

export function computeAutoYMax(mt) {
  let max=-Infinity;
  for(const p of mt)for(const k of["ifr","u334","u333"]){const v=p[k];if(v!==null&&Number.isFinite(v)&&v>max)max=v;}
  return Number.isFinite(max)?Math.max(1,max)*1.15:5;
}

export function applySpeedData(rows) {
  state.df=rows; state._dfEpochs=rows.map(r=>r.epoch);
  state.dayStartEpoch=dayStartOf(rows[0].epoch);
  state.currentBucket=60; state.minuteTrack=buildMinuteTrack(rows,state.dayStartEpoch);
  state.yMax=computeAutoYMax(state.minuteTrack);
  state.viewX0=state.dayStartEpoch; state.viewX1=state.dayStartEpoch+86400-1;
  state.regions=[]; state.nextRegionId=1; state.events=[];
  // reset alert zones, keep settings
  const la=state.lpAlert;
  la.active=false;
  for(const ch of[la.range333,la.range334,la.decl333,la.decl334])ch.zones=[];
  updateLpAlertButton();
}
