// RaceKit full renderer — one self-contained pass.
// Renders final composited frames (bg + quarterly event panel behind bars + chart + logo + year ring),
// then an end-screen-safe outro, piping straight to ffmpeg (no giant intermediate frame store).
// Config via config.json (see repo). Quarter panel PNGs live in ./panels/<file>.png
//
// Usage: node racekit_full.js config.json
const { Resvg } = require('@resvg/resvg-js');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(process.argv[2] || 'config.json', 'utf8'));
const ROOT = __dirname;
const FPS = +(process.env.FPS || cfg.fps || 60);
const YEAR_SEC = +(process.env.YEAR_SEC || cfg.year_sec || 80);   // 20s/quarter
const OUTRO_SEC = +(cfg.outro_sec || 20);
const XF = 0.8;                          // crossfade seconds between quarter images
const W = 1920, H = 1080, TOPN = 10, K = 0.05;
const BG = cfg.bg || '#0F1420', ACCENT = cfg.accent || '#2EC4B6', GOLD = '#F5C453';
const OUT = cfg.out || 'master.mp4';

const FONT_BUFFERS = ['400','600','700'].map(w => fs.readFileSync(`${ROOT}/fonts/IBMPlexSans-${w}.ttf`));
const FF = 'IBM Plex Sans';
const TITLE_FF = process.env.SERIF_TITLE ? 'SourceSerif4 SemiBold' : FF;
const PANEL_MODE = !!(process.env.PANEL_MODE || cfg.panel_mode);   // event panel behind bars (+ FTSE line)
const ALL_SERIF  = !!(process.env.ALL_SERIF  || cfg.all_serif);    // Source Serif 4 for all text
const LOGOS = JSON.parse(fs.readFileSync(`${ROOT}/logos.json`,'utf8'));
const ICONS = JSON.parse(fs.readFileSync(`${ROOT}/subsector_icons.json`,'utf8'));
const data = JSON.parse(fs.readFileSync(`${ROOT}/${cfg.data}`,'utf8'));
const years = data.years.map(Number), comps = data.companies, colours = data.colours||{};
const unit = data.unit ?? cfg.unit ?? '£', suffix = data.suffix ?? cfg.suffix ?? 'bn';
const INDEX_NAME = cfg.index_name || ({UK:'FTSE 100', FR:'CAC 40'}[cfg.file_prefix] || 'the index');
const col = c => colours[c.sub] || '#4A6572';

// preload company logos (base64) + MM logo + quarter panels (base64)
const b64 = p => 'data:image/png;base64,'+fs.readFileSync(p).toString('base64');
const b64any = p => 'data:image/'+(/\.jpe?g$/i.test(p)?'jpeg':'png')+';base64,'+fs.readFileSync(p).toString('base64');
const LOGOIMG = {}; for(const c of comps){ const pm=`${ROOT}/company_logos_mono/${c.label}.png`, p=`${ROOT}/company_logos/${c.label}.png`; const f=fs.existsSync(pm)?pm:(fs.existsSync(p)?p:null); if(f) LOGOIMG[c.label]=b64any(f); }   // prefer monochrome marks; b64any tolerates mislabeled jpg
const MMLOGO = fs.existsSync(`${ROOT}/logo.png`) ? b64(`${ROOT}/logo.png`) : null;
const PANEL_DIR = `${ROOT}/panels`;
const MACROB64={}, COB64={}; // per-year: _A = world-macro (first half), _B = company event (second half)
if(fs.existsSync(PANEL_DIR)) for(const f of fs.readdirSync(PANEL_DIR)){ const m=f.match(/_(\d{4})_(A|B)\.(?:png|jpe?g)$/i); if(!m) continue; const y=+m[1]; (m[2]==='A'?MACROB64:COB64)[y]=b64any(`${PANEL_DIR}/${f}`); }
// FTSE 100 series for the live drawing line
const FTSE_RAW = fs.existsSync(`${ROOT}/ftse.json`) ? JSON.parse(fs.readFileSync(`${ROOT}/ftse.json`,'utf8')) : [];
const FTSE = FTSE_RAW.map(o=>{ const yr=+o.d.slice(0,4), y0=Date.UTC(yr,0,1), y1=Date.UTC(yr+1,0,1); return {p:o.p, yr, yf:(Date.parse(o.d)-y0)/((y1-y0)||1)}; });
// monthly closes (last weekly obs in each month) for rolling month-over-month %
const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
const MCLOSE={}; for(const o of FTSE_RAW){ MCLOSE[o.d.slice(0,7)]=o.p; }
function momPct(yr,mIdx){ const mk=`${yr}-${String(mIdx+1).padStart(2,'0')}`; const pmk = mIdx===0?`${yr-1}-12`:`${yr}-${String(mIdx).padStart(2,'0')}`; const a=MCLOSE[pmk], b=MCLOSE[mk]; return (a&&b)?(b/a-1)*100:null; }
// year-end close / year-open per year -> calendar-year price return (Dec-to-Dec) for the 5-year trail
const YROPEN={}, YRCLOSE={}; { const fd={},ld={}; for(const o of FTSE_RAW){ const y=+o.d.slice(0,4); if(fd[y]===undefined||o.d<fd[y]){fd[y]=o.d;YROPEN[y]=o.p;} if(ld[y]===undefined||o.d>ld[y]){ld[y]=o.d;YRCLOSE[y]=o.p;} } }
const ANNRET={}; for(const y in YRCLOSE){ const base=(YRCLOSE[+y-1]!==undefined)?YRCLOSE[+y-1]:YROPEN[y]; ANNRET[y]=(YRCLOSE[y]/base-1)*100; }

