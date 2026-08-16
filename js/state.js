/* ======================================================================
   OBN SpeedView — shared application state
   ====================================================================== */

export const state = {
  colorIfr: localStorage.getItem("sv_color_ifr") || "#ff5fc1",
  color334: localStorage.getItem("sv_color_334") || "#3ee07a",
  color333: localStorage.getItem("sv_color_333") || "#ff4d6a",

  df: null,
  minuteTrack: null,
  currentBucket: 60,   // AGAGA: active bucket size in seconds, adapts to zoom
  dayStartEpoch: null,
  events: [],
  nodeFixes: [],        // [{epoch, uhd, rl, st, id}]
  showNodeFixes: false, // toggle — true = show fixes, hide log markers

  visible: { ifr: true, u334: true, u333: true },

  viewX0: null, viewX1: null,
  yMax: 5,

  selectMode: false,
  regions: [],
  nextRegionId: 1,
  dragStart: null,
  dragCurrent: null,
  hoverEpoch: null,

  // LP Alert — 4 independent channels: range333, range334, decl333, decl334
  lpAlert: {
    active: false,

    rangeThreshold: 700,
    range333: { enabled: true, color: "#ff4d6a", zones: [] },
    range334: { enabled: true, color: "#7fd4ff", zones: [] },

    declThreshold: 5,
    decl333:  { enabled: true, color: "#ffb454", zones: [] },
    decl334:  { enabled: true, color: "#3ee07a", zones: [] },
  },

  // LP Live monitor (live mode only)
  lpLive: {
    enabled: false,
    threshold: 800,
    ifrSpeedThreshold: 0,  // suppress all LP alerts when IFR SOG >= this value (0 = disabled)
    alert333: false,
    alert334: false,
    pulsePhase: 0,
  },
};
