'use strict';
// Real hidden host, production collector + IPC parser + renderer + scheduler.
// External App equivalents: a temporary Unix socket and metadata-only SQLite/files.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { start } = require('./hidden-host');
const { createFrameParser, encodeFrame } = require('../../lib/codex-ipc');
const { createData, CID, TURN1, TURN2 } = require('../fixtures/codex-state-data');
let host, server, data;
const sockets = new Set();
(async () => {
  try {
    host = await start();
    data = createData(host.paths.codex);
    const socketPath = path.join(host.paths.codex, 'ipc', 'ipc.sock');
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    server = net.createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket));
      const parser = createFrameParser();
      socket.on('data', chunk => {
        for (const message of parser.push(chunk).messages) if (message.method === 'initialize') {
          socket.write(encodeFrame({ type: 'response', method: 'initialize', requestId: message.requestId }));
          socket.write(encodeFrame({ type: 'broadcast', method: 'thread-stream-following-changed', params: { conversationId: CID, following: true } }));
        }
      });
    });
    await new Promise(resolve => server.listen(socketPath, resolve));
    const enable = async () => {
      await host.evaluate("document.getElementById('gear').click(); const box=document.getElementById('ipc-toggle'); if (!box || box.disabled) throw Error('IPC checkbox unavailable'); box.checked=true; box.dispatchEvent(new Event('change',{bubbles:true}));");
      await host.waitFor(() => sockets.size, 'temporary IPC connected');
      await host.evaluate("document.getElementById('gear').click()");
    };
    const feed = (method, params) => {
      for (const socket of sockets) socket.write(encodeFrame({ type: 'broadcast', method, params: { conversationId: CID, ...params } }));
    };
    const stateFile = path.join(host.paths.state, CID + '.json');
    const read = () => JSON.parse(fs.readFileSync(stateFile));
    const row = () => host.evaluate(`(()=>{ const el=document.querySelector('.row[data-session-id="${CID}"]'); return el ? {className:el.className,text:el.textContent}:null; })()`);
    const waitState = state => host.waitFor(async () => (await row())?.className.includes('state-' + state), 'panel state ' + state);
    const assertStateAcrossPolls = async state => {
      // Observe multiple real snapshots, not a single transient frame.
      await host.evaluate(`new Promise((resolve,reject)=>{let n=0; const timeout=setTimeout(()=>reject(Error('snapshot timeout')),12000); window.pet.events.on('agent-status:snapshot', snap=>{if(n>=3)return; const row=snap.rows.find(r=>r.sessionId==='${CID}'); if(!row||row.state!=='${state}') {clearTimeout(timeout); n=3; reject(Error('unexpected state '+row?.state)); return;} if(++n===3){clearTimeout(timeout);resolve(true)}})})`);
      assert.ok((await row()).className.includes('state-' + state));
    };
    await enable();
    const t0 = Date.now(); data.rollout(t0, 4); data.turn(TURN1, 'inProgress', t0);
    await waitState('running');
    const overlay = await host.waitFor(() => host.findTarget('pet-overlay.html'), 'pet overlay');
    const badge = () => host.evaluate("[...document.querySelectorAll('#agent-badge .agent-badge__seg')].map(el=>({className:el.className,text:el.querySelector('.agent-badge__text')?.textContent}))", overlay);
    await host.waitFor(async () => (await badge()).some(s => s.className.includes('agent-badge__seg--primary') && s.text === '1'), 'running badge shows task');
    console.log('  ok old task file -> real running panel and badge');
    const doneAt = Date.now();
    feed('thread-read-state-changed', { hasUnreadTurn: true });
    await host.waitFor(() => read().state === 'done', 'completion IPC written');
    // Keep the DB inProgress for one poll: delayed metadata must not defeat IPC completion.
    await waitState('done');
    assert.equal(read().turnId, TURN1);
    await host.waitFor(async () => /Codex App/.test(await host.evaluate("document.getElementById('bubble')?.textContent || ''", overlay)), 'completion bubble rendered');
    await host.waitFor(async () => (await badge()).some(s => s.className.includes('agent-badge__seg--success') && s.text === '1'), 'completion badge retains task');
    data.turn(TURN1, 'completed', t0, 1, doneAt); data.append(Date.now());
    await assertStateAcrossPolls('done');
    console.log('  ok done survives stale metadata, final flush and three scheduled polls; pet bubble rendered');
    feed('thread-read-state-changed', { hasUnreadTurn: false });
    await host.waitFor(() => read().state === 'ended', 'reading result recorded');
    await assertStateAcrossPolls('done');
    await host.restart(); await enable(); await waitState('done');
    data.append(Date.now()); await assertStateAcrossPolls('done');
    console.log('  ok read result and host restart preserve completion barrier');
    const nextAt = Date.now(); data.turn(TURN2, 'inProgress', nextAt, 50); data.append(nextAt);
    // Submission may first publish "read" before the next polling cycle.
    feed('thread-read-state-changed', { hasUnreadTurn: false });
    await waitState('running'); assert.equal(read().turnId, TURN2);
    feed('thread-read-state-changed', { hasUnreadTurn: false }); await assertStateAcrossPolls('running');
    console.log('  ok next turn in old task resumes without being ended by read-state');
    assert.equal(host.errors.length, 0, JSON.stringify(host.errors));
    await host.screenshot(path.join(host.paths.artifacts, 'codex-state-panel.png'));
    console.log('codex-state-e2e: passed; evidence:', host.paths.artifacts);
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
    if (data) data.close();
    if (host) await host.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