// layout
const PANEL = { x: 1030, y: 204, w: 870, h: 870 };
const M = { top: 200, left: 430, bottom: 42 };
const BARMAX = 1310, chartW = BARMAX-M.left, chartH = H-M.top-M.bottom;
// vertical compression: 1 during the race; the outro eases down to CZ_OUTRO so all 10 final bars clear the closing-question band
const CZ_OUTRO = +(cfg.cz_outro || 0.715), CZ_EASE_FR = 24;
let CZ = 1;
const rowH0 = chartH/TOPN;
const rowH_ = () => rowH0*CZ, barH_ = () => rowH0*CZ*0.82;
const rowY = r => M.top+r*rowH_()+(rowH_()-barH_())/2;
const fadeEdge_ = () => M.top+(TOPN-0.30)*rowH_();
const lerp=(a,b,t)=>a+(b-a)*t, clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const val = comps.map(c=>c.vals.map(v=>v==null?0:v));
const hasv = comps.map(c=>c.vals.map(v=>v!=null&&v>0));
const vAt=(ci,yi)=>{const i=Math.floor(yi),f=yi-i,j=Math.min(i+1,years.length-1);const a=hasv[ci][i]?val[ci][i]:0,b=hasv[ci][j]?val[ci][j]:0;return lerp(a,b,f);};
// USD companion (secondary equivalent shown under the local-currency figure)
const USD_ON = !!(process.env.SHOW_USD || cfg.show_usd);
const USDMAP = (()=>{ const p=`${ROOT}/${cfg.usd_data||'uk_race_usd.json'}`; return (USD_ON && fs.existsSync(p)) ? JSON.parse(fs.readFileSync(p,'utf8')) : null; })();
const usdAt=(label,yi)=>{ const a=USDMAP&&USDMAP[label]; if(!a) return null; const i=Math.floor(yi),f=yi-i,j=Math.min(i+1,years.length-1); const p=a[i], q=a[j]; if(p==null&&q==null) return null; return lerp(p||0,q||0,f); };
const fmt=v=>unit+v.toLocaleString('en-GB',{minimumFractionDigits:1,maximumFractionDigits:1})+suffix;
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const fit=(n,base,mw)=>{const w=n.length*base*0.55;return w>mw?Math.max(16,Math.floor(base*mw/w)):base;};

