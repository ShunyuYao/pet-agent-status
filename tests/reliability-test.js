'use strict';
// User/system equivalents only: real hook stdin, persisted records, scheduler and
// click intents. All sources/configuration/storage are under a temporary root.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync, spawn} = require('child_process');
const sf = require('../lib/state-files');
const {createCollector, SNAPSHOT_EVENT, JUMP_EVENT} = require('../tool');
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-as-reliability-'));
  const dir = path.join(root,'state'); fs.mkdirSync(dir);
  const storage = new Map([['codexIpcEnabled',false]]), handlers = new Map(), bubbles = [];
  let clock = Date.now(), snapshot, poll, collector, failHistory = false;
  const pet = {
    storage:{async get(key){return storage.get(key);},async set(key,value){if(key==='statusTransitions' && failHistory)throw new Error('fixture storage unavailable');storage.set(key,value);}},
    events:{on(key,fn){handlers.set(key,fn);},emit(key,value){if(key===SNAPSHOT_EVENT)snapshot=value;}},
    scheduler:{async every(_ms,fn){poll=fn;return 'timer';},async cancel(){}},
    pet:{bubble(text){bubbles.push(text);},playAnim(){}}
  };
  async function boot() {
    collector=createCollector({dir,now:()=>clock,locale:'zh-CN',codexHome:path.join(root,'codex'),
      settingsFile:path.join(root,'claude.json'),codexHooksFile:path.join(root,'hooks.json'),psTree:[],
      threadState:{read:()=>new Map()},threadTitles:{lookup:()=>null},terminalTitles:{lookup:()=>null},
      claudeDesktop:{has:()=>false,lookupTitle:()=>null},workbuddySource:{tick(){}},
      createAppLauncher:()=>({detect:()=>[],open(){}})});
    await collector.start(pet);
  }
  function hook(name, extra={}) {
    const result=spawnSync(process.execPath,[path.join(__dirname,'../hooks/claude-status-hook.js')],{
      input:JSON.stringify({session_id:'pet-as-test-reliable',cwd:root,hook_event_name:name,...extra}),encoding:'utf8',
      env:{...process.env,PET_AGENT_STATUS_DIR:dir,PET_AS_TTY:'/dev/ttys901',PET_AS_PS_OUTPUT:''}});
    assert.equal(result.status,0); assert.equal(result.stdout,''); clock=Math.max(clock,Date.now());
  }
  const read=()=>sf.readStatus('pet-as-test-reliable',dir);
  try {
    const writer=path.join(__dirname,'../lib/state-files.js');
    await Promise.all(Array.from({length:8},(_,i)=>new Promise((resolve,reject)=>{
      const payload={agent:'claude-code',sessionId:'concurrent',cwd:root,tty:'/dev/ttys999',state:'running',lastEvent:'PreToolUse',ts:1000+i};
      const child=spawn(process.execPath,['-e','require(process.argv[1]).writeStatus(JSON.parse(process.argv[2]),process.argv[3])',writer,JSON.stringify(payload),dir],{stdio:'ignore'});
      child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('writer failed '+code)));
    })));
    assert.equal(sf.readStatus('concurrent',dir).ts,1007,'late older writes cannot roll back the snapshot');
    assert.deepEqual(fs.readdirSync(dir),['concurrent.json'],'all writer locks and temporary files released');
    fs.unlinkSync(sf.fileFor('concurrent',dir));
    await boot();
    const emptyCodex='pet-as-test-empty-codex';
    for(const hook_event_name of ['SessionStart','SessionEnd']) {
      const result=spawnSync(process.execPath,[path.join(__dirname,'../hooks/codex-status-hook.js')],{
        input:JSON.stringify({session_id:emptyCodex,cwd:root,hook_event_name}),encoding:'utf8',
        env:{...process.env,PET_AGENT_STATUS_DIR:dir,PET_AS_TTY:'/dev/ttys902',PET_AS_PS_OUTPUT:''}});
      assert.equal(result.status,0);
    }
    assert.equal(sf.readStatus(emptyCodex,dir),null,'empty Codex session must not report a finished task');
    hook('SessionStart');poll();assert.equal(snapshot.summary.running,0);assert.equal(snapshot.rows.length,0);
    hook('UserPromptSubmit',{prompt:'fixture'});poll();assert.equal(snapshot.summary.running,1);
    const first=read().runId;
    hook('Notification',{matcher:'permission_prompt'});poll();assert.equal(snapshot.summary.waiting,1);
    assert.equal(bubbles.length,1);
    await collector.stop(pet);await boot();assert.equal(bubbles.length,1,'restart must not duplicate approval reminder');
    hook('PreToolUse');poll();assert.equal(read().runId,first);assert.equal(snapshot.summary.running,1);
    hook('Stop');poll();assert.equal(snapshot.summary.done,1);assert.equal(bubbles.length,2);
    const result=read();hook('SessionEnd');assert.deepEqual(read(),result,'closing session preserves successful outcome');
    hook('Notification',{matcher:'idle_prompt'});assert.deepEqual(read(),result,'idle reminder cannot revive completion');
    handlers.get(JUMP_EVENT)({sessionId:result.sessionId});assert.equal(snapshot.rows.length,0);
    // Duplicate evidence for the same round must not undo dismissal.
    sf.writeStatus({...result,ts:result.ts+1},dir);clock+=2;poll();assert.equal(snapshot.rows.length,0);
    hook('UserPromptSubmit');poll();assert.equal(snapshot.summary.running,1);assert.notEqual(read().runId,first);
    hook('Stop');poll();assert.equal(bubbles.length,3,'a second round within five minutes gets its own reminder');
    assert.equal(snapshot.summary.done,1);
    hook('UserPromptSubmit');poll();const running=read();
    fs.writeFileSync(sf.fileFor(running.sessionId,dir),'{truncated');poll();
    assert.equal(snapshot.rows[0].state,'sync-paused');assert.equal(snapshot.rows[0].raw,'running');
    assert.equal(snapshot.summary.running,0);assert.equal(snapshot.summary.diagnostics,1);
    fs.writeFileSync(sf.fileFor(running.sessionId,dir),JSON.stringify(running));poll();assert.equal(snapshot.summary.running,1);
    clock+=31*60000;poll();assert.equal(snapshot.rows[0].state,'sync-paused');assert.equal(snapshot.summary.done,0);
    assert.equal(bubbles.length,3,'missing liveness never announces success');
    await collector.stop(pet);
    const history=storage.get('statusTransitions');
    assert.ok(history.some(x=>x.state==='waiting' && x.event==='Notification'));
    assert.ok(history.some(x=>x.state==='done'));
    assert.ok(history.some(x=>x.reason==='source-unavailable'));
    assert.ok(history.some(x=>x.reason==='liveness-unconfirmed'));
    assert.ok(history.every(x=>!('title' in x) && !('cwd' in x) && !('prompt' in x)));
    await boot();await collector.stop(pet);
    assert.equal(storage.get('statusTransitions').length,history.length,'restart does not duplicate an unchanged state');
    await boot();
    failHistory=true;
    fs.writeFileSync(sf.fileFor(running.sessionId,dir),JSON.stringify({...running,state:'failed',ts:clock}));poll();
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(storage.get('statusTransitions').length,history.length,'failed storage write is not treated as saved');
    failHistory=false;poll();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(storage.get('statusTransitions').at(-1).state,'failed','next tick retries metadata persistence');
    for(let i=0;i<110;i++) {
      clock++;
      fs.writeFileSync(sf.fileFor(running.sessionId,dir),JSON.stringify({...running,state:i%2?'failed':'stopped',ts:clock}));
      poll();await new Promise(resolve=>setImmediate(resolve));
    }
    assert.equal(storage.get('statusTransitions').length,100,'diagnostic history has a hard bound');
    await collector.stop(pet);
    // Schema 1/2 ended contains no successful-outcome proof.
    for(const schema of [1,2]) {
      const record={...running,schema,state:'ended',ts:clock};fs.writeFileSync(sf.fileFor(record.sessionId,dir),JSON.stringify(record));
      await boot();assert.equal(snapshot.rows[0].state,'stopped');assert.equal(snapshot.summary.done,0);await collector.stop(pet);
    }
    console.log('reliability-test: hooks, round identity, restart reminders, dismissals, corruption recovery, long silence and legacy outcomes passed');
  } finally {if(collector)await collector.stop(pet);fs.rmSync(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
