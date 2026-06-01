const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const buildOutputDir = path.join(repoRoot, 'scripts');
const hookRoot = process.env.MEMORY_HOOK_BUILD_ROOT || '/home/linkiez/.copilot/hooks';
const hookScriptsDir = path.join(hookRoot, 'scripts');
const sourceTestsDir = path.join(repoRoot, 'tests');
const hookTestsDir = path.join(hookRoot, 'tests');
const tscBin = path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
const esmPackageJson = `${JSON.stringify({ type: 'module' }, null, 2)}\n`;

function ensureExecutable(filePath) {
  if (process.platform === 'win32' || !fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  if (!content.startsWith('#!')) {
    return;
  }

  const currentMode = fs.statSync(filePath).mode & 0o777;
  fs.chmodSync(filePath, currentMode | 0o111);
}

function syncDirectory(sourceDir, targetDir) {
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true });
}

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
  const buildFilePath = path.join(buildOutputDir, fileName);
  const hookFilePath = path.join(hookScriptsDir, fileName);

  ensureExecutable(buildFilePath);
  fs.copyFileSync(buildFilePath, hookFilePath);
  ensureExecutable(hookFilePath);
}

syncDirectory(sourceTestsDir, hookTestsDir);

process.stdout.write(`Built scripts to ${buildOutputDir} and synced them to ${hookScriptsDir}; tests synced to ${hookTestsDir}\n`);