function drawPanel(s, year, fYear){
  // fYear 0..1 through the year: macro card for the first half, company card for the second half
  const F=150,X=PANEL.x,Y=PANEL.y,Wd=PANEL.w,Hd=PANEL.h;
  const draw=(href,op)=>{ if(!href||op<=0) return;
    s.push(`<g opacity="${op.toFixed(3)}"><image x="${X}" y="${Y}" width="${Wd}" height="${Hd}" href="${href}" preserveAspectRatio="xMidYMid slice"/>`);
    s.push(`<rect x="${X}" y="${Y}" width="${Wd}" height="${F}" fill="url(#fT)"/><rect x="${X}" y="${Y+Hd-F}" width="${Wd}" height="${F}" fill="url(#fB)"/><rect x="${X}" y="${Y}" width="${F}" height="${Hd}" fill="url(#fL)"/><rect x="${X+Wd-F}" y="${Y}" width="${F}" height="${Hd}" fill="url(#fR)"/></g>`);
  };
  const xf=XF/YEAR_SEC;                                  // crossfade width in year-fraction
  const LAST=years[years.length-1];
  const macro=MACROB64[year], co=COB64[year];
  // normal year-end crosses to next year's macro; the final year's end lands on & holds its own company card
  const nextCard = (year+1>LAST) ? null : ((year+1===LAST) ? (COB64[year+1]||MACROB64[year+1]) : MACROB64[year+1]);
  if(fYear < 0.5-xf) draw(macro,1);
  else if(fYear < 0.5){ const t=(fYear-(0.5-xf))/xf; draw(macro,1-t); draw(co,t); }   // mid-year: macro -> company
  else if(fYear < 1-xf) draw(co,1);
  else if(nextCard){ const t=(fYear-(1-xf))/xf; draw(co,1-t); draw(nextCard,t); }     // year end: company -> next card
  else draw(co,1);                                                                    // final year: hold company card
}

function drawFtse(s, yiC, hold){ // per-year index sparkline + scoreboard + £100 investment tracker (top-right)
  if(!FTSE.length) return;
  const lastYr=years[years.length-1];
  // segment k (yiC in [k,k+1)) IS calendar year years[k]+1: bars travel from that year's opening standings to its close
  let yr = hold ? lastYr : Math.floor(years[0]+yiC+1e-6)+1;
  if(yr>lastYr) yr=lastYr;
  let frac = hold ? 1 : clamp(yiC-Math.floor(yiC),0,1);   // progress through the current year
  const isFinal = yr>=lastYr;
  if(isFinal && hold) frac=1;                              // outro holds the full line; during the race the final year animates (frac = yiC - lastIndex)
  const yp=FTSE.filter(o=>o.yr===yr); if(yp.length<2) return;
  const box={x:1385,y:44,w:290,h:150};
  const maxYf=Math.max(...yp.map(o=>o.yf));
  if(isFinal && !hold) frac*=maxYf;                        // part-year final: sweep the available data across the whole segment
  const xs=(isFinal && maxYf>0.05)?1/maxYf:1;              // stretch a part-year final line to fill the box
  const pmin=Math.min(...yp.map(o=>o.p)), pmax=Math.max(...yp.map(o=>o.p));
  const X=f=>box.x+box.w*clamp(f*xs,0,1), Y=p=>box.y+box.h-box.h*((p-pmin)/((pmax-pmin)||1));
  let pts=[], tip=null, curPrice=null;
  for(let i=0;i<yp.length;i++){ if(yp[i].yf<=frac){ pts.push([X(yp[i].yf),Y(yp[i].p)]); curPrice=yp[i].p; } else break; }
  for(let i=1;i<yp.length;i++){ if(yp[i].yf>=frac){ const a=yp[i-1],b=yp[i],t=(frac-a.yf)/((b.yf-a.yf)||1); curPrice=lerp(a.p,b.p,t); tip=[X(frac),Y(curPrice)]; pts.push(tip); break; } }
  if(!tip && pts.length) tip=pts[pts.length-1];
  if(pts.length>1){
    const d=pts.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' ');
    s.push(`<path d="${d}" fill="none" stroke="${GOLD}" stroke-opacity="0.18" stroke-width="7" stroke-linejoin="round" stroke-linecap="round"/>`);
    s.push(`<path d="${d}" fill="none" stroke="${GOLD}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`);
  }
  if(tip){ s.push(`<circle cx="${tip[0].toFixed(1)}" cy="${tip[1].toFixed(1)}" r="9" fill="${GOLD}" fill-opacity="0.25"/><circle cx="${tip[0].toFixed(1)}" cy="${tip[1].toFixed(1)}" r="5" fill="${GOLD}"/>`); }
  // index scoreboard (top-right, right-aligned): current-year YTD cumulative % + last 5 completed years
  const xR=1892, colr=v=>v>=0?'#35c281':'#e5565b', sg=v=>v>=0?'+':'';
  const base = (YRCLOSE[yr-1]!==undefined)?YRCLOSE[yr-1]:yp[0].p;   // prior year-end close (Dec-to-Dec YTD)
  const ytd = (curPrice!=null && base) ? (curPrice/base-1)*100 : null;
  if(ytd!=null) s.push(`<text x="${xR}" y="88" text-anchor="end" font-size="32" font-weight="700"><tspan fill="#eef3f7">${yr}: </tspan><tspan fill="${colr(ytd)}">${sg(ytd)}${ytd.toFixed(1)}%</tspan></text>`);
  let ty=120;
  for(let y=yr-1; y>=yr-5; y--){ const r=ANNRET[y]; if(r===undefined) continue;
    s.push(`<text x="${xR}" y="${ty}" text-anchor="end" font-size="22" font-weight="600"><tspan fill="#8ea6b6">${y}: </tspan><tspan fill="${colr(r)}">${sg(r)}${r.toFixed(1)}%</tspan></text>`); ty+=23; }
  // ---- £100 investment tracker: value of 100 invested at the start, total return, and CAGR ----
  if(curPrice!=null){
    const start=FTSE_RAW[0].p, val=100*curPrice/start, tot=val-100;
    const elapsed=(yr-years[0])+Math.min(frac, isFinal?maxYf:1);
    const cagr=elapsed>0.75?((Math.pow(val/100,1/elapsed)-1)*100):null;
    const cy=ty+24;
    s.push(`<rect x="1556" y="${cy-26}" width="352" height="118" rx="14" fill="#0b1220" fill-opacity="0.55"/>`);
    s.push(`<text x="${xR}" y="${cy}" text-anchor="end" font-size="18" font-weight="700" fill="#8ea6b6">${unit}100 IN THE ${INDEX_NAME} · ${years[0]}</text>`);
    s.push(`<text x="${xR}" y="${cy+40}" text-anchor="end" font-size="34" font-weight="700"><tspan fill="#eef3f7">${unit}${val.toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2})}</tspan><tspan fill="${colr(tot)}" font-size="26">  ${sg(tot)}${tot.toFixed(1)}%</tspan></text>`);
    if(cagr!=null) s.push(`<text x="${xR}" y="${cy+72}" text-anchor="end" font-size="20" font-weight="600"><tspan fill="#8ea6b6">CAGR </tspan><tspan fill="${colr(cagr)}">${sg(cagr)}${cagr.toFixed(1)}% / yr</tspan></text>`);
  }
}

