const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { readData, writeData, getSiteHTML, putSiteHTML } = require('../lib/github-data');

const START = '<!-- PREMIUM-CUSTOM:START -->';
const END = '<!-- PREMIUM-CUSTOM:END -->';
const DRY_RUN = process.env.CUSTOMIZE_DRY_RUN === '1';

const EFFECTS = new Set(['fadeup', 'blurin', 'zoom', 'letters', 'wave', 'flip', 'typewriter', 'scramble', 'gradient', 'shimmer', 'glow']);

// ── Snippet generator ─────────────────────────────────────────────────────────
// One self-contained <style>+<script> block, vanilla JS, no external deps.
// Durations are CSS variables so global + per-element speeds both work.
// cfg.preview=true → splash replays every load (no sessionStorage guard).

function buildSnippet(cfg) {
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c');
  const c1 = cfg.fx?.c1 || '#8b5cf6';
  const c2 = cfg.fx?.c2 || '#ec4899';
  return `${START}
<style>
.oc-splash{position:fixed;inset:0;background:${cfg.splash?.bg || '#0a0a0f'};z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;transition:opacity .6s;cursor:pointer}
.oc-splash-grid{display:grid;gap:3px;margin-bottom:52px}
.oc-brick{width:var(--oc-cell,13px);height:var(--oc-cell,13px);border-radius:2px;opacity:0;transform:scale(.5);transition:opacity .35s,transform .35s cubic-bezier(.34,1.56,.64,1)}
.oc-splash.oc-built .oc-brick{opacity:1;transform:scale(1)}
.oc-splash-text{font:700 18px system-ui,sans-serif;letter-spacing:1px;opacity:0;transform:translateY(10px);transition:opacity .6s,transform .6s}
.oc-splash.oc-built .oc-splash-text{opacity:1;transform:none}
.oc-splash-skip{position:absolute;bottom:22px;right:26px;font:600 11px system-ui;color:#ffffff55;letter-spacing:.5px}
@media(max-width:520px){.oc-splash{--oc-cell:3.4vw}}
.oc-fu{opacity:0;transform:translateY(46px);filter:blur(6px);transition:opacity var(--oc-dur,1.1s) cubic-bezier(.16,1,.3,1),transform var(--oc-dur,1.1s) cubic-bezier(.16,1,.3,1),filter var(--oc-dur,1.1s) ease}
.oc-fu.oc-vis{opacity:1;transform:none;filter:blur(0)}
.oc-blur{opacity:0;filter:blur(18px);transform:scale(1.05);transition:opacity var(--oc-dur,1.5s) ease,filter var(--oc-dur,1.5s) ease,transform var(--oc-dur,1.5s) ease}
.oc-blur.oc-vis{opacity:1;filter:blur(0);transform:none}
.oc-zoom{opacity:0;transform:scale(.35);transition:transform var(--oc-dur,.95s) cubic-bezier(.34,1.56,.64,1),opacity calc(var(--oc-dur,.95s)*.6) ease}
.oc-zoom.oc-vis{opacity:1;transform:none}
.oc-grad{background:linear-gradient(90deg,${c1},${c2},${c1});background-size:200% auto;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;animation:ocGrad var(--oc-cycle,4s) linear infinite}
@keyframes ocGrad{to{background-position:200% center}}
.oc-shimmer{background:linear-gradient(110deg,${c1} 42%,#ffffff 50%,${c1} 58%);background-size:250% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;animation:ocShimmer var(--oc-cycle,2.8s) linear infinite}
@keyframes ocShimmer{from{background-position:125% center}to{background-position:-125% center}}
.oc-glow{color:${c1};animation:ocGlow var(--oc-cycle,2.6s) ease-in-out infinite}
@keyframes ocGlow{0%,100%{text-shadow:0 0 6px ${c1}88,0 0 16px ${c1}44}50%{text-shadow:0 0 8px #fff8,0 0 22px ${c1},0 0 48px ${c1},0 0 90px ${c2}}}
.oc-ltr{display:inline-block;opacity:0;transform:translateY(.8em);transition:opacity var(--oc-dur,.8s) ease,transform var(--oc-dur,.8s) cubic-bezier(.16,1,.3,1)}
.oc-vis .oc-ltr{opacity:1;transform:none}
.oc-wave .oc-ltr{transition-timing-function:ease,cubic-bezier(.34,2.4,.64,1)}
.oc-flip{perspective:600px}
.oc-flip .oc-ltr{transform:rotateX(92deg);transform-origin:50% 100%;transition:opacity var(--oc-dur,.7s) ease,transform var(--oc-dur,.7s) cubic-bezier(.34,1.56,.64,1)}
.oc-flip.oc-vis .oc-ltr{transform:none}
</style>
<script>
(function(){
var CFG=${json};
var PREVIEW=!!CFG.preview;
var NEEDS_TEXT={wave:1,letters:1,flip:1,typewriter:1,scramble:1};
var LOOPS={gradient:'oc-grad',shimmer:'oc-shimmer',glow:'oc-glow'};
function textOnly(el){return el.childNodes.length>0&&[].every.call(el.childNodes,function(n){return n.nodeType===3;});}
var io=null;
function getIO(){if(!io)io=new IntersectionObserver(function(es){es.forEach(function(e){
if(!e.isIntersecting)return;io.unobserve(e.target);
e.target.classList.add('oc-vis');
var fn=e.target.__ocRun;if(fn)fn();
});},{threshold:PREVIEW?0.05:0.3});return io;}
/* apply one effect to one element. o={effect,dur,stag,typeMs,scramMs,cycle} */
function fx(el,o){
var eff=o.effect;
if(NEEDS_TEXT[eff]&&!textOnly(el))eff='fadeup';
/* the site's own entrance scripts (e.g. GSAP) can leave inline styles that
   beat our classes — clear them so the chosen effect actually shows */
['opacity','transform','filter','visibility'].forEach(function(p){el.style.removeProperty(p);});
if(o.dur)el.style.setProperty('--oc-dur',o.dur+'s');
if(o.cycle)el.style.setProperty('--oc-cycle',o.cycle+'s');
if(LOOPS[eff]){el.classList.add(LOOPS[eff]);return;}
if(eff==='fadeup')el.classList.add('oc-fu');
else if(eff==='blurin')el.classList.add('oc-blur');
else if(eff==='zoom')el.classList.add('oc-zoom');
else if(eff==='wave'||eff==='letters'||eff==='flip'){
var stag=o.stag||0.055;
var txt=el.textContent;el.textContent='';
if(eff==='wave')el.classList.add('oc-wave');
if(eff==='flip')el.classList.add('oc-flip');
[].forEach.call(txt,function(ch,i){
var s=document.createElement('span');s.className='oc-ltr';
if(ch===' ')s.innerHTML='&nbsp;';else s.textContent=ch;
s.style.transitionDelay=(i*stag).toFixed(3)+'s';el.appendChild(s);});}
else if(eff==='typewriter'){
var ms=o.typeMs||48;
var full=el.textContent;el.textContent='';el.style.minHeight='1em';
el.__ocRun=function(){var i=0;(function tick(){
if(i<=full.length){el.textContent=full.slice(0,i);i++;setTimeout(tick,ms);}})();};}
else if(eff==='scramble'){
var totalMs=o.scramMs||2250,frameMs=45,total=Math.max(8,Math.round(totalMs/frameMs));
var target=el.textContent;var CH='abcdefghjkmnpqrstuvwxyz23456789';
el.__ocRun=function(){var f=0;(function tick(){
var out='';for(var i=0;i<target.length;i++){
if(target[i]===' '){out+=' ';continue;}
out+=(i<(f/total)*target.length)?target[i]:CH[Math.floor(Math.random()*CH.length)];}
el.textContent=out;f++;if(f<=total)setTimeout(tick,frameMs);else el.textContent=target;})();};
}
getIO().observe(el);
}
/* text animations start only after the splash is gone, so the hero
   isn't animating invisibly behind the overlay */
function startFx(){
if(startFx.done)return;startFx.done=true;
(CFG.overrides||[]).forEach(function(o){
if(!o.sel||!o.effect||o.effect==='none')return;
try{var el=document.querySelector(o.sel);
if(el&&!el.__ocDone&&!el.closest('.oc-splash')){el.__ocDone=1;fx(el,o);}}catch(e){}});
var F=CFG.fx;
if(F&&F.effect&&F.effect!=='none'){
var els=[].slice.call(document.querySelectorAll(F.scope||'h1,h2')).filter(function(el){
if(el.__ocDone)return false;
if(el.closest('nav,footer,.oc-splash'))return false;
if((el.textContent||'').trim().length>160)return false;
return true;});
els.forEach(function(el){el.__ocDone=1;fx(el,F);});
}
}
/* ── opening animation ── */
var S=CFG.splash,splashShown=false;
if(S&&S.enabled&&S.pattern&&(PREVIEW||!sessionStorage.getItem('ocSplashSeen'))&&!matchMedia('(prefers-reduced-motion: reduce)').matches){
splashShown=true;
if(!PREVIEW)sessionStorage.setItem('ocSplashSeen','1');
var P=S.pattern,ROWS=P.length,COLS=P[0].length;
var step=S.step||0.11,holdMs=S.hold||2000,brk=S.breakDur||1.5;
var ov=document.createElement('div');ov.className='oc-splash';
var g=document.createElement('div');g.className='oc-splash-grid';
g.style.gridTemplateColumns='repeat('+COLS+',var(--oc-cell,13px))';
var cr=(ROWS-1)/2,cc=(COLS-1)/2,bricks=[],maxD=0;
for(var r=0;r<ROWS;r++)for(var c=0;c<COLS;c++){
var d=document.createElement('div');
if(P[r][c]){d.className='oc-brick';d.style.background=S.color;
var dist=Math.hypot(r-cr,c-cc);if(dist>maxD)maxD=dist;
d.style.transitionDelay=(dist*step).toFixed(2)+'s';
bricks.push({el:d,r:r,c:c});}
else{d.style.cssText='width:var(--oc-cell,13px);height:var(--oc-cell,13px);visibility:hidden';}
g.appendChild(d);}
ov.appendChild(g);
var t=document.createElement('div');t.className='oc-splash-text';t.textContent=S.text||'';t.style.color=S.textColor||S.color;
ov.appendChild(t);
var skip=document.createElement('div');skip.className='oc-splash-skip';skip.textContent='click to skip';
ov.appendChild(skip);
var ended=false;
function endSplash(fast){
if(ended)return;ended=true;
ov.style.opacity='0';
setTimeout(function(){ov.remove();startFx();},fast?350:650);
}
ov.addEventListener('click',function(){endSplash(true);});
document.body.appendChild(ov);
requestAnimationFrame(function(){requestAnimationFrame(function(){ov.classList.add('oc-built');});});
var buildMs=maxD*step*1000+500;
setTimeout(function(){
if(ended)return;
bricks.forEach(function(b){
var dx=(b.c-cc)*(10+Math.random()*7)+(Math.random()-0.5)*40;
var dy=(b.r-cr)*(10+Math.random()*7)+170+Math.random()*130;
var rot=(Math.random()-0.5)*420;
var del=(Math.random()*0.27*brk).toFixed(2)+'s';
b.el.style.transition='transform '+brk+'s cubic-bezier(.55,0,1,.45) '+del+',opacity '+(brk*0.87).toFixed(2)+'s ease-in '+del;
b.el.style.transform='translate('+dx+'px,'+dy+'px) rotate('+rot+'deg)';
b.el.style.opacity='0';});
t.style.transition='transform '+(brk*0.8).toFixed(2)+'s cubic-bezier(.55,0,1,.45) .2s,opacity '+(brk*0.67).toFixed(2)+'s ease-in .2s';
t.style.transform='translateY(130px) rotate(5deg)';t.style.opacity='0';
setTimeout(function(){endSplash(false);},brk*1000);
},buildMs+holdMs);
}
if(!splashShown){
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',startFx);
else startFx();
}
})();
</script>
${END}`;
}

