'use strict';
// Real isolated host; WorkBuddy SQLite and hook stdin drive production collection.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {DatabaseSync} = require('node:sqlite');
const {start} = require('./hidden-host');
let host,db;
(async()=>{
  try {
    host=await start();
    const id='00000000-0000-4000-8000-000000000888';
    db=new DatabaseSync(path.join(host.paths.workbuddy,'workbuddy.db'));
    db.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT,title TEXT,custom_title TEXT,status TEXT,updated_at INTEGER,last_activity_at INTEGER,deleted_at INTEGER)');
    fs.mkdirSync(path.join(host.paths.workbuddy,'sessions'),{recursive:true});
    fs.writeFileSync(path.join(host.paths.workbuddy,'sessions',process.pid+'.json'),JSON.stringify({pid:process.pid,lastHeartbeat:Date.now()}));
    const write=(state)=>db.prepare('INSERT OR REPLACE INTO sessions VALUES (?,?,?,?,?,?,?,NULL)').run(id,'/fixture','WorkBuddy fixture',null,state,Date.now(),Date.now());
    const row=()=>host.evaluate(`(()=>{const el=document.querySelector('[data-session-id="${id}"]');return el?{state:el.dataset.state,text:el.textContent}:null})()`);
    const wait=state=>host.waitFor(async()=> (await row())?.state===state,'WorkBuddy '+state);
    write('working');await wait('running');
    write('pending');await wait('waiting-input');
    assert.match((await row()).text,/等待你输入/);
    assert.doesNotMatch((await row()).text,/批准/);
    write('failed');await wait('failed');
    assert.match((await row()).text,/执行失败/);
    assert.equal(await host.evaluate("document.querySelector('.summary-part.is-done')===null"),true);
    write('working');await wait('running');
    write('terminated');await wait('stopped');
    assert.match((await row()).text,/已停止/);
    // Unconfirmed active records remain visible outside the previous 40-minute fade window.
    const stale='pet-as-test-stale-e2e';
    host.writeState({schema:3,agent:'claude-code',sessionId:stale,cwd:'/fixture',project:'Sync fixture',tty:'/dev/ttys901',pid:null,state:'running',source:'hook',lastEvent:'PreToolUse',ts:Date.now()-60*60000});
    await host.waitFor(()=>host.evaluate(`document.querySelector('[data-session-id="${stale}"]')?.dataset.state==='sync-paused'`),'sync paused row');
    assert.equal(await host.evaluate("document.querySelector('.summary-part.is-running')===null"),true);
    assert.equal(await host.evaluate("document.querySelector('.summary-part.is-syncPaused')?.textContent"),'1 同步暂停');
    const unknown=path.join(host.paths.state,'broken.json');fs.writeFileSync(unknown,'{broken');
    await host.waitFor(()=>host.evaluate("document.getElementById('hidden-note').textContent.includes('读取失败')"),'diagnostic note');
    assert.equal(await host.evaluate("document.querySelector('[data-session-id=broken]')===null"),true);
    await host.screenshot(path.join(host.paths.artifacts,'reliability-panel.png'));
    await host.evaluate("document.getElementById('gear').click()");
    assert.match(await host.evaluate("document.body.textContent"),/当前 App 接口不提供批准等待状态/);
    await host.screenshot(path.join(host.paths.artifacts,'reliability-settings.png'));
    await host.evaluate("document.getElementById('gear').click()");
    db.exec('DELETE FROM sessions');
    for(const file of fs.readdirSync(host.paths.state))if(file.endsWith('.json'))fs.unlinkSync(path.join(host.paths.state,file));
    const visual=[
      {sessionId:id,agent:'workbuddy',form:'app',tty:null,state:'waiting-input',title:'写本周项目周报'},
      {sessionId:'pet-as-test-failed',agent:'claude-code',form:'cli',tty:'/dev/ttys901',state:'failed',title:'desktop_pet · 桌宠测试版'},
      {sessionId:'pet-as-test-stopped',agent:'codex',form:'cli',tty:'/dev/ttys902',state:'stopped',title:'relay-server'},
      {sessionId:'pet-as-test-paused',agent:'claude-code',form:'cli',tty:'/dev/ttys903',state:'running',title:'desktop_pet · 桌宠测试版'}
    ];
    visual.forEach((v,i)=>host.writeState({schema:3,cwd:'/fixture',project:v.title,pid:null,lastEvent:'fixture',source:'hook',ts:Date.now()-(i===3?8*60000:i*1000),...v}));
    await host.waitFor(()=>host.evaluate("document.querySelectorAll('.row').length===4 && !!document.querySelector('.state-waiting-input')"),'four reliability design rows');
    const colors=await host.evaluate("[...document.querySelectorAll('.row')].map(row=>({state:row.dataset.state,color:getComputedStyle(row.querySelector('.subline')).color,height:row.getBoundingClientRect().height}))");
    assert.deepEqual(colors.map(x=>x.state),['waiting-input','failed','stopped','sync-paused']);
    assert.deepEqual(colors.map(x=>x.color),['rgb(242, 153, 74)','rgb(235, 87, 87)','rgb(154, 160, 172)','rgb(154, 160, 172)']);
    assert.ok(colors.every(x=>x.height===49));
    await host.screenshot(path.join(host.paths.artifacts,'reliability-design-rows.png'));
    assert.equal(host.errors.length,0,JSON.stringify(host.errors));
    console.log('reliability-e2e: passed; evidence:',host.paths.artifacts);
  } finally {if(db)db.close();if(host)await host.stop();}
})().catch(error=>{console.error(error);process.exitCode=1;});