function frameSVG(fr, mode){ // mode: 'race' or 'outro'
  const raceFrames = FR_PER*(years.length-1);
  if(mode==='outro'){ const t=clamp((fr-raceFrames)/CZ_EASE_FR,0,1); CZ = lerp(1, CZ_OUTRO, t*t*(3-2*t)); } else CZ = 1;
  const rowH = rowH_(), barH = barH_(), FADE_EDGE = fadeEdge_();
  const yiC = mode==='outro' ? years.length-1 : Math.min(years.length-1, fr/FR_PER);
  const yiS = Math.min(yiC, years.length-1-1e-9);          // label/index/panel clock (segment k is calendar year years[k]+1)
  const yearNow=Math.floor(years[0]+yiS+1e-6)+1;
  const now=comps.map((c,ci)=>({ci,v:vAt(ci,yiC)}));
  const ranked=now.filter(o=>o.v>0).sort((a,b)=>b.v-a.v);
  const rankOf=new Array(comps.length).fill(TOPN+3); ranked.forEach((o,r)=>rankOf[o.ci]=r);
  const kk = mode==='outro'?1:K;
  for(let ci=0;ci<comps.length;ci++){const tgt=rowY(Math.min(rankOf[ci],TOPN+2));curY[ci]=curY[ci]==null?tgt:curY[ci]+(tgt-curY[ci])*kk;}
  if(fr<0) return null;
  if(process.env.RSTART!==undefined && (fr<+process.env.RSTART || fr>=+process.env.REND)) return null; // chunk render: update state only, skip drawing
  const xmax=Math.max(...ranked.slice(0,TOPN).map(o=>o.v),1)*1.16, x=v=>chartW*(v/xmax);
  const vis=now.filter(o=>o.v>0&&curY[o.ci]<FADE_EDGE+2).sort((a,b)=>curY[b.ci]-curY[a.ci]);
  const fYear = yiS-Math.floor(yiS);

  const s=[`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="${FF}">`];
  s.push(`<defs>`+
    `<linearGradient id="fT" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${BG}"/><stop offset="1" stop-color="${BG}" stop-opacity="0"/></linearGradient>`+
    `<linearGradient id="fB" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${BG}"/><stop offset="1" stop-color="${BG}" stop-opacity="0"/></linearGradient>`+
    `<linearGradient id="fL" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${BG}"/><stop offset="1" stop-color="${BG}" stop-opacity="0"/></linearGradient>`+
    `<linearGradient id="fR" x1="1" y1="0" x2="0" y2="0"><stop offset="0" stop-color="${BG}"/><stop offset="1" stop-color="${BG}" stop-opacity="0"/></linearGradient></defs>`);
  if(!process.env.TRANSPARENT) s.push(`<rect width="${W}" height="${H}" fill="${BG}"/>`);
  if(mode!=='outro'){ if(PANEL_MODE){ drawPanel(s, yearNow, fYear); drawFtse(s, yiS, false); } else drawFtse(s, yiS, false); }   // event panel + live index line/scoreboard
  else { if(PANEL_MODE) drawPanel(s, years[years.length-1], 1); drawFtse(s, 0, true); }   // outro: hold final panel + index scoreboard/investment
  s.push(`<text x="${M.left}" y="80" font-family="${TITLE_FF}" font-size="50" font-weight="700" fill="#eef3f7">${esc(cfg.title)}</text>`);
  s.push(`<text x="${M.left}" y="120" font-family="${TITLE_FF}" font-size="26" fill="#8ba1b0">${esc(cfg.subtitle)}</text>`);
  for(let t=0;t<=5;t++){const gv=xmax*t/5,gx=M.left+x(gv);s.push(`<line x1="${gx}" y1="${M.top-8}" x2="${gx}" y2="${M.top+chartH*CZ}" stroke="#ffffff" stroke-opacity="0.05"/><text x="${gx}" y="${M.top-18}" font-size="20" fill="#5f7383" text-anchor="middle">${fmt(gv)}</text>`);}
  for(const o of vis){
    const c=comps[o.ci],y=curY[o.ci],a=clamp((FADE_EDGE-y)/rowH,0,1);
    const w=Math.max(3,x(o.v)),barEnd=M.left+w;
    const nm=fit(c.label,30,M.left-30);
    s.push(`<g opacity="${a.toFixed(3)}">`);
    s.push(`<rect x="${M.left}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${barH.toFixed(1)}" fill="${col(c)}"/>`);
    s.push(`<text x="${(M.left-22).toFixed(1)}" y="${(y+barH/2+9).toFixed(1)}" font-size="${nm}" font-weight="700" fill="#eaf0f4" text-anchor="end">${esc(c.label)}</text>`);
    // (company logos removed per request)
    const isz=barH*0.60; const I=ICONS[c.sub];
    if(w>isz+34 && I) s.push(`<svg x="${(barEnd-isz-16).toFixed(1)}" y="${(y+(barH-isz)/2).toFixed(1)}" width="${isz.toFixed(1)}" height="${isz.toFixed(1)}" viewBox="0 0 ${I.w} ${I.h}"><g fill="#ffffff" fill-opacity="0.92">${I.body}</g></svg>`);
    const u = USD_ON ? usdAt(c.label, yiC) : null;
    const vy = (u!=null&&u>0) ? (y+barH/2-4) : (y+barH/2+9);
    s.push(`<text x="${(barEnd+16).toFixed(1)}" y="${vy.toFixed(1)}" font-size="28" font-weight="600" fill="#ffffff">${fmt(o.v)}</text>`);
    if(u!=null&&u>0) s.push(`<text x="${(barEnd+16).toFixed(1)}" y="${(y+barH/2+22).toFixed(1)}" font-size="18" fill="#8ea6b6">($${u.toLocaleString('en-GB',{minimumFractionDigits:1,maximumFractionDigits:1})}bn)</text>`);
    s.push(`</g>`);
  }
  // (year ring removed — the live FTSE line now carries the year + level)
  if(MMLOGO) s.push(`<image x="40" y="26" width="354" height="112" href="${MMLOGO}" preserveAspectRatio="xMinYMid meet"/>`);   // placed 1:1 (native 354x112) — no scaling
  if(mode==='outro'){
    const qh=124, qy=H-132-qh;   // closing question band above the subscribe bar
    s.push(`<rect x="0" y="${qy}" width="${W}" height="${qh}" fill="#0b1220" fill-opacity="0.9"/>`);
    s.push(`<text x="${W/2}" y="${qy+52}" text-anchor="middle" font-size="40" font-weight="700" fill="#eef3f7">How will the ${INDEX_NAME} perform in ${years[years.length-1]+1}?</text>`);
    s.push(`<text x="${W/2}" y="${qy+98}" text-anchor="middle" font-size="30" font-weight="600" fill="${GOLD}">Share your prediction in the comments below</text>`);
    const bh=132; s.push(`<rect x="0" y="${H-bh}" width="${W}" height="${bh}" fill="#0b1220" fill-opacity="0.86"/><rect x="0" y="${H-bh}" width="${W}" height="5" fill="${ACCENT}"/>`);
    s.push(`<text x="70" y="${H-bh+62}" font-size="52" font-weight="700" fill="#f0f4f8">SUBSCRIBE     •     LIKE     •     COMMENT</text>`);
    s.push(`<text x="72" y="${H-bh+108}" font-size="28" font-weight="600" fill="#96aab9">for more Market Marathon bar chart races</text>`);
  }
  s.push(`</svg>`);
  return s.join('');
}

