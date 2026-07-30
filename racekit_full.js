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
const BG = cfg.bg || '#0F1420', ACCENT = cfg.accent || '#2EC4B6';
const OUT = cfg.out || 'master.mp4';

const FONT_BUFFERS = ['400','600','700'].map(w => fs.readFileSync(`${ROOT}/fonts/IBMPlexSans-${w}.ttf`));
const FF = 'IBM Plex Sans';
const LOGOS = JSON.parse(fs.readFileSync(`${ROOT}/logos.json`,'utf8'));
const ICONS = JSON.parse(fs.readFileSync(`${ROOT}/subsector_icons.json`,'utf8'));
const data = JSON.parse(fs.readFileSync(`${ROOT}/${cfg.data}`,'utf8'));
const years = data.years.map(Number), comps = data.companies, colours = data.colours||{};
const unit = data.unit ?? cfg.unit ?? '£', suffix = data.suffix ?? cfg.suffix ?? 'bn';
const col = c => colours[c.sub] || '#4A6572';

// preload company logos (base64) + MM logo + quarter panels (base64)
const b64 = p => 'data:image/png;base64,'+fs.readFileSync(p).toString('base64');
const LOGOIMG = {}; for(const c of comps){ const p=`${ROOT}/company_logos/${c.label}.png`; if(fs.existsSync(p)) LOGOIMG[c.label]=b64(p); }
const MMLOGO = fs.existsSync(`${ROOT}/logo.png`) ? b64(`${ROOT}/logo.png`) : null;
const PANEL_DIR = `${ROOT}/panels`;
const PANELB64 = {}; if(fs.existsSync(PANEL_DIR)) for(const f of fs.readdirSync(PANEL_DIR)) if(f.endsWith('.png')) PANELB64[f.replace('.png','')]=b64(`${PANEL_DIR}/${f}`);

// layout
const PANEL = { x: 1030, y: 204, w: 870, h: 870 };
const M = { top: 200, left: 430, bottom: 42 };
const BARMAX = 1310, chartW = BARMAX-M.left, chartH = H-M.top-M.bottom;
const rowH = chartH/TOPN, barH = rowH*0.88, rowY = r => M.top+r*rowH+(rowH-barH)/2;
const FADE_EDGE = M.top+(TOPN-0.30)*rowH;
const lerp=(a,b,t)=>a+(b-a)*t, clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const val = comps.map(c=>c.vals.map(v=>v==null?0:v));
const hasv = comps.map(c=>c.vals.map(v=>v!=null&&v>0));
const vAt=(ci,yi)=>{const i=Math.floor(yi),f=yi-i,j=Math.min(i+1,years.length-1);const a=hasv[ci][i]?val[ci][i]:0,b=hasv[ci][j]?val[ci][j]:0;return lerp(a,b,f);};
const fmt=v=>unit+v.toLocaleString('en-GB',{minimumFractionDigits:1,maximumFractionDigits:1})+suffix;
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const fit=(n,base,mw)=>{const w=n.length*base*0.55;return w>mw?Math.max(16,Math.floor(base*mw/w)):base;};

function panelKey(year,q){ // q 0..3 -> file like UK_2008_Q1 ; fall back to nearest available
  const k=`${cfg.file_prefix||'UK'}_${year}_Q${q+1}`; return PANELB64[k]?k:null;
}
function drawPanel(s, year, fYear){
  // fYear: 0..1 progress through the year -> quarter index + crossfade
  const qf=fYear*4, q=Math.min(3,Math.floor(qf)), within=qf-q;
  const cur=panelKey(year,q);
  const draw=(key,op)=>{ if(!key||op<=0) return;
    s.push(`<g opacity="${op.toFixed(3)}"><image x="${PANEL.x}" y="${PANEL.y}" width="${PANEL.w}" height="${PANEL.h}" href="${PANELB64[key]}" preserveAspectRatio="xMidYMid slice"/>`);
    // feather edges into background
    const F=150,X=PANEL.x,Y=PANEL.y,Wd=PANEL.w,Hd=PANEL.h;
    s.push(`<rect x="${X}" y="${Y}" width="${Wd}" height="${F}" fill="url(#fT)"/><rect x="${X}" y="${Y+Hd-F}" width="${Wd}" height="${F}" fill="url(#fB)"/><rect x="${X}" y="${Y}" width="${F}" height="${Hd}" fill="url(#fL)"/><rect x="${X+Wd-F}" y="${Y}" width="${F}" height="${Hd}" fill="url(#fR)"/></g>`);
  };
  // crossfade window near end of each quarter
  const t0=(q+1)/4;                     // boundary progress
  if(within > 1-(XF/(YEAR_SEC/4)) && q<3){ const nx=panelKey(year,q+1); const cf=(within-(1-(XF/(YEAR_SEC/4))))/(XF/(YEAR_SEC/4)); draw(cur,1-cf); draw(nx,cf); }
  else draw(cur,1);
}

