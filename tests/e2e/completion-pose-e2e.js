'use strict';
// Real hook stdin -> state file -> production collector -> SDK -> real host pose
// and rendered completion text. Sleep uses the public SDK; edge positioning uses
// the host's existing release/snap probe, never direct state/edge flag writes.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { start } = require('./hidden-host');
let host;
(async () => {
  try {
    host = await start({ ...(process.env.PET_AS_TEST_HOST_DIR ? { hostDir: process.env.PET_AS_TEST_HOST_DIR } : {}) });
    const overlay = await host.waitFor(() => host.findTarget('pet-overlay.html'), 'overlay');
    const pose = () => host.evaluate('({state:pet.state,edgeSide})', host.pet);
    for (const mode of ['sleep', 'left', 'right']) {
      if (mode === 'sleep') {
        await host.evaluate('window.pet.pet.playAnim("sleep")');
        await host.waitFor(async () => (await pose()).state === 'sleep', 'sleep positive control');
      } else {
        await host.evaluate(`(()=>{const s=window.__edgeSnapTest.read();window.__edgeSnapTest.setWx(${mode === 'left' ? 's.WA.x-s.LX' : 's.WA.x+s.WA.width-s.LX-s.SIZE'});window.__edgeSnapTest.snap();})()`, host.pet);
        assert.equal((await pose()).edgeSide, mode, 'snap actually entered');
        assert.ok(['peek', 'edgehide'].includes((await pose()).state));
      }
      const id = 'completion-pose-' + mode;
      const input = { session_id: id, cwd: '/tmp/' + id };
      const rowState = () => host.evaluate(`document.querySelector('[data-session-id="${id}"]')?.dataset.state`);
      host.fireHook({ ...input, hook_event_name: 'UserPromptSubmit' });
      assert.equal(JSON.parse(fs.readFileSync(path.join(host.paths.state, id + '.json'))).state, 'running', 'hook persisted running');
      await host.waitFor(async () => await rowState() === 'running', 'running ' + mode);
      host.fireHook({ ...input, hook_event_name: 'Stop', stop_hook_active: false });
      await host.waitFor(async () => await rowState() === 'done', 'done ' + mode);
      await host.waitFor(() => host.evaluate(`document.getElementById('bubble')?.textContent.includes(${JSON.stringify(id)})`, overlay), 'completion text ' + mode);
      // Keep the pose through another real collector snapshot, not only one frame.
      for (let i = 0; i < 2; i++) {
        const state = await pose();
        assert.equal(state.edgeSide, mode === 'sleep' ? null : mode);
        assert.ok(mode === 'sleep' ? state.state === 'sleep' : ['peek', 'edgehide'].includes(state.state), mode + ' preserved: ' + JSON.stringify(state));
        if (i === 0) await host.evaluate('new Promise(resolve=>window.pet.events.on("agent-status:snapshot",()=>resolve(true)))');
      }
      await host.screenshot(path.join(host.paths.artifacts, mode + '.png'), host.pet);
      console.log('PASS completion text + done row preserve ' + mode);
    }
    console.log('Evidence:', host.paths.artifacts);
  } finally { if (host) await host.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
