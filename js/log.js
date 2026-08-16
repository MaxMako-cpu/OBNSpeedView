/* ======================================================================
   OBN SpeedView — Online Log (.xlsm) loading
   ====================================================================== */

// XLSX is loaded globally via <script> from CDN.
/* global XLSX */

export function excelTimeToMsOfDay(v) {
  if (v===null||v===undefined) return null;
  if (v instanceof Date) return ((v.getHours()*3600)+(v.getMinutes()*60)+v.getSeconds())*1000;
  if (typeof v==="number") return Math.round((v-Math.floor(v))*86400000);
  if (typeof v==="string") {
    const p=v.trim().split(":");
    if (p.length>=2){const h=parseInt(p[0],10),m=parseInt(p[1],10),s=p.length>2?Math.floor(parseFloat(p[2])):0;if(Number.isFinite(h)&&Number.isFinite(m))return(h*3600+m*60+(Number.isFinite(s)?s:0))*1000;}
  }
  return null;
}

export function loadLogWorkbook(arrayBuffer, baseDateEpoch) {
  const wb = XLSX.read(arrayBuffer, { type:"array", cellDates:true });
  const sheetName = wb.SheetNames.includes("log") ? "log" : wb.SheetNames[0];
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {header:1,raw:true,defval:null});
  let headerRow = null;
  for (let r=0; r<Math.min(grid.length,40); r++) {
    for (let c=0; c<Math.min((grid[r]||[]).length,15); c++) {
      if (typeof grid[r][c]==="string"&&grid[r][c].trim().toUpperCase()==="REMARKS"){headerRow=r;break;}
    }
    if (headerRow!==null) break;
  }
  if (headerRow===null) headerRow=16;
  const events=[]; let prevMs=null,dayOffset=0;
  for (let r=headerRow+2; r<grid.length; r++) {
    const row=grid[r]||[];
    const utcStart=row[5]??null,code=row[4]??null,remark=row[7]??null;
    if (utcStart===null) continue;
    const ms=excelTimeToMsOfDay(utcStart); if(ms===null) continue;
    if (prevMs!==null&&ms<prevMs-60000) dayOffset+=1;
    prevMs=ms;
    const text=remark!==null?String(remark).trim():""; if(!text) continue;
    events.push({epoch:baseDateEpoch+dayOffset*86400+ms/1000,code:code!==null?String(code).trim():"",remark:text});
  }
  events.sort((a,b)=>a.epoch-b.epoch);
  return events;
}
