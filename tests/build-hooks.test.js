const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const repoScriptsDir = path.join(repoRoot, 'scripts');
const syncedScriptsDir = '/home/linkiez/.copilot/hooks/scripts';
const executableScripts = [
  'memory-cycle.js',
  'mcp-memory-http-cli.js'
];

for (const scriptsDir of [repoScriptsDir, syncedScriptsDir]) {
  test(`build marks hook entrypoints as executable in ${scriptsDir}`, () => {
    for (const fileName of executableScripts) {
      const filePath = path.join(scriptsDir, fileName);
      const stats = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, 'utf8');

      assert.match(content, /^#!\/usr\/bin\/env node/m, `${filePath} should start with a node shebang`);
      assert.notEqual(stats.mode & 0o111, 0, `${filePath} should be executable`);
    }
  });
}