function frameSVG(fr, mode){ // mode: 'race' or 'outro'
  const raceFrames = FR_PER*(years.length-1);
  const yiC = mode==='outro' ? years.length-1 : Math.min(years.length-1, fr/FR_PER);
  const yearNow=Math.floor(years[0]+yiC+1e-6);
  const now=comps.map((c,ci)=>({ci,v:vAt(ci,yiC)}));
  const ranked=now.filter(o=>o.v>0).sort((a,b)=>b.v-a.v);
  const rankOf=new Array(comps.length).fill(TOPN+3); ranked.forEach((o,r)=>rankOf[o.ci]=r);
  const kk = mode==='outro'?1:K;
  for(let ci=0;ci<comps.length;ci++){const tgt=rowY(Math.min(rankOf[ci],TOPN+2));curY[ci]=curY[ci]==null?tgt:curY[ci]+(tgt-curY[ci])*kk;}
  if(fr<0) return null;
  const xmax=Math.max(...ranked.slice(0,TOPN).map(o=>o.v),1)*1.16, x=v=>chartW*(v/xmax);
  const vis=now.filter(o=>o.v>0&&curY[o.ci]<FADE_EDGE+2).sort((a,b)=>curY[b.ci]-curY[a.ci]);
  const fYear = (yiC>=years.length-1)?1:(yiC-Math.floor(yiC));

  const s=[`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="${FF}">`];
  s.push(`<defs>`+
    `<linearGradient id="fT" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${BG}"/><stop offset="1" stop-color="${BG}" stop-opacity="0"/></linearGradient>`+
    `<linearGradient id="fB" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${BG}"/><stop offset="1" stop-color="${BG}" stop-opacity="0"/></linearGradient>`+
    `<linearGradient id="fL" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${BG}"/><stop offset="1" stop-color="${BG}" stop-opacity="0"/></linearGradient>`+
    `<linearGradient id="fR" x1="1" y1="0" x2="0" y2="0"><stop offset="0" stop-color="${BG}"/><stop offset="1" stop-color="${BG}" stop-opacity="0"/></linearGradient></defs>`);
  s.push(`<rect width="${W}" height="${H}" fill="${BG}"/>`);
  if(mode!=='outro') drawPanel(s, yearNow, fYear);   // event image behind bars (not in outro; keep right clear)
  s.push(`<text x="${M.left}" y="80" font-size="50" font-weight="700" fill="#eef3f7">${esc(cfg.title)}</text>`);
  s.push(`<text x="${M.left}" y="120" font-size="26" fill="#8ba1b0">${esc(cfg.subtitle)}</text>`);
  for(let t=0;t<=5;t++){const gv=xmax*t/5,gx=M.left+x(gv);s.push(`<line x1="${gx}" y1="${M.top-8}" x2="${gx}" y2="${M.top+chartH}" stroke="#ffffff" stroke-opacity="0.05"/><text x="${gx}" y="${M.top-18}" font-size="20" fill="#5f7383" text-anchor="middle">${fmt(gv)}</text>`);}
  for(const o of vis){
    const c=comps[o.ci],y=curY[o.ci],a=clamp((FADE_EDGE-y)/rowH,0,1);
    const w=Math.max(3,x(o.v)),barEnd=M.left+w;
    const lsz=barH*0.66, lx=M.left-16-lsz, ly=y+(barH-lsz)/2, nm=fit(c.label,30,lx-14);
    s.push(`<g opacity="${a.toFixed(3)}">`);
    s.push(`<rect x="${M.left}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${barH.toFixed(1)}" fill="${col(c)}"/>`);
    s.push(`<text x="${(lx-14).toFixed(1)}" y="${(y+barH/2+9).toFixed(1)}" font-size="${nm}" font-weight="700" fill="#eaf0f4" text-anchor="end">${esc(c.label)}</text>`);
    if(LOGOIMG[c.label]) s.push(`<image x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" width="${lsz.toFixed(1)}" height="${lsz.toFixed(1)}" href="${LOGOIMG[c.label]}" preserveAspectRatio="xMidYMid meet"/>`);
    const isz=barH*0.60; const I=ICONS[c.sub];
    if(w>isz+34 && I) s.push(`<svg x="${(barEnd-isz-16).toFixed(1)}" y="${(y+(barH-isz)/2).toFixed(1)}" width="${isz.toFixed(1)}" height="${isz.toFixed(1)}" viewBox="0 0 ${I.w} ${I.h}"><g fill="#ffffff" fill-opacity="0.92">${I.body}</g></svg>`);
    s.push(`<text x="${(barEnd+16).toFixed(1)}" y="${(y+barH/2+9).toFixed(1)}" font-size="28" font-weight="600" fill="#ffffff">${fmt(o.v)}</text></g>`);
  }
  // year ring
  const cx=W-152, cy=150, R=92, sw=9;
  s.push(`<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="#ffffff" stroke-opacity="0.13" stroke-width="${sw}"/>`);
  if(fYear>=0.999){ s.push(`<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${ACCENT}" stroke-width="${sw}"/>`); }
  else if(fYear>0.002){ const a0=-Math.PI/2,a1=a0+fYear*2*Math.PI,x0=(cx+R*Math.cos(a0)).toFixed(2),y0=(cy+R*Math.sin(a0)).toFixed(2),x1=(cx+R*Math.cos(a1)).toFixed(2),y1=(cy+R*Math.sin(a1)).toFixed(2),lg=fYear>0.5?1:0; s.push(`<path d="M ${x0} ${y0} A ${R} ${R} 0 ${lg} 1 ${x1} ${y1}" fill="none" stroke="${ACCENT}" stroke-width="${sw}" stroke-linecap="round"/>`); }
  s.push(`<text x="${cx}" y="${cy+22}" font-size="62" font-weight="700" fill="#ffffff" text-anchor="middle">${yearNow}</text>`);
  if(MMLOGO) s.push(`<image x="40" y="24" height="90" width="300" href="${MMLOGO}" preserveAspectRatio="xMinYMid meet"/>`);
  if(mode==='outro'){
    const bh=132; s.push(`<rect x="0" y="${H-bh}" width="${W}" height="${bh}" fill="#0b1220" fill-opacity="0.86"/><rect x="0" y="${H-bh}" width="${W}" height="5" fill="${ACCENT}"/>`);
    s.push(`<text x="70" y="${H-bh+62}" font-size="52" font-weight="700" fill="#f0f4f8">SUBSCRIBE     •     LIKE     •     COMMENT</text>`);
    s.push(`<text x="72" y="${H-bh+108}" font-size="28" font-weight="600" fill="#96aab9">for more Market Marathon bar chart races</text>`);
  }
  s.push(`</svg>`);
  return s.join('');
}

