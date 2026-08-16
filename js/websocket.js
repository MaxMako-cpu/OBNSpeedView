/* ======================================================================
   OBN SpeedView — LIVE WebSocket connection lifecycle
   ====================================================================== */
import { state } from './state.js';
import { fmtDate } from './utils.js';
import { setStatus, showToast, showMessageModal } from './modals.js';
import { updateSpeedupOverlay, _stopLpLivePulse } from './lp-live.js';
import { handleWsMessage } from './live-data.js';

// ── state ──
let ws                 = null;
let wsReconnectTimer   = null;
let liveMode           = false;
let _wsUserDisconnected = false;  // true = user pressed DISCONNECT, skip reconnect
let _wsReconnectDelay  = 5000;   // backoff: 5s → 10s → 20s → 30s max
let _autoLogTimer      = null;   // setInterval for auto log refresh
let _inArchiveView     = false;  // true when user has selected an archive day

export function getWs() { return ws; }
export function isLiveMode() { return liveMode; }
export function isInArchiveView() { return _inArchiveView; }
export function setInArchiveView(v) { _inArchiveView = v; }

const liveDot        = document.getElementById("live-dot");
const wsIpInput      = document.getElementById("ws-ip");
const wsPortInput    = document.getElementById("ws-port-input");
const btnLiveConnect = document.getElementById("btn-live-connect");
const btnUpdateLog   = document.getElementById("btn-update-log");

// ── dot state ──
function setDot(cls) {
  liveDot.className = "";
  if (cls) liveDot.classList.add(cls);
}

// ── auto-log timer helpers ──
export function _startAutoLogTimer() {
  _stopAutoLogTimer();
  _autoLogTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN && state.df && !_inArchiveView) {
      ws.send(JSON.stringify({ type: "get_log", base_date: fmtDate(state.dayStartEpoch) }));
    }
  }, 60000);
}
export function _stopAutoLogTimer() {
  if (_autoLogTimer) { clearInterval(_autoLogTimer); _autoLogTimer = null; }
}

// ── show / hide AUTO UPDATE button ──
export function _showAutoUpdate() {
  btnUpdateLog.style.display = "";
  btnUpdateLog.textContent   = "↺ AUTO UPDATE";
  btnUpdateLog.classList.add("auto-active");
  btnUpdateLog.disabled = false;
}
export function _hideAutoUpdate() {
  _stopAutoLogTimer();
  btnUpdateLog.style.display = "none";
  btnUpdateLog.classList.remove("auto-active");
}
function _resetUpdateBtn() {
  _stopAutoLogTimer();
  btnUpdateLog.style.display = "";
  btnUpdateLog.textContent   = "↺ UPDATE";
  btnUpdateLog.classList.remove("auto-active");
}

// ── connect / disconnect ──
btnLiveConnect.addEventListener("click", () => {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    disconnectWs();
  } else {
    connectWs();
  }
});

export function connectWs() {
  const ip   = wsIpInput.value.trim();
  const port = wsPortInput.value.trim() || "8765";
  if (!ip) { showToast("Enter bridge IP first"); return; }
  _wsUserDisconnected = false;
  _wsReconnectDelay   = 5000;
  clearTimeout(wsReconnectTimer);
  const url = `ws://${ip}:${port}`;
  setDot("connecting");
  btnLiveConnect.textContent = "DISCONNECT";
  setStatus(`Connecting to ${url}…`);

  ws = new WebSocket(url);

  ws.onopen = () => {
    setDot("connected");
    liveMode = true;
    _wsReconnectDelay = 5000;
    setStatus(`Live — connected to ${url}`);
    showToast("Live connected");
    // Request archive day list
    ws.send(JSON.stringify({ type: "get_days" }));
    // Auto-load today's archive and node fixes
    const today = new Date();
    const todayStr = `${today.getUTCFullYear()}-${String(today.getUTCMonth()+1).padStart(2,"0")}-${String(today.getUTCDate()).padStart(2,"0")}`;
    ws.send(JSON.stringify({ type: "get_archive", day: todayStr }));
    ws.send(JSON.stringify({ type: "get_node_fixes", day: todayStr }));
    // Show AUTO UPDATE — today's data, not an archive view
    if (!_inArchiveView) {
      _showAutoUpdate();
      _startAutoLogTimer();
    }
  };

  ws.onmessage = (e) => {
    try { handleWsMessage(JSON.parse(e.data)); } catch (_) {}
  };

  ws.onerror = () => {
    setDot("error");
    setStatus("WebSocket error");
  };

  ws.onclose = () => {
    liveMode = false;
    // Reset button — but keep it hidden if we're in archive view
    if (_inArchiveView) {
      _hideAutoUpdate();
    } else {
      _resetUpdateBtn();
    }
    // Data stays on screen — do NOT clear state.df or state.events
    if (_wsUserDisconnected) {
      setDot("");
      btnLiveConnect.textContent = "CONNECT LIVE";
      setStatus("Disconnected");
    } else {
      // Unexpected drop — reconnect with backoff
      setDot("reconnecting");
      btnLiveConnect.textContent = "DISCONNECT";
      const delay = _wsReconnectDelay;
      setStatus(`Disconnected — reconnecting in ${delay/1000}s…`);
      wsReconnectTimer = setTimeout(() => {
        _wsReconnectDelay = Math.min(_wsReconnectDelay * 2, 30000);
        connectWs();
      }, delay);
    }
  };
}

export function switchToLive() {
  state.df = null;
  state.dayStartEpoch = null;
  if (ws && ws.readyState === WebSocket.OPEN) {
    const today = new Date();
    const todayStr = today.getUTCFullYear()+"-"+String(today.getUTCMonth()+1).padStart(2,"0")+"-"+String(today.getUTCDate()).padStart(2,"0");
    ws.send(JSON.stringify({ type: "get_archive", day: todayStr }));
    ws.send(JSON.stringify({ type: "get_node_fixes", day: todayStr }));
  }
}

export function disconnectWs() {
  liveMode = false;
  _wsUserDisconnected = true;
  clearTimeout(wsReconnectTimer);
  _resetUpdateBtn();
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  setDot("");
  btnLiveConnect.textContent = "CONNECT LIVE";
  setStatus("Disconnected");
  // Reset LP Live alerts — no longer live
  state.lpLive.alert333 = false;
  state.lpLive.alert334 = false;
  updateSpeedupOverlay();
  _stopLpLivePulse();
}

export function requestLogViaWs(){
  if(!state.df){showMessageModal("warn","Load Speed Data first","Load the Speed Data CSV before loading the log.");return;}
  if(!ws||ws.readyState!==WebSocket.OPEN){showMessageModal("warn","Not connected","Connect to bridge first to load log automatically.\n\nOr use LOAD LOG (file picker) when offline.");return;}
  const baseDate=fmtDate(state.dayStartEpoch);
  setStatus("Requesting log from bridge…");
  ws.send(JSON.stringify({type:"get_log",base_date:baseDate}));
}
