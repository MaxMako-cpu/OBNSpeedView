/* ======================================================================
   OBN SpeedView — WS message dispatch, live row ingestion, archive select
   ====================================================================== */
import { state } from './state.js';
import { safeFloat, parseTsToEpoch, dayStartOf, fmtHMS } from './utils.js';
import { CSV_FIELD_ORDER, CSV_HEADER } from './constants.js';
import { loadSpeedCsvText, applySpeedData, buildMinuteTrack, computeAutoYMax } from './csv.js';
import { render, resizeCanvas, updateNodeCount } from './render.js';
import { renderRegionChips, refreshRegionHint } from './regions.js';
import { updateSampleCount, setStatus, showToast, showMessageModal } from './modals.js';
import { updateLpAlertButton } from './alerts.js';
import { checkLpLive } from './lp-live.js';
import { getUserPanned, setUserPanned, isScrollLocked } from './pan-zoom.js';
import { getWs, isLiveMode, isInArchiveView, setInArchiveView, _showAutoUpdate, _hideAutoUpdate, _startAutoLogTimer, _stopAutoLogTimer, switchToLive } from './websocket.js';
import { clearReadout } from './readout.js';

const btnUpdateLog = document.getElementById("btn-update-log");
const archiveSelect  = document.getElementById("archive-select");

// ── handle incoming WS messages ──
export function handleWsMessage(msg) {
  switch (msg.type) {

    case "header":
      // CSV header sent on connect — we already know it, ignore
      break;

    case "live":
      handleLiveRow(msg.row);
      break;

    case "days":
      populateArchiveSelect(msg.list);
      break;

    case "archive":
      loadArchiveData(msg.day, msg.rows);
      break;

    case "log_data":
      // Events from bridge — already parsed, just apply
      state.events = msg.events.map(e => ({
        epoch:  e.epoch,
        code:   e.code  || "",
        remark: e.remark|| ""
      }));
      updateSampleCount(state.events.length);
      btnUpdateLog.disabled = false;
      render();
      setStatus(`Log: ${msg.count} events from ${msg.file} — ${new Date().toLocaleTimeString()}`);
      showToast(`Log loaded: ${msg.count} events`);
      break;

    case "log_error":
      showMessageModal("error", "Log Error", msg.error);
      break;

    case "node_fix":
      // Incoming live node fix from bridge
      if(msg.ts){
        const epoch=parseTsToEpoch(msg.ts);
        if(epoch!==null){
          state.nodeFixes.push({epoch,uhd:msg.uhd,rl:msg.rl,st:msg.st,id:msg.id});
          state.nodeFixes.sort((a,b)=>a.epoch-b.epoch);
          if(state.showNodeFixes){updateNodeCount();render();}
        }
      }
      break;

    case "node_fixes_archive":
      // Bulk node fixes for a specific day from CSV archive
      state.nodeFixes = [];
      if(msg.rows && msg.rows.length){
        for(const r of msg.rows){
          const epoch = parseTsToEpoch(r.ts);
          if(epoch !== null){
            state.nodeFixes.push({epoch, uhd:r.uhd, rl:r.rl, st:r.st, id:r.id});
          }
        }
        state.nodeFixes.sort((a,b)=>a.epoch-b.epoch);
      }
      updateNodeCount();
      if(state.showNodeFixes) render();
      break;
  }
}