const FR_PER = Math.round(YEAR_SEC*FPS);
const curY = new Array(comps.length).fill(null);
const raceFrames = FR_PER*(years.length-1);              // one segment per calendar year years[0]+1 .. years[N-1]; the final (part-)year animates in its own segment
const outroFrames = Math.round(OUTRO_SEC*FPS);
const SERIF_PATH = `${ROOT}/fonts/SourceSerif4-SemiBold.ttf`;
const FONTOPT = ALL_SERIF
  ? {loadSystemFonts:false, fontFiles:[SERIF_PATH], defaultFontFamily:'SourceSerif4 SemiBold'}   // only serif loaded -> everything renders serif
  : {loadSystemFonts:false, fontBuffers:FONT_BUFFERS, fontFiles:[SERIF_PATH], defaultFontFamily:FF};
const opts = { fitTo:{mode:'width',value:+(process.env.RASTER_W||W)}, font:FONTOPT };

const ff = process.env.FRAMES_DIR ? null : spawn('ffmpeg',['-y','-f','image2pipe','-c:v','png','-r',String(FPS),'-i','pipe:0',
  ...(cfg.music?['-stream_loop','-1','-i',`${ROOT}/${cfg.music}`]:[]),
  '-c:v','libx264','-crf', String(cfg.crf||16),'-preset', cfg.preset||'medium','-pix_fmt','yuv420p',
  ...(cfg.music?['-filter_complex','[1:a]volume=0.65,afade=t=in:st=0:d=2[a]','-map','0:v','-map','[a]','-c:a','aac','-b:a','192k','-shortest']:[]),
  '-movflags','+faststart', OUT], {stdio:['pipe','inherit','inherit']});
