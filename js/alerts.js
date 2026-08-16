/* ======================================================================
   OBN SpeedView — LP alert zone computation + alert button state
   ====================================================================== */
import { state } from './state.js';

// ---------------------------------------------------------------------
// LP Alert zone computation — contiguous time windows where field > threshold
// Gaps ≤ 60 s are merged so single missing samples don't fragment zones.
// ---------------------------------------------------------------------
export function computeAlertZones(rows, field, threshold) {
  const zones = [];
  let zoneStart = null, lastEpoch = null;
  const MERGE_GAP = 60;
  for (const row of rows) {
    const v = row[field];
    const over = v !== null && Number.isFinite(v) && v > threshold;
    if (over) {
      if (zoneStart === null) zoneStart = row.epoch;
      lastEpoch = row.epoch;
    } else {
      if (zoneStart !== null) {
        if (lastEpoch !== null && row.epoch - lastEpoch <= MERGE_GAP) continue;
        zones.push({ start: zoneStart, end: lastEpoch });
        zoneStart = null; lastEpoch = null;
      }
    }
  }
  if (zoneStart !== null && lastEpoch !== null) zones.push({ start:zoneStart, end:lastEpoch });
  return zones;
}

// Rebuilds all 4 alert zone arrays from current state.lpAlert settings
export function rebuildAlertZones() {
  const la = state.lpAlert;
  la.range333.zones = la.range333.enabled ? computeAlertZones(state.df, "TMS333_LP Range (m)", la.rangeThreshold) : [];
  la.range334.zones = la.range334.enabled ? computeAlertZones(state.df, "TMS334_LP Range (m)", la.rangeThreshold) : [];
  la.decl333.zones  = la.decl333.enabled  ? computeAlertZones(state.df, "TMS333_LP Declination", la.declThreshold) : [];
  la.decl334.zones  = la.decl334.enabled  ? computeAlertZones(state.df, "TMS334_LP Declination", la.declThreshold) : [];
  la.active = [la.range333,la.range334,la.decl333,la.decl334].some(ch => ch.zones.length > 0);
}

const btnLpRange = document.getElementById("btn-lp-range");
const btnLpDecl  = document.getElementById("btn-lp-decl");

export function updateLpRangeButton(){btnLpRange.classList.toggle("active", state.lpAlert.range333.zones.length>0||state.lpAlert.range334.zones.length>0);}
export function updateLpDeclButton(){btnLpDecl.classList.toggle("active", state.lpAlert.decl333.zones.length>0||state.lpAlert.decl334.zones.length>0);}
export function updateLpAlertButton(){updateLpRangeButton();updateLpDeclButton();state.lpAlert.active=[state.lpAlert.range333,state.lpAlert.range334,state.lpAlert.decl333,state.lpAlert.decl334].some(ch=>ch.zones.length>0);}