const FR_PER = Math.round(YEAR_SEC*FPS);
const curY = new Array(comps.length).fill(null);
const raceFrames = FR_PER*(years.length-1) + Math.round(0.6*FPS);
const outroFrames = Math.round(OUTRO_SEC*FPS);
const opts = { fitTo:{mode:'width',value:W}, font:{loadSystemFonts:false,fontBuffers:FONT_BUFFERS,defaultFontFamily:FF} };

const ff = spawn('ffmpeg',['-y','-f','image2pipe','-c:v','png','-r',String(FPS),'-i','pipe:0',
  ...(cfg.music?['-stream_loop','-1','-i',`${ROOT}/${cfg.music}`]:[]),
  '-c:v','libx264','-crf', String(cfg.crf||16),'-preset', cfg.preset||'medium','-pix_fmt','yuv420p',
  ...(cfg.music?['-filter_complex','[1:a]volume=0.65,afade=t=in:st=0:d=2[a]','-map','0:v','-map','[a]','-c:a','aac','-b:a','192k','-shortest']:[]),
  '-movflags','+faststart', OUT], {stdio:['pipe','inherit','inherit']});
const write = buf => new Promise(res=>{ if(ff.stdin.write(buf)) res(); else ff.stdin.once('drain',res); });

(async()=>{
  const t0=Date.now(); let n=0;
  for(let fr=0; fr<raceFrames; fr++){ await write(new Resvg(frameSVG(fr,'race'),opts).render().asPng()); if(++n%600===0) console.error(`frame ${n}/${raceFrames+outroFrames}`); }
  for(let fr=0; fr<outroFrames; fr++){ await write(new Resvg(frameSVG(raceFrames,'outro'),opts).render().asPng()); if(++n%600===0) console.error(`frame ${n}/${raceFrames+outroFrames}`); }
  ff.stdin.end();
  console.error(`piped ${n} frames in ${((Date.now()-t0)/1000).toFixed(0)}s`);
})();
ff.on('close',c=>console.error('ffmpeg exit',c));
