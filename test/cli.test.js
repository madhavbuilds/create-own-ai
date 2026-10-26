const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const run = (args, cwd) => execFileSync('node', [CLI, ...args], { cwd, stdio: 'pipe', env: { ...process.env, OLLAMA_URL: 'http://127.0.0.1:9' } }).toString();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));

test('scaffolds the chat-files template', () => {
  const dir = tmp();
  const out = run(['Demo-App', '--template', 'chat-files', '--no-git'], dir);
  const app = path.join(dir, 'Demo-App');

  for (const f of ['server.js', 'lib/ollama.js', 'lib/search.js', 'lib/extract.js', 'public/index.html', 'public/favicon.svg', 'samples/apartment-lease.md', '.gitignore']) {
    assert.ok(fs.existsSync(path.join(app, f)), `${f} should exist`);
  }
  assert.ok(!fs.existsSync(path.join(app, '_gitignore')));
  assert.ok(!fs.existsSync(path.join(app, '.git')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')).name, 'demo-app');
  for (const f of ['public/index.html', 'public/app.js', 'server.js', 'README.md']) {
    assert.ok(!fs.readFileSync(path.join(app, f), 'utf8').includes('{{'), `${f} should have no placeholders left`);
  }
  assert.match(out, /cd Demo-App/);
  assert.match(out, /npm run dev/);
  assert.match(out, /Ollama isn't running/);
});

test('scaffolds into the current folder with "."', () => {
  const dir = path.join(tmp(), 'here-app');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '.DS_Store'), '');
  const out = run(['.', '--no-git'], dir);
  assert.ok(fs.existsSync(path.join(dir, 'server.js')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name, 'here-app');
  assert.doesNotMatch(out, /cd \./);
});

test('creates a git repo with a first commit', (t) => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    return t.skip('git not installed');
  }
  const dir = tmp();
  run(['git-app'], dir);
  const app = path.join(dir, 'git-app');
  if (!fs.existsSync(path.join(app, '.git'))) return t.skip('git has no user configured');
  assert.match(execFileSync('git', ['log', '--oneline'], { cwd: app }).toString(), /Initial commit/);
});

test('suggests the package manager that was used', () => {
  const dir = tmp();
  const out = execFileSync('node', [CLI, 'pnpm-app', '--no-git'], {
    cwd: dir,
    stdio: 'pipe',
    env: { ...process.env, npm_config_user_agent: 'pnpm/9.0.0 npm/? node/v20', OLLAMA_URL: 'http://127.0.0.1:9' },
  }).toString();
  assert.match(out, /pnpm dev/);
});

test('refuses to overwrite a non-empty folder', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'taken'));
  fs.writeFileSync(path.join(dir, 'taken', 'keep.txt'), 'x');
  assert.throws(() => run(['taken'], dir));
  assert.equal(fs.readFileSync(path.join(dir, 'taken', 'keep.txt'), 'utf8'), 'x');
});

test('rejects invalid app names', () => {
  const dir = tmp();
  assert.throws(() => run(['../escape'], dir));
  assert.throws(() => run(['<script>'], dir));
});

test('prints version and help', () => {
  assert.equal(run(['--version']).trim(), require('../package.json').version);
  assert.match(run(['--help']), /Usage:/);
});
