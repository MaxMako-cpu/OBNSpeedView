/* ======================================================================
   OBN SpeedView — cursor readout panel
   ====================================================================== */
import { state } from './state.js';
import { fmt, fmtHMS, fmtDate, nearestIdxByEpoch, nearestEvent } from './utils.js';
import { render } from './render.js';

const roEls={time:document.getElementById("ro-time"),date:document.getElementById("ro-date"),sogIfr:document.getElementById("ro-sog-ifr"),sog334:document.getElementById("ro-sog-334"),sog333:document.getElementById("ro-sog-333"),ifrEasting:document.getElementById("ro-ifr-easting"),ifrNorthing:document.getElementById("ro-ifr-northing"),ifrCog:document.getElementById("ro-ifr-cog"),log:document.getElementById("ro-log")};
const bfIds={334:{depth:"ro-334-depth",alt:"ro-334-alt",cog:"ro-334-cog",easting:"ro-334-easting",northing:"ro-334-northing",range:"ro-334-range",vdist:"ro-334-vdist",decl:"ro-334-decl"},333:{depth:"ro-333-depth",alt:"ro-333-alt",cog:"ro-333-cog",easting:"ro-333-easting",northing:"ro-333-northing",range:"ro-333-range",vdist:"ro-333-vdist",decl:"ro-333-decl"}};

export function updateReadout(hoverEpoch){
  if(!state.df||!state.df.length)return;
  const idx=nearestIdxByEpoch(state._dfEpochs,hoverEpoch);if(idx===null)return;
  const row=state.df[idx];
  roEls.time.textContent=fmtHMS(row.epoch);roEls.date.textContent=fmtDate(row.epoch);
  roEls.sogIfr.textContent=fmt(row["IFR SOG (knot)"]);roEls.sog334.textContent=fmt(row["UHD334 SOG (knot)"]);roEls.sog333.textContent=fmt(row["UHD333 SOG (knot)"]);
  roEls.ifrEasting.textContent=fmt(row["IFR Easting (Metre) (32615)"],1);roEls.ifrNorthing.textContent=fmt(row["IFR Northing (Metre) (32615)"],1);roEls.ifrCog.textContent=fmt(row["IFR COG"],1);
  const s=id=>document.getElementById(id);
  const set=(id,v)=>{const el=s(id);if(el)el.textContent=v;};
  set(bfIds[334].depth,fmt(row["UHD334 Depth (m)"],2));set(bfIds[334].alt,fmt(row["UHD334 Altimeter (m)"],2));set(bfIds[334].cog,fmt(row["UHD334 COG"],1));set(bfIds[334].easting,fmt(row["UHD334 Easting (Metre) (32615)"],1));set(bfIds[334].northing,fmt(row["UHD334 Northing (Metre) (32615)"],1));set(bfIds[334].range,fmt(row["TMS334_LP Range (m)"],1));set(bfIds[334].vdist,fmt(row["TMS334_LP Vertical distance (m)"],1));set(bfIds[334].decl,fmt(row["TMS334_LP Declination"],1));
  set(bfIds[333].depth,fmt(row["UHD333 Depth (m)"],2));set(bfIds[333].alt,fmt(row["UHD333 Altimeter (m)"],2));set(bfIds[333].cog,fmt(row["UHD333 COG"],1));set(bfIds[333].easting,fmt(row["UHD333 Easting (Metre) (32615)"],1));set(bfIds[333].northing,fmt(row["UHD333 Northing (Metre) (32615)"],1));set(bfIds[333].range,fmt(row["TMS333_LP Range (m)"],1));set(bfIds[333].vdist,fmt(row["TMS333_LP Vertical distance (m)"],1));set(bfIds[333].decl,fmt(row["TMS333_LP Declination"],1));
  const ev=nearestEvent(state.events,hoverEpoch,state.viewX1-state.viewX0);
  const roFix=document.getElementById("ro-fix");
  if(state.showNodeFixes){
    // Show node fix popup, hide log popup
    roEls.log.style.display="none";
    const fixes=state.nodeFixes;
    if(fixes.length){
      // find nearest fix to cursor
      let best=null,bestDist=Infinity;
      const viewSpan=state.viewX1-state.viewX0;
      const snapDist=Math.max(viewSpan*0.01,2);
      for(const f of fixes){const d=Math.abs(f.epoch-hoverEpoch);if(d<bestDist){bestDist=d;best=f;}}
      if(best&&bestDist<=snapDist){
        const color=best.uhd==="UHD333"?state.color333:state.color334;
        roFix.style.display="block";
        roFix.style.border=`1px solid ${color}77`;
        roFix.style.boxShadow=`0 0 20px -6px ${color}44`;
        roFix.style.color=color;
        roFix.textContent=`${best.uhd}  @  ${fmtHMS(best.epoch)}\n${best.rl}  ·  ${best.st}  ·  ${best.id}`;
      } else {
        roFix.style.display="none";
      }
    } else {
      roFix.style.display="none";
    }
  } else {
    roFix.style.display="none";
    if(ev){roEls.log.textContent=`LOG @ ${fmtHMS(ev.epoch)}${ev.code?`  [${ev.code}]`:""}\n\n${ev.remark}`;roEls.log.style.display="block";}
    else roEls.log.style.display="none";
  }
}
export function setText(id,text){const el=document.getElementById(id);if(el)el.textContent=text;}
export function clearReadout(){roEls.time.textContent="--:--:--";roEls.date.textContent="";roEls.sogIfr.textContent="—";roEls.sog334.textContent="—";roEls.sog333.textContent="—";roEls.log.style.display="none";document.getElementById("ro-fix").style.display="none";}