// ── live row handling ──
// Accumulate rows into state.df / minuteTrack in real time
export function handleLiveRow(csvRow) {
  if (isInArchiveView()) return; // Don't overwrite archive data with live packets
  if (!csvRow) return;

  // parse into a row object using existing CSV parser logic
  const fields = csvRow.split(",");
  if (fields.length < 2) return;

  const epoch = parseTsToEpoch(fields[0]);
  if (epoch === null) return;

  const row = { epoch };
  CSV_FIELD_ORDER.forEach((f) => {
    // map position: fields[0]=ts, fields[1..] = numeric columns in CSV order
    const idx = CSV_FIELD_ORDER.indexOf(f);
    row[f] = idx >= 0 ? safeFloat(fields[idx + 1]) : null;
  });

  // init state if first live row or new day
  const rowDay = dayStartOf(epoch);

  // ── Midnight UTC rollover — smooth transition ──────────────────────
  // If we have data from a previous day and a new day packet arrives,
  // request today's archive from bridge and reset gracefully without
  // visually clearing the chart until new data arrives.
  if (state.df && state.dayStartEpoch !== null && state.dayStartEpoch !== rowDay) {
    // New day detected — request fresh archive for today
    const ws = getWs();
    if (ws && ws.readyState === WebSocket.OPEN) {
      const todayStr = `${new Date(rowDay*1000).getUTCFullYear()}-${String(new Date(rowDay*1000).getUTCMonth()+1).padStart(2,"0")}-${String(new Date(rowDay*1000).getUTCDate()).padStart(2,"0")}`;
      ws.send(JSON.stringify({ type: "get_archive", day: todayStr }));
      ws.send(JSON.stringify({ type: "get_days" }));
      ws.send(JSON.stringify({ type: "get_node_fixes", day: todayStr }));
    }
    // Reset state for new day
    state.df            = [];
    state._dfEpochs     = [];
    state.dayStartEpoch = rowDay;
    state.minuteTrack   = buildMinuteTrack([], rowDay);
    state.viewX0        = rowDay;
    state.viewX1        = rowDay + 86400 - 1;
    state.regions       = [];
    state.nextRegionId  = 1;
    state.events        = [];
    state.nodeFixes     = [];
    setUserPanned(false);
    renderRegionChips();
    refreshRegionHint();
    updateSampleCount(0);
    clearReadout();
    const la = state.lpAlert;
    la.active = false;
    for (const ch of [la.range333, la.range334, la.decl333, la.decl334]) ch.zones = [];
    updateLpAlertButton();
    showToast("UTC midnight — new day started");
    // Auto log refresh for new day
    if (isLiveMode() && !isInArchiveView()) {
      _stopAutoLogTimer();
      _showAutoUpdate();
      _startAutoLogTimer();
    }
  }

  if (!state.df || state.dayStartEpoch !== rowDay) {
    // First live row ever
    state.df            = [];
    state._dfEpochs     = [];
    state.dayStartEpoch = rowDay;
    state.minuteTrack   = buildMinuteTrack([], rowDay);
    state.viewX0        = rowDay;
    state.viewX1        = rowDay + 86400 - 1;
    state.regions       = [];
    state.nextRegionId  = 1;
    state.events        = [];
    renderRegionChips();
    refreshRegionHint();
    updateSampleCount(0);
    clearReadout();
    const la = state.lpAlert;
    la.active = false;
    for (const ch of [la.range333, la.range334, la.decl333, la.decl334]) ch.zones = [];
    updateLpAlertButton();
  }

  // append row
  state.df.push(row);
  state._dfEpochs.push(epoch);

  // update minute bucket
  const mEpoch = Math.floor(epoch / state.currentBucket) * state.currentBucket;
  let bucket = state.minuteTrack.find(p => p.epoch === mEpoch);
  if (!bucket) {
    bucket = { epoch: mEpoch, ifr: null, u334: null, u333: null };
    state.minuteTrack.push(bucket);
    state.minuteTrack.sort((a, b) => a.epoch - b.epoch);
  }
  // running mean update
  const sogKeys = { ifr: "IFR SOG (knot)", u334: "UHD334 SOG (knot)", u333: "UHD333 SOG (knot)" };
  for (const [key, field] of Object.entries(sogKeys)) {
    const v = row[field];
    if (v !== null && Number.isFinite(v)) {
      bucket[key] = bucket[key] === null ? v : (bucket[key] + v) / 2;
    }
  }

  state.yMax = computeAutoYMax(state.minuteTrack);

  // LP Live monitor check
  checkLpLive(row);

  // auto-scroll only if user hasn't manually panned the view
  if (!getUserPanned()) {
    // Keep latest data at 75% from left — room for history on left, future on right
    const LIVE_WINDOW = 3600; // total visible span in seconds
    const winEnd = epoch + LIVE_WINDOW * 0.25;
    state.viewX0 = winEnd - LIVE_WINDOW;
    state.viewX1 = winEnd;
  } else {
    // User has panned — only resume autoscroll if scroll lock is off
    // and they manually scrolled to the right edge
    if (!isScrollLocked()) {
      const span = state.viewX1 - state.viewX0;
      if (epoch >= state.viewX1 - 30 && span <= 3700) {
        setUserPanned(false);
      }
    }
  }

  render();
  setStatus(`LIVE  ·  ${fmtHMS(epoch)}  ·  ${state.df.length.toLocaleString()} samples today`);
}

