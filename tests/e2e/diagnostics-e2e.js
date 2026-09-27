'use strict';
// External socket faults + real metadata files -> production collector/logs/panel/badge.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { start } = require('./hidden-host');
const { createFrameParser, encodeFrame, MAX_FRAME } = require('../../lib/codex-ipc');
const { createData, CID, TURN1 } = require('../fixtures/codex-state-data');
let host, server, data;
let connections = 0;
const sockets = new Set();
(async () => {
  try {
    host = await start();
    data = createData(host.paths.codex);
    data.rollout(Date.now()); data.turn(TURN1, 'inProgress', Date.now());
    const socketPath = path.join(host.paths.codex, 'ipc', 'ipc.sock');
    fs.mkdirSync(path.dirname(socketPath), {recursive: true});
    server = net.createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket));
      const first = ++connections === 1;
      const parser = createFrameParser();
      socket.on('data', chunk => {
        for (const message of parser.push(chunk).messages) {
          if (message.method !== 'initialize' || first) continue;
          socket.write(encodeFrame({type: 'response', method: 'initialize', requestId: message.requestId}));
          socket.write(encodeFrame({type: 'broadcast', method: 'thread-stream-following-changed', params: {conversationId: CID, following: true}}));
        }
      });
    });
    await new Promise(resolve => server.listen(socketPath, resolve));
    const logFile = path.join(host.paths.state, 'diagnostics', 'agent-status.jsonl');
    const logs = () => fs.readFileSync(logFile,'utf8').trim().split('\n').map(JSON.parse);
    const toggle = () => host.evaluate("(()=>{const box=document.getElementById('ipc-toggle');if(!box||box.disabled)throw Error('toggle not interactive');box.click();return box.checked;})()");
    await host.evaluate("document.getElementById('gear').click()");
    assert.equal(await toggle(), true);
    await host.waitFor(() => logs().some(x => x.event === 'ipc.retry' && x.reason === 'handshake-timeout'), 'timeout recorded');
    await host.waitFor(() => logs().some(x => x.event === 'ipc.ready' && x.at > logs().find(y => y.event === 'ipc.retry').at), 'automatic reconnect recorded');
    assert.equal(connections, 2);
    assert.equal(logs().find(x => x.event === 'ipc.retry').retryMs, 1000);
    await host.waitFor(async () => /已连接/.test(await host.evaluate('document.body.innerText')), 'real settings connected');
    await host.evaluate("document.getElementById('gear').click()");
    const row = () => host.evaluate(`document.querySelector('.row[data-session-id="${CID}"]')?.className || ''`);
    await host.waitFor(async () => (await row()).includes('state-running'), 'running row after automatic recovery');
    const overlay = await host.waitFor(() => host.findTarget('pet-overlay.html'), 'pet overlay');
    await host.waitFor(async () => /1/.test(await host.evaluate("document.querySelector('#agent-badge .agent-badge__seg--primary .agent-badge__text')?.textContent || ''", overlay)), 'real running badge');
    console.log('  ok unanswered handshake -> logged backoff -> automatic recovery -> running panel/badge');
    const bad = Buffer.alloc(4); bad.writeUInt32LE(MAX_FRAME + 1);
    for (const socket of sockets) socket.write(bad);
    await host.waitFor(() => logs().some(x => x.event === 'ipc.disabled' && x.reason === 'frame-too-large' && x.frameBytes === MAX_FRAME + 1), 'exact permanent stop cause recorded');
    await host.evaluate("document.getElementById('gear').click()");
    await host.waitFor(async () => /已自动停用/.test(await host.evaluate('document.body.innerText')), 'real settings disabled');
    assert.equal(await toggle(), false);
    await host.waitFor(() => logs().some(x => x.event === 'ipc.stopped'), 'manual disable completed');
    assert.equal(await toggle(), true);
    await host.waitFor(() => logs().filter(x => x.event === 'ipc.ready').length === 2, 'manual reconnect logged');
    data.turn(TURN1, 'completed', Date.now()-15000, 1, Date.now());
    await host.evaluate("document.getElementById('gear').click()");
    await host.waitFor(async () => (await row()).includes('state-done'), 'real completion after recovery');
    assert(logs().some(x => x.event === 'collector.state' && x.sessionId === CID && x.state === 'done'));
    assert(logs().some(x => x.event === 'collector.health'));
    console.log('  ok protocol corruption -> exact diagnostic + settings warning -> toggle recovers completion');
    const firstInstance = logs().find(x => x.event === 'collector.started').instance;
    await host.restart();
    await host.waitFor(() => logs().some(x => x.event === 'collector.started' && x.instance !== firstInstance), 'new collector instance retained in log');
    assert(logs().some(x => x.event === 'ipc.disabled'));
    assert.equal(host.errors.length, 0, JSON.stringify(host.errors));
    fs.copyFileSync(logFile, path.join(host.paths.artifacts, 'agent-status.jsonl'));
    console.log('diagnostics-e2e: passed; evidence:', host.paths.artifacts);
  } catch (error) {
    if (host) console.error('Failure evidence:', host.paths.artifacts);
    throw error;
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
    data?.close(); if (host) await host.stop();
  }
})().catch(error => {console.error(error);process.exitCode=1;});