// ── Validation ────────────────────────────────────────────────────────────────

const num = (v, min, max, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

function cleanSpeeds(o) {
  const out = {};
  if (o.dur != null) out.dur = num(o.dur, 0.15, 6, undefined);
  if (o.stag != null) out.stag = num(o.stag, 0.01, 0.3, undefined);
  if (o.typeMs != null) out.typeMs = num(o.typeMs, 15, 200, undefined);
  if (o.scramMs != null) out.scramMs = num(o.scramMs, 500, 8000, undefined);
  if (o.cycle != null) out.cycle = num(o.cycle, 0.8, 10, undefined);
  if (o.mult != null) out.mult = num(o.mult, 0.3, 3, 1); // studio slider position, echoed back on restore
  return out;
}

function validateCfg(cfg) {
  if (cfg.splash?.enabled) {
    const p = cfg.splash.pattern;
    const ok = Array.isArray(p) && p.length >= 1 && p.length <= 30 &&
      p.every(row => Array.isArray(row) && row.length >= 3 && row.length <= 30 &&
        row.every(v => v === 0 || v === 1));
    if (!ok) return 'Invalid splash pattern';
    if (!p.flat().includes(1)) return 'Pattern is empty — draw something first';
    cfg.splash.color = String(cfg.splash.color || '#8b5cf6').slice(0, 20);
    cfg.splash.text = String(cfg.splash.text || '').slice(0, 60);
    cfg.splash.step = num(cfg.splash.step, 0.03, 0.3, 0.11);
    cfg.splash.hold = num(cfg.splash.hold, 300, 8000, 2000);
    cfg.splash.breakDur = num(cfg.splash.breakDur, 0.6, 4, 1.5);
  }
  if (cfg.fx) {
    if (!EFFECTS.has(cfg.fx.effect)) cfg.fx = null;
    else cfg.fx = { effect: cfg.fx.effect, scope: String(cfg.fx.scope || 'h1,h2').slice(0, 60), c1: String(cfg.fx.c1 || '#8b5cf6').slice(0, 20), c2: String(cfg.fx.c2 || '#ec4899').slice(0, 20), ...cleanSpeeds(cfg.fx) };
  }
  if (cfg.overrides) {
    if (!Array.isArray(cfg.overrides)) return 'Invalid overrides';
    cfg.overrides = cfg.overrides.slice(0, 40)
      .filter(o => o && typeof o.sel === 'string' && o.sel.length < 400 && EFFECTS.has(o.effect))
      .map(o => ({ sel: o.sel, label: String(o.label || '').slice(0, 40), effect: o.effect, ...cleanSpeeds(o) }));
  }
  return null;
}

// ── Auth helper ───────────────────────────────────────────────────────────────

function canAccess(user, slug) {
  return user.role === 'admin' || user.siteSlug === slug;
}

// GET /api/customize/:slug — saved config for this site
router.get('/:slug', requireAuth, async (req, res) => {
  try {
    if (!canAccess(req.user, req.params.slug)) return res.status(403).json({ error: 'Not your site' });
    const all = (await readData('customizations')) || {};
    res.json(all[req.params.slug] || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/customize/:slug — save + inject. ?dry=1 → just return the snippet.
router.post('/:slug', requireAuth, async (req, res) => {
  try {
    const slug = req.params.slug;
    if (!canAccess(req.user, slug)) return res.status(403).json({ error: 'Not your site' });

    const cfg = req.body || {};
    const bad = validateCfg(cfg);
    if (bad) return res.status(400).json({ error: bad });

    const dry = req.query.dry === '1' || DRY_RUN;
    if (dry) {
      return res.json({ ok: true, dryRun: true, snippet: buildSnippet(cfg) });
    }

    const sites = await readData('sites');
    const site = sites?.[slug];
    if (!site) return res.status(404).json({ error: 'Site not found' });

    delete cfg.preview; // never persist preview mode to a live site
    const snippet = buildSnippet(cfg);

    const { html, sha } = await getSiteHTML(site.githubRepo);
    if (!html) return res.status(500).json({ error: 'Could not read site HTML' });

    let patched;
    if (html.includes(START)) {
      patched = html.replace(new RegExp(`${START}[\\s\\S]*?${END}`), snippet);
    } else {
      patched = html.replace(/<\/body>/i, `${snippet}\n</body>`);
      if (patched === html) patched = html + '\n' + snippet;
    }
    await putSiteHTML(site.githubRepo, patched, sha, `Customize: update animations for ${site.business}`);

    const all = (await readData('customizations')) || {};
    all[slug] = cfg;
    await writeData('customizations', all, `Customization config for ${slug}`);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/customize/:slug — strip the snippet from the live site
router.delete('/:slug', requireAuth, async (req, res) => {
  try {
    const slug = req.params.slug;
    if (!canAccess(req.user, slug)) return res.status(403).json({ error: 'Not your site' });

    if (DRY_RUN) return res.json({ ok: true, dryRun: true });

    const sites = await readData('sites');
    const site = sites?.[slug];
    if (!site) return res.status(404).json({ error: 'Site not found' });

    const { html, sha } = await getSiteHTML(site.githubRepo);
    if (html && html.includes(START)) {
      const patched = html.replace(new RegExp(`\\n?${START}[\\s\\S]*?${END}`), '');
      await putSiteHTML(site.githubRepo, patched, sha, `Customize: remove animations for ${site.business}`);
    }

    const all = (await readData('customizations')) || {};
    delete all[slug];
    await writeData('customizations', all, `Remove customization config for ${slug}`);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.buildSnippet = buildSnippet;
