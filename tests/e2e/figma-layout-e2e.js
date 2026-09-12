'use strict';
// Figma 2026-09-12, file UJimpWGl2hGkrbzxIVCAK5: C1 40:41, C2 40:81,
// launcher 40:23 and FormBadge 77:10. Values below come from the online nodes,
// not DESIGN.md or current CSS. Run once before the fix to retain the red baseline.
// Real host, collector, file protocol, IPC and panel; only external apps/terminals
// are fixtures (hidden-host.js). No pixel clicks or live account/session data.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { start } = require('./hidden-host');

const OUT = process.env.E2E_ARTIFACT_DIR || path.join(require('node:os').tmpdir(), 'pet-as-figma-layout');
const checks = [];
function check(label, actual, expected, tolerance = 0) {
  const pass = typeof expected === 'number'
    ? Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance
    : actual === expected;
  checks.push({ label, actual, expected, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}${pass ? '' : `: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`}`);
}
const measure = `(() => {
  const box = e => {
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x:r.x, y:r.y, w:r.width, h:r.height, right:r.right, bottom:r.bottom };
  };
  const style = e => e ? getComputedStyle(e) : {};
  return {
    viewport: { w:innerWidth, h:innerHeight },
    title: box(document.querySelector('.title')),
    list: box(document.querySelector('.list')),
    rows: [...document.querySelectorAll('.row')].map(e => {
      const b=e.querySelector('.badge'), f=e.querySelector('.form-badge');
      const glyph=b.querySelector('svg'), img=b.querySelector('img');
      return { id:e.dataset.sessionId, row:box(e), badge:box(b), form:box(f),
        ring:style(f).borderTopWidth, ringColor:style(f).borderTopColor,
        glyph:box(glyph), img:box(img), imageClip:img ? box(img.parentElement) : null,
        frame:box(f.querySelector('.win-frame')), bar:box(f.querySelector('.win-bar')),
        project:box(e.querySelector('.project')), subline:box(e.querySelector('.subline')),
        projectSize:style(e.querySelector('.project')).fontSize,
        sublineSize:style(e.querySelector('.subline')).fontSize,
        dot:box(e.querySelector('.dot')), time:box(e.querySelector('.time')),
        src:img?.src, path:glyph?.querySelector('path')?.getAttribute('d') };
    }),
    launcher:box(document.querySelector('.applauncher-row')),
    divider:box(document.querySelector('.applauncher-divider')),
    buttons:[...document.querySelectorAll('.app-btn')].map(e=>({
      id:e.dataset.appId, box:box(e), img:box(e.querySelector('img')),
      clip:box(e.querySelector('img').parentElement), src:e.querySelector('img').src,
      loaded:e.querySelector('img').complete && e.querySelector('img').naturalWidth > 0,
      bg:style(e).backgroundColor, dot:box(e.querySelector('.app-run-dot'))
    })),
    headerButtons:[...document.querySelectorAll('.icon-btn')].map(e=>({box:box(e),icon:box(e.querySelector('svg'))})),
    empty:box(document.querySelector('.empty-icon')),
    emptyRadius:style(document.querySelector('.empty-icon')).borderRadius,
    emptyTitle:box(document.querySelector('.empty-title')),
    emptyDesc:box(document.querySelector('.empty-desc')),
    emptyText:document.querySelector('.empty-desc').textContent,
    emptyScroll: (()=>{const e=document.getElementById('empty');return {client:e.clientHeight,scroll:e.scrollHeight,overflow:style(e).overflowY};})()
  };
})()`;

async function run() {
  fs.mkdirSync(OUT, { recursive:true });
  let host;
  try {
    host = await start({ artifactDir:OUT });
    const now=Date.now();
    const records=[
      { sessionId:'figma-waiting', agent:'claude-code', tty:'/dev/ttys901', state:'waiting', title:'pet-account 服务端', ts:now-32000 },
      { sessionId:'figma-running', agent:'claude-code', tty:'/dev/ttys902', state:'running', title:'desktop_pet · 桌宠测试版', ts:now-12000 },
      { sessionId:'11111111-1111-4111-8111-111111111111', agent:'workbuddy', tty:null, form:'app', state:'running', title:'写本周项目周报', ts:now-14000 },
      { sessionId:'figma-done', agent:'codex', tty:'/dev/ttys903', state:'done', title:'relay-server', ts:now-120000 },
      { sessionId:'22222222-2222-4222-8222-222222222222', threadId:'22222222-2222-4222-8222-222222222222', agent:'codex', form:'app', tty:null, state:'done', title:'更新 Codex 宠物形象', ts:now-130000 }
    ];
    for (const r of records) host.writeState({ schema:1, cwd:'/tmp/figma-fixture', project:'figma-fixture', pid:process.pid, lastEvent:'fixture', ...r });
    await host.waitFor(async()=>await host.evaluate('document.querySelectorAll(".row").length')===5, 'five fixture rows');
    await host.screenshot(path.join(OUT,'sessions.png'));
    const m=await host.evaluate(measure);
    fs.writeFileSync(path.join(OUT,'sessions-metrics.json'),JSON.stringify(m,null,2));
    check('panel width',m.viewport.w,320);check('panel height',m.viewport.h,420);
    const documentRoot = await host.cdp('DOM.getDocument');
    const timeNode = await host.cdp('DOM.querySelector', {nodeId:documentRoot.root.nodeId, selector:'.time'});
    await host.cdp('CSS.enable');
    const fonts = await host.cdp('CSS.getPlatformFontsForNode', {nodeId:timeNode.nodeId});
    check('time actually uses bundled Inter',fonts.fonts.some(f=>f.familyName==='Inter' && f.isCustomFont && f.glyphCount>0),true);
    fs.writeFileSync(path.join(OUT,'fonts.json'),JSON.stringify(fonts,null,2));
    check('first row y',m.rows[0].row.y,45,0.02);
    for(let i=0;i<m.rows.length;i++) {
      const r=m.rows[i],label=r.id;
      check(label+' row x',r.row.x,14,0.02);check(label+' row width',r.row.w,292,0.02);
      check(label+' row height',r.row.h,49,0.02);
      if(i)check(label+' row gap',r.row.y-m.rows[i-1].row.bottom,8,0.02);
      check(label+' badge width',r.badge.w,28,0.02);check(label+' badge height',r.badge.h,28,0.02);
      check(label+' badge x within row',r.badge.x-r.row.x,10,0.02);
      check(label+' badge y within row',r.badge.y-r.row.y,10.5,0.02);
      check(label+' form x',r.form.x-r.badge.x,18,0.02);check(label+' form y',r.form.y-r.badge.y,18,0.02);
      check(label+' form width',r.form.w,13,0.02);check(label+' form height',r.form.h,13,0.02);
      check(label+' form stroke',r.ring,'1px');check(label+' form stroke color',r.ringColor,'rgb(58, 63, 76)');
      if(r.glyph){check(label+' logo width',r.glyph.w,20,0.02);check(label+' logo inset',r.glyph.x-r.badge.x,4,0.02);}
      if(r.img){
        check(label+' image crop width',r.imageClip.w,28,0.02);
        check(label+' cropped image leaf',r.img.w,35,0.02);
        check(label+' image crop offset',r.img.x-r.imageClip.x,-3.5,0.02);
      }
      if(r.frame){check(label+' window glyph width',r.frame.w,6.4,0.02);check(label+' window glyph height',r.frame.h,5,0.02);check(label+' window title bar',r.bar.h,1.1,0.02);}
      check(label+' title x',r.project.x-r.row.x,46,0.02);check(label+' title y',r.project.y-r.row.y,9,0.02);
      check(label+' subtitle y',r.subline.y-r.row.y,27,0.02);
      check(label+' title font',r.projectSize,'12.5px');check(label+' subtitle font',r.sublineSize,'10.5px');
      check(label+' status dot x',r.dot.x-r.row.x,236,0.02);check(label+' status dot y',r.dot.y-r.row.y,20.5,0.02);
    }
    check('footer divider y',m.divider.y,358,0.02);
    check('launcher y',m.launcher.y,366,0.02);check('launcher height',m.launcher.h,40,0.02);
    check('launcher order',m.buttons.map(b=>b.id).join(','),'claude,codex,workbuddy');
    for(let i=0;i<m.buttons.length;i++){
      const b=m.buttons[i],name='launcher '+b.id;
      check(name+' button width',b.box.w,40,0.02);check(name+' button height',b.box.h,40,0.02);
      check(name+' x',b.box.x,86+i*54,0.02);check(name+' button y',b.box.y,366,0.02);
      check(name+' clip width',b.clip.w,32,0.02);check(name+' clip height',b.clip.h,32,0.02);
      check(name+' clip inset',b.clip.x-b.box.x,4,0.02);check(name+' clip y',b.clip.y,370,0.02);
      check(name+' image leaf width',b.img.w,40,0.02);check(name+' crop offset',b.img.x-b.clip.x,-4,0.02);
      check(name+' no resting gray plate',b.bg,'rgba(0, 0, 0, 0)');check(name+' decoded',b.loaded,true);
      const data=Buffer.from(b.src.split(',')[1],'base64');
      const expected=fs.readFileSync(path.join(__dirname,'../../assets',`app-${b.id}.png`));
      check(name+' exact packaged asset',crypto.createHash('sha256').update(data).digest('hex'),crypto.createHash('sha256').update(expected).digest('hex'));
      check(name+' completion dot',!!b.dot,b.id==='codex');
      if(b.dot){check(name+' dot x',b.dot.x-b.box.x,32,0.02);check(name+' dot y',b.dot.y-b.box.y,0,0.02);check(name+' dot size',b.dot.w,8,0.02);}
    }
    for(const b of m.headerButtons){check('header hit width',b.box.w,22);check('header icon width',b.icon.w,13);}

    // Real detection fixture transitions, rather than assigning panel DOM/state.
    for(const ids of [['claude','workbuddy'],['codex'],[]]){
      host.setApps(ids);
      await host.waitFor(async()=>await host.evaluate('document.querySelectorAll(".app-btn").length')===ids.length,'installed apps count');
      const a=await host.evaluate(measure);
      if(ids.length)check(`${ids.length} app centered`,(a.buttons[0].box.x+a.buttons.at(-1).box.right)/2,160,0.02);
      else check('no apps footer hidden',await host.evaluate('document.getElementById("applauncher").hidden'),true);
      await host.screenshot(path.join(OUT,`apps-${ids.length}.png`));
    }
    for(const r of records)fs.unlinkSync(path.join(host.paths.stateDir,r.sessionId+'.json'));
    host.setApps(['claude','codex','workbuddy']);
    await host.waitFor(async()=>await host.evaluate('!document.getElementById("empty").hidden && document.querySelectorAll(".app-btn").length===3'),'empty state');
    await host.screenshot(path.join(OUT,'empty.png'));
    const empty=await host.evaluate(measure);
    check('empty icon x',empty.empty.x,132,0.02);check('empty icon y',empty.empty.y,96,0.02);
    check('empty icon radius',empty.emptyRadius,'16px');check('empty title y',empty.emptyTitle.y,168,0.02);
    check('empty footer divider y',empty.divider.y,358,0.02);
    check('empty description y',empty.emptyDesc.y,194,0.02);
    check('empty description width',empty.emptyDesc.w,220,0.02);
    check('empty description two lines',empty.emptyDesc.h,28,0.02);
    check('empty description matches current Figma',empty.emptyText,'在终端里启动 Claude Code 或 Codex，这里会实时显示它们的进度');
    // Existing setup controls remain real and the footer stays anchored after setup.
    await host.evaluate('document.getElementById("install-claude").click()');
    await host.waitFor(async()=>await host.evaluate('!document.getElementById("installed").hidden'),'Claude setup completed');
    check('setup writes only fixture config',!!JSON.parse(fs.readFileSync(host.paths.claudeSettings,'utf8')).hooks,true);
    check('installed state footer remains anchored',(await host.evaluate(measure)).divider.y,358,0.02);
    await host.screenshot(path.join(OUT,'empty-installed.png'));
    host.setApps([]);
    await host.waitFor(async()=>await host.evaluate('document.getElementById("applauncher").hidden'),'no apps empty state');
    const noApps=await host.evaluate(measure);
    check('empty icon without footer y',noApps.empty.y,120,0.02);
    await host.screenshot(path.join(OUT,'empty-no-apps.png'));
    // Settings remain reachable and the list/footer return after a fresh instance.
    await host.evaluate('document.getElementById("gear").click()');
    check('settings opens',await host.evaluate('!document.getElementById("settings").hidden'),true);
    await host.screenshot(path.join(OUT,'settings.png'));
    await host.restart();
    check('fresh instance stays empty',await host.evaluate('document.querySelectorAll(".row").length'),0);
    check('fresh instance real bridge',await host.evaluate('typeof window.pet.ui.copyText'), 'function');
    await host.waitFor(async()=>await host.evaluate('!document.getElementById("installed").hidden'),'setup persists after restart');
    check('setup survives fresh instance',await host.evaluate('!document.getElementById("installed").hidden'),true);
    check('renderer errors',host.errors.length,0);
  } finally {
    if(host)await host.stop();
    fs.writeFileSync(path.join(OUT,'checks.json'),JSON.stringify(checks,null,2));
  }
  const failed=checks.filter(c=>!c.pass);
  console.log(`figma-layout-e2e: ${checks.length-failed.length} passed / ${failed.length} failed; evidence ${OUT}`);
  if(failed.length)process.exitCode=1;
}
run().catch(e=>{console.error(e.stack);process.exitCode=1;});