// ── archive select ──
export function populateArchiveSelect(days) {
  // keep first placeholder option
  while (archiveSelect.options.length > 1) archiveSelect.remove(1);
  for (const day of days) {
    const opt = document.createElement("option");
    opt.value = day;
    opt.textContent = day;
    archiveSelect.appendChild(opt);
  }
}

export function setNowActive(active) {
  if (active) {
    archiveSelect.classList.add("now-active");
  } else {
    archiveSelect.classList.remove("now-active");
  }
}

archiveSelect.addEventListener("change", () => {
  const day = archiveSelect.value;
  if (!day || day === "__now__") {
    // Back to live / today
    setInArchiveView(false);
    setNowActive(true);
    switchToLive();
    if (isLiveMode()) { _showAutoUpdate(); _startAutoLogTimer(); }
    setStatus("Live mode — showing today's data");
    return;
  }
  setNowActive(false);
  const today = new Date();
  const todayStr = `${today.getUTCFullYear()}-${String(today.getUTCMonth()+1).padStart(2,"0")}-${String(today.getUTCDate()).padStart(2,"0")}`;
  if (day === todayStr) {
    // Today selected manually — treat same as live, keep AUTO UPDATE
    setInArchiveView(false);
    if (isLiveMode()) { _showAutoUpdate(); _startAutoLogTimer(); }
  } else {
    // Past day — hide AUTO UPDATE
    setInArchiveView(true);
    _hideAutoUpdate();
  }
  const ws = getWs();
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  setStatus(`Loading archive: ${day}…`);
  ws.send(JSON.stringify({ type: "get_archive", day }));
  ws.send(JSON.stringify({ type: "get_node_fixes", day }));
});

export function loadArchiveData(day, rows) {
  if (!rows || !rows.length) {
    showToast(`No data for ${day}`);
    return;
  }
  const csvText = CSV_HEADER + "\n" + rows.join("\n");
  try {
    const parsedRows = loadSpeedCsvText(csvText);
    applySpeedData(parsedRows);
    renderRegionChips();
    refreshRegionHint();
    updateSampleCount();
    resizeCanvas();
    render();
    // Check if this is today's archive (auto-loaded on connect)
    const today = new Date();
    const todayStr = `${today.getUTCFullYear()}-${String(today.getUTCMonth()+1).padStart(2,"0")}-${String(today.getUTCDate()).padStart(2,"0")}`;
    if (day === todayStr) {
      // Today — keep AUTO UPDATE active, don't treat as archive view
      setInArchiveView(false);
      if (isLiveMode()) { _showAutoUpdate(); _startAutoLogTimer(); }
      setStatus(`Today: ${parsedRows.length.toLocaleString()} samples — live data continues`);
    } else {
      setStatus(`Archive: ${day}  ·  ${parsedRows.length.toLocaleString()} samples`);
      showToast(`Loaded archive: ${day}`);
    }
  } catch (err) {
    showMessageModal("error", "Archive Error", err.message);
  }
}
