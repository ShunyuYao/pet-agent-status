'use strict';
// Real hidden host and renderer. External Codex input is a temporary IPC socket
// plus observed SQLite metadata; production collector and SDK stay unchanged.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { start } = require('./hidden-host');
const { createFrameParser, encodeFrame } = require('../../lib/codex-ipc');
const { createData, childSource, PARENT, CHILD, GUARDIAN, TURN, NEXT } = require('../fixtures/codex-subagent-data');
let host, server, data;
const sockets = new Set();
(async () => {
  try {
    host = await start(); data = createData(host.paths.codex);
    data.thread(PARENT); data.thread(CHILD, childSource(), 'subagent');
    data.thread(GUARDIAN, JSON.stringify({subagent:{other:'guardian'}}), 'guardian_review');
    data.edge();
    const socketPath = path.join(host.paths.codex, 'ipc', 'ipc.sock');
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    server = net.createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket));
      const parser = createFrameParser();
      socket.on('data', chunk => {
        for (const message of parser.push(chunk).messages) if (message.method === 'initialize') {
          socket.write(encodeFrame({ type: 'response', method: 'initialize', requestId: message.requestId }));
          for (const id of [PARENT, CHILD, GUARDIAN]) socket.write(encodeFrame({type:'broadcast',method:'thread-stream-following-changed',params:{conversationId:id,following:true}}));
        }
      });
    });
    await new Promise(resolve => server.listen(socketPath, resolve));
    const toggle = async enabled => {
      await host.evaluate(`(()=>{document.getElementById('gear').click(); const box=document.getElementById('ipc-toggle'); if (!box || box.disabled) throw Error('IPC checkbox unavailable'); box.checked=${enabled}; box.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await host.waitFor(() => enabled ? sockets.size > 0 : sockets.size === 0, 'temporary IPC toggle');
      await host.evaluate("document.getElementById('gear').click()");
    };
    const feed = (id, method, params) => {
      assert.ok(sockets.size, 'positive control: IPC is connected');
      for (const socket of sockets) socket.write(encodeFrame({type:'broadcast',method,params:{conversationId:id,...params}}));
    };
    const read = id => JSON.parse(fs.readFileSync(path.join(host.paths.state, id + '.json')));
    const rows = () => host.evaluate("[...document.querySelectorAll('.row')].map(el=>({id:el.dataset.sessionId,state:el.className,text:el.textContent}))");
    const onlyParent = async state => {
      await host.evaluate(`new Promise((resolve,reject)=>{let n=0; const timeout=setTimeout(()=>reject(Error('snapshot timeout')),12000); window.pet.events.on('agent-status:snapshot', snap=>{if(n>=3)return; if(snap.rows.length!==1 || snap.rows[0].sessionId!=='${PARENT}' || snap.rows[0].state!=='${state}' || snap.summary.total!==1 || snap.summary['${state}']!==1 || snap.summary.focus.sessionId!=='${PARENT}'){clearTimeout(timeout);n=3;reject(Error('unexpected snapshot '+JSON.stringify(snap)));return;} if(++n===3){clearTimeout(timeout);resolve(true)}})})`);
      const list = await rows(); assert.equal(list.length, 1); assert.equal(list[0].id, PARENT); assert.ok(list[0].state.includes('state-' + state));
    };
    await toggle(true);
    for (const id of [PARENT, CHILD, GUARDIAN]) { data.rollout(id, Date.now()); data.turn(id, 'inProgress', Date.now()); }
    await host.waitFor(async () => (await rows()).some(row => row.id === PARENT && row.state.includes('state-running')), 'positive control: parent panel row');
    let overlay = await host.waitFor(() => host.findTarget('pet-overlay.html'), 'pet overlay');
    const badge = () => host.evaluate("[...document.querySelectorAll('#agent-badge .agent-badge__seg')].map(el=>({className:el.className,text:el.querySelector('.agent-badge__text')?.textContent}))", overlay);
    const bubble = () => host.evaluate("document.getElementById('bubble')?.textContent || ''", overlay);
    const baselineBubble = await bubble();
    // The host creates #bubble lazily. Observe its rendered text from the existing
    // document so a transient child notification cannot disappear between polls.
    await host.evaluate("(()=>{window.subagentBubbleTexts=[]; new MutationObserver(()=>{const text=document.getElementById('bubble')?.textContent; if(text) window.subagentBubbleTexts.push(text);}).observe(document.body,{childList:true,subtree:true,characterData:true});})()", overlay);
    for (const id of [CHILD, GUARDIAN]) {
      feed(id, 'thread-queued-followups-changed', {messages:[]});
      feed(id, 'thread-read-state-changed', {hasUnreadTurn:true});
      feed(id, 'thread-read-state-changed', {hasUnreadTurn:false});
    }
    await onlyParent('running');
    for (const id of [CHILD, GUARDIAN]) assert.equal(fs.existsSync(path.join(host.paths.state, id+'.json')), false, 'child input must not write status');
    assert.equal(await bubble(), baselineBubble, 'child completion produces no bubble');
    assert.deepEqual((await host.evaluate('window.subagentBubbleTexts', overlay)).filter(text => text && text !== baselineBubble), [], 'no transient child completion bubble');
    const runningBadge = await badge(); assert.equal(runningBadge.length, 1); assert.ok(runningBadge[0].className.includes('--primary')); assert.equal(runningBadge[0].text, '1');
    assert.equal(await host.evaluate("!!document.querySelector('.app-btn.is-codex .app-run-dot')"), false);
    console.log('  ok parent running; spawned/guardian children absent from files, rows, summary, badge, App dot and bubble');

    // Historical status is legitimate system input, not an internal collector flag.
    const legacy = {schema:1,agent:'codex',form:'app',source:'ipc',sessionId:CHILD,threadId:CHILD,cwd:'',project:'Hidden child',tty:null,pid:null,state:'done',lastEvent:'ipc:turn-unread',ts:Date.now()};
    host.writeState(legacy); const legacyBytes = fs.readFileSync(path.join(host.paths.state, CHILD+'.json'), 'utf8');
    await onlyParent('running');
    const completedAt = Date.now(); data.turn(PARENT, 'completed', completedAt);
    feed(PARENT, 'thread-read-state-changed', {hasUnreadTurn:true});
    await host.waitFor(() => read(PARENT).state === 'done', 'positive control: parent completion IPC');
    await host.waitFor(async () => /Codex App/.test(await bubble()), 'positive control: parent completion bubble');
    await onlyParent('done');
    const doneBadge = await badge(); assert.equal(doneBadge.length, 1); assert.ok(doneBadge[0].className.includes('--success')); assert.equal(doneBadge[0].text, '1');
    assert.equal(await host.evaluate("!!document.querySelector('.app-btn.is-codex .app-run-dot')"), true);
    console.log('  ok historical child is excluded; parent completion reaches real bubble, badge and App dot');

    await toggle(false); await onlyParent('done');
    await host.restart(); overlay = await host.waitFor(() => host.findTarget('pet-overlay.html'), 'restarted pet overlay');
    // Harness starts with enhancement off, proving historical filtering is independent.
    await onlyParent('done'); assert.equal(sockets.size, 0);
    await toggle(true);
    const nextAt = Date.now(); data.turn(CHILD, 'inProgress', nextAt, NEXT, 2); data.rollout(CHILD, nextAt);
    feed(CHILD, 'thread-queued-followups-changed', {messages:[]});
    await onlyParent('done');
    assert.equal(fs.readFileSync(path.join(host.paths.state, CHILD+'.json'), 'utf8'), legacyBytes, 'old child record is not rewritten');
    console.log('  ok disabled enhancement, real host restart and child continuation cannot resurrect old child');
    assert.equal(host.errors.length, 0, JSON.stringify(host.errors));
    await host.screenshot(path.join(host.paths.artifacts, 'codex-subagent-panel.png'));
    console.log('codex-subagent-e2e: passed; evidence:', host.paths.artifacts);
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
    if (data) data.close();
    if (host) await host.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
