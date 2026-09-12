'use strict';
// 隐藏宿主回归的终端边界夹具：真 hook/真 tool/真 panel，只隔离进程表和 AppleScript 执行。
// 不抢日常 Terminal 焦点，也不依赖 Electron 的 macOS 自动化授权。
// 用法：node tests/e2e/with-terminal-fixture.js tests/e2e/dismiss-e2e.js
// 同样支持 waiting-accuracy-e2e.js；原生终端跳转本身不属于这层测试覆盖。
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const test = process.argv[2];
if (!test || !['dismiss-e2e.js', 'waiting-accuracy-e2e.js'].includes(path.basename(test))) {
  throw new Error('Expected dismiss-e2e.js or waiting-accuracy-e2e.js');
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-as-terminal-fixture-'));
try {
  const trace = path.join(dir, 'jump.applescript');
  const tty = '/dev/ttys999';
  // 输出是明确的用户可观察导航目标，不依赖 buildScript 自己生成期望值。
  const expected = [
    'tell application "Terminal"', '  repeat with w in windows', '    repeat with tb in tabs of w',
    `      if tty of tb is "${tty}" then`, '        set selected of tb to true',
    '        set index of w to 1', '        activate', '        return', '      end if',
    '    end repeat', '  end repeat', 'end tell',
  ].join('\n');
  function executable(name, source) {
    fs.writeFileSync(path.join(dir, name), `#!${process.execPath}\n${source}`, { mode: 0o755 });
  }
  executable('ps', `
    const args = process.argv.slice(2);
    if (args[0] === '-eo' && args[1] === 'pid=,ppid=,tty=,comm=') {
      process.stdout.write('900001 1 ?? /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal\\n900002 900001 ttys999 -zsh\\n');
    } else {
      const r = require('child_process').spawnSync('/bin/ps', args, {stdio:'inherit'});
      process.exit(r.status == null ? 1 : r.status);
    }
  `);
  executable('osascript', `
    const script = process.argv[3] || '';
    if (/set selected|set index|\\bactivate\\b/.test(script)) {
      require('fs').writeFileSync(${JSON.stringify(trace)}, script);
      if (script !== ${JSON.stringify(expected)}) process.exit(1);
    }
    // 只读终端标题查询返回空：会话标题自然用夹具 project 兜底。
  `);
  const result = spawnSync(process.execPath, [test], {
    stdio: 'inherit', env: { ...process.env,
      PATH: dir + path.delimiter + process.env.PATH,
      E2E_TTY: tty, PET_AS_TTY: tty, PET_AS_PS_OUTPUT: '1 0 ?? init',
      CODEX_HOME: path.join(dir, 'codex'), PET_AS_CLAUDE_SETTINGS: path.join(dir, 'claude-settings.json'),
      PET_AS_CODEX_HOOKS: path.join(dir, 'codex-hooks.json'),
      PET_AS_CLAUDE_APP_SUPPORT: path.join(dir, 'claude-app'), PET_AS_WORKBUDDY_HOME: path.join(dir, 'workbuddy'),
    },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, '隔离宿主用例必须通过');
  if (path.basename(test) === 'dismiss-e2e.js') {
    assert.equal(fs.readFileSync(trace, 'utf8'), expected, '真实 tool 输出必须定位夹具 tty 并选择对应标签');
    console.log('PASS：跳转输出精确指向 /dev/ttys999（原生 Terminal 执行已隔离）');
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
