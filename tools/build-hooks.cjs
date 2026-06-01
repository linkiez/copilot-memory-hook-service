const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const buildOutputDir = path.join(repoRoot, 'scripts');
const hookRoot = process.env.MEMORY_HOOK_BUILD_ROOT || '/home/linkiez/.copilot/hooks';
const hookScriptsDir = path.join(hookRoot, 'scripts');
const tscBin = path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
const esmPackageJson = `${JSON.stringify({ type: 'module' }, null, 2)}\n`;

fs.rmSync(buildOutputDir, { recursive: true, force: true });

const compile = spawnSync(tscBin, ['-p', path.join(repoRoot, 'tsconfig.json')], {
  cwd: repoRoot,
  stdio: 'inherit'
});

if (compile.status !== 0) {
  process.exit(compile.status || 1);
}

fs.mkdirSync(hookScriptsDir, { recursive: true });
fs.writeFileSync(path.join(buildOutputDir, 'package.json'), esmPackageJson, 'utf8');
fs.writeFileSync(path.join(hookScriptsDir, 'package.json'), esmPackageJson, 'utf8');
for (const fileName of fs.readdirSync(buildOutputDir)) {
  fs.copyFileSync(path.join(buildOutputDir, fileName), path.join(hookScriptsDir, fileName));
}

process.stdout.write(`Built scripts to ${buildOutputDir} and synced them to ${hookScriptsDir}\n`);