// ── Live readout on hover over right panel ────────────────────────────
(function(){
  const readoutEl = document.getElementById("readout");
  if (!readoutEl) return;
  let _liveReadoutActive = false;
  let _liveReadoutTimer = null;

  function showLiveReadout() {
    if (!state.df || !state.df.length) return;
    const row = state.df[state.df.length - 1];
    if (!row) return;
    _liveReadoutActive = true;
    roEls.time.textContent = fmtHMS(row.epoch);
    roEls.date.textContent = fmtDate(row.epoch) + "  ·  LIVE";
    roEls.time.style.color = "var(--green)";
    roEls.sogIfr.textContent = fmt(row["IFR SOG (knot)"]);
    roEls.sog334.textContent = fmt(row["UHD334 SOG (knot)"]);
    roEls.sog333.textContent = fmt(row["UHD333 SOG (knot)"]);
    roEls.ifrEasting.textContent  = fmt(row["IFR Easting (Metre) (32615)"], 1);
    roEls.ifrNorthing.textContent = fmt(row["IFR Northing (Metre) (32615)"], 1);
    roEls.ifrCog.textContent      = fmt(row["IFR COG"], 1);
    const s = id => document.getElementById(id);
    const set = (id, v) => { const el = s(id); if (el) el.textContent = v; };
    set("ro-334-depth",    fmt(row["UHD334 Depth (m)"], 2));
    set("ro-334-alt",      fmt(row["UHD334 Altimeter (m)"], 2));
    set("ro-334-cog",      fmt(row["UHD334 COG"], 1));
    set("ro-334-easting",  fmt(row["UHD334 Easting (Metre) (32615)"], 1));
    set("ro-334-northing", fmt(row["UHD334 Northing (Metre) (32615)"], 1));
    set("ro-334-range",    fmt(row["TMS334_LP Range (m)"], 1));
    set("ro-334-vdist",    fmt(row["TMS334_LP Vertical distance (m)"], 1));
    set("ro-334-decl",     fmt(row["TMS334_LP Declination"], 1));
    set("ro-333-depth",    fmt(row["UHD333 Depth (m)"], 2));
    set("ro-333-alt",      fmt(row["UHD333 Altimeter (m)"], 2));
    set("ro-333-cog",      fmt(row["UHD333 COG"], 1));
    set("ro-333-easting",  fmt(row["UHD333 Easting (Metre) (32615)"], 1));
    set("ro-333-northing", fmt(row["UHD333 Northing (Metre) (32615)"], 1));
    set("ro-333-range",    fmt(row["TMS333_LP Range (m)"], 1));
    set("ro-333-vdist",    fmt(row["TMS333_LP Vertical distance (m)"], 1));
    set("ro-333-decl",     fmt(row["TMS333_LP Declination"], 1));
  }

  function stopLiveReadout() {
    _liveReadoutActive = false;
    roEls.time.style.color = "";
    // Restore cursor readout if hoverEpoch is active, else clear
    if (state.hoverEpoch !== null) updateReadout(state.hoverEpoch);
    else clearReadout();
  }

  readoutEl.addEventListener("mouseenter", () => {
    showLiveReadout();
    // Refresh every second while hovering
    _liveReadoutTimer = setInterval(() => { if (_liveReadoutActive) showLiveReadout(); }, 1000);
  });

  readoutEl.addEventListener("mouseleave", () => {
    clearInterval(_liveReadoutTimer);
    stopLiveReadout();
  });
})();

/* ---- color application ---- */
export function applyReadoutColors() {
  const c = { ifr: state.colorIfr, "334": state.color334, "333": state.color333 };
  // SOG dots and values
  const sogIfr  = document.getElementById("ro-sog-ifr");
  const sog334  = document.getElementById("ro-sog-334");
  const sog333  = document.getElementById("ro-sog-333");
  const secIfr  = document.getElementById("ro-sec-ifr");
  const sec334  = document.getElementById("ro-sec-334");
  const sec333  = document.getElementById("ro-sec-333");

  function applyDot(el, hex) {
    if (!el) return;
    el.style.background  = hex;
    el.style.boxShadow   = `0 0 6px ${hex}99`;
  }
  function applyVal(el, hex) {
    if (!el) return;
    el.style.color = hex;
  }
  function applyTitle(el, hex) {
    if (!el) return;
    el.style.color = hex;
  }

  applyDot(document.getElementById("ro-dot-ifr"), c.ifr);
  applyDot(document.getElementById("ro-dot-334"), c["334"]);
  applyDot(document.getElementById("ro-dot-333"), c["333"]);
  applyVal(sogIfr, c.ifr);
  applyVal(sog334, c["334"]);
  applyVal(sog333, c["333"]);
  applyTitle(secIfr, c.ifr);
  applyTitle(sec334, c["334"]);
  applyTitle(sec333, c["333"]);
}

export function applyColorChange(which,hex){
  if(which==="ifr"){state.colorIfr=hex;document.getElementById("dot-ifr").style.background=hex;localStorage.setItem("sv_color_ifr",hex);}
  else if(which==="334"){state.color334=hex;document.getElementById("dot-334").style.background=hex;localStorage.setItem("sv_color_334",hex);}
  else if(which==="333"){state.color333=hex;document.getElementById("dot-333").style.background=hex;localStorage.setItem("sv_color_333",hex);}
  applyReadoutColors();
  render();
}
