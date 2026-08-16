/* ======================================================================
   OBN SpeedView — shared constants
   ====================================================================== */

// Single source of truth for the 22-field column order used by:
//  - the CSV header synthesized for archive loads (loadArchiveData)
//  - the live-row field positions sent by the bridge over WebSocket (handleLiveRow)
//  - the numeric-field allowlist used when parsing an uploaded CSV (loadSpeedCsvText)
// This order MUST match WebSocket.py's CSV_HEADER exactly — it is the wire
// protocol between the bridge and this page.
export const CSV_FIELD_ORDER = [
  "IFR Easting (Metre) (32615)", "IFR Northing (Metre) (32615)",
  "IFR SOG (knot)", "IFR COG",
  "UHD333 Easting (Metre) (32615)", "UHD333 Northing (Metre) (32615)",
  "UHD333 Depth (m)", "UHD333 Altimeter (m)", "UHD333 SOG (knot)", "UHD333 COG",
  "TMS333_LP Range (m)", "TMS333_LP Vertical distance (m)", "TMS333_LP Declination",
  "UHD334 Easting (Metre) (32615)", "UHD334 Northing (Metre) (32615)",
  "UHD334 Depth (m)", "UHD334 Altimeter (m)", "UHD334 SOG (knot)", "UHD334 COG",
  "TMS334_LP Range (m)", "TMS334_LP Vertical distance (m)", "TMS334_LP Declination",
];

// Order doesn't matter for CSV parsing (Papa.parse reads by header name), so
// this is safely the same array as CSV_FIELD_ORDER.
export const NUMERIC_FIELDS = CSV_FIELD_ORDER;

export const CSV_HEADER = "TimeStamp (Utc)," + CSV_FIELD_ORDER.join(",");

export const COLOR_LOG = "#ffb454";