const write = buf => new Promise(res=>{ if(ff.stdin.write(buf)) res(); else ff.stdin.once('drain',res); });

if(process.env.FRAMES_DIR){
  // CHUNK MODE: rasterize frames in [RSTART,REND) to PNGs on disk (state fast-forwarded for earlier frames)
  const dir=process.env.FRAMES_DIR; fs.mkdirSync(dir,{recursive:true});
  const RF = Math.min(raceFrames, +(process.env.MAXFR||raceFrames));
  const t0=Date.now(); let n=0;
  for(let fr=0; fr<RF; fr++){ const svg=frameSVG(fr,'race'); if(!svg) continue; fs.writeFileSync(`${dir}/f_${String(fr).padStart(6,'0')}.png`, new Resvg(svg,opts).render().asPng()); n++; }
  console.error(`wrote ${n} frames [${process.env.RSTART}-${process.env.REND}) in ${((Date.now()-t0)/1000).toFixed(0)}s`);
} else {
  (async()=>{
    const t0=Date.now(); let n=0;
    const RF = Math.min(raceFrames, +(process.env.MAXFR||raceFrames));
    for(let fr=0; fr<RF; fr++){ const svg=frameSVG(fr,'race'); if(!svg) continue; await write(new Resvg(svg,opts).render().asPng()); if(++n%600===0) console.error(`frame ${n}/${raceFrames+outroFrames}`); }
    if(!process.env.NOOUTRO) for(let fr=0; fr<outroFrames; fr++){ await write(new Resvg(frameSVG(raceFrames+fr,'outro'),opts).render().asPng()); if(++n%600===0) console.error(`frame ${n}/${raceFrames+outroFrames}`); }
    ff.stdin.end();
    console.error(`piped ${n} frames in ${((Date.now()-t0)/1000).toFixed(0)}s`);
  })();
  ff.on('close',c=>console.error('ffmpeg exit',c));
}
