// Scaffolds a real app, starts its server against a fake Ollama, and talks to it over HTTP.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { execFileSync, spawn } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
let fakeOllama;
let app;
let base;
let lastChat;

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

before(async () => {
  fakeOllama = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/api/version') return res.end('{"version":"0.0.0"}');
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'tiny:1b', size: 1, details: { parameter_size: '1B' } }] }));
      if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['completion'] }));
      if (req.url === '/api/generate') return res.end(JSON.stringify({ response: '"Rent Due Date"\n' }));
      if (req.url === '/api/chat') {
        lastChat = JSON.parse(body);
        res.write(JSON.stringify({ message: { content: 'Rent is due on the 1st ' } }) + '\n');
        res.write(JSON.stringify({ message: { content: '[1].' } }) + '\n');
        return res.end(JSON.stringify({ done: true, eval_count: 20, eval_duration: 5e8 }) + '\n');
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise((r) => fakeOllama.listen(0, '127.0.0.1', r));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-srv-'));
  execFileSync('node', [CLI, 'srv-app', '--no-git'], { cwd: dir, stdio: 'pipe' });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  app = spawn('node', ['server.js'], {
    cwd: path.join(dir, 'srv-app'),
    env: { ...process.env, PORT: String(port), MODEL: 'tiny:1b', NO_OPEN: '1', OLLAMA_URL: `http://127.0.0.1:${fakeOllama.address().port}` },
    stdio: 'pipe',
  });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${base}/api/status`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('server did not start');
});

after(() => {
  app?.kill();
  fakeOllama?.close();
});

// Raw request (fetch would normalize the path and won't let us fake the Host header).
// The body is drained so the socket closes cleanly on every OS.
const rawGet = (p, headers = {}) => new Promise((resolve, reject) => {
  http.get(base + p, { headers }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); }).on('error', reject);
});

const post = (p, body, headers = {}) =>
  fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('reports status and installed models', async () => {
  const s = await (await fetch(`${base}/api/status`)).json();
  assert.equal(s.ollama, true);
  assert.equal(s.model, 'tiny:1b');
  assert.equal(s.modelReady, true);
  const models = await (await fetch(`${base}/api/models`)).json();
  assert.deepEqual(models.map((m) => m.name), ['tiny:1b']);
});

test('serves the UI with the app name filled in', async () => {
  const html = await (await fetch(base)).text();
  assert.match(html, /<title>srv-app<\/title>/);
  assert.equal(await rawGet('/%2e%2e/package.json'), 404);
});

test('adds text and PDF files, then answers with sources', async () => {
  assert.equal((await post('/api/files', { name: 'lease.md', text: 'Rent is due on the 1st of every month.' })).status, 200);
  const pdf = fs.readFileSync(path.join(__dirname, 'fixtures', 'report.pdf')).toString('base64');
  const added = await (await post('/api/files', { name: 'report.pdf', data: pdf })).json();
  assert.equal(added.name, 'report.pdf');

  const res = await post('/api/chat', { messages: [{ role: 'user', content: 'When is rent due?' }] });
  const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events[0].type, 'sources');
  assert.equal(events[0].sources[0].doc, 'lease.md');
  assert.equal(events.filter((e) => e.type === 'token').map((e) => e.token).join(''), 'Rent is due on the 1st [1].');
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.tokensPerSec, 40);
  assert.match(lastChat.messages[0].content, /\[1\] \(from lease\.md\)/);
});

const chatEvents = async (body) => (await (await post('/api/chat', body)).text()).trim().split('\n').map((l) => JSON.parse(l));

test('saves chats, names them, and keeps follow-ups in context', async () => {
  const first = await chatEvents({ message: 'When is rent due?' });
  assert.deepEqual(first.map((e) => e.type), ['chat', 'sources', 'token', 'token', 'done', 'title']);
  const { id } = first[0];
  assert.equal(first.at(-1).title, 'Rent Due Date');
  assert.equal(lastChat.options.num_ctx, 8192);

  await chatEvents({ chatId: id, message: 'What if I pay late?' });
  // Earlier turns go to the model without their [n] markers, which pointed at other sources.
  assert.deepEqual(lastChat.messages.slice(1).map((m) => [m.role, m.content]), [
    ['user', 'When is rent due?'],
    ['assistant', 'Rent is due on the 1st.'],
    ['user', 'What if I pay late?'],
  ]);

  const list = await (await fetch(`${base}/api/chats`)).json();
  assert.equal(list[0].id, id);
  assert.equal(list[0].count, 4);
  const saved = await (await fetch(`${base}/api/chats/${id}`)).json();
  assert.equal(saved.messages[1].sources[0].doc, 'lease.md');
  assert.equal(saved.messages[1].stats.model, 'tiny:1b');

  // Regenerate the last answer: cut back to the question and ask it again.
  await chatEvents({ chatId: id, message: 'What if I pay late?', truncate: 2 });
  assert.equal((await (await fetch(`${base}/api/chats/${id}`)).json()).messages.length, 4);

  const renamed = await fetch(`${base}/api/chats/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"title":"Lease questions"}' });
  assert.equal((await renamed.json()).title, 'Lease questions');
  assert.equal((await fetch(`${base}/api/chats/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${base}/api/chats/${id}`)).status, 404);
  assert.equal((await fetch(`${base}/api/chats/..%2f..%2fpackage`)).status, 404);
});

test('only shows the model the files a question is about', async () => {
  await post('/api/files', { name: 'car-insurance.md', text: 'The insurance premium is 62 euros per month, due on the 15th. Cancel with 30 days notice.' });
  await post('/api/files', { name: 'job.md', text: 'The employment contract can be ended with 3 months notice.' });
  // Named file: only that file.
  await chatEvents({ message: 'How much notice does the car insurance need?' });
  assert.match(lastChat.messages[0].content, /from car-insurance\.md/);
  assert.doesNotMatch(lastChat.messages[0].content, /from (job|lease)\.md/);
  // A weak match in another file is left out.
  await chatEvents({ message: 'When is the rent due each month?' });
  assert.doesNotMatch(lastChat.messages[0].content, /from car-insurance\.md/);
  // Follow-up with no keywords of its own leans on the previous question.
  const { id } = (await chatEvents({ message: 'What does the employment contract say about notice?' }))[0];
  await chatEvents({ chatId: id, message: 'Tell me more' });
  assert.match(lastChat.messages[0].content, /from job\.md/);
  for (const name of ['car-insurance.md', 'job.md']) assert.equal((await fetch(`${base}/api/files/${name}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual((await (await fetch(`${base}/api/files`)).json()).map((f) => f.name).sort(), ['lease.md', 'report.pdf']);
});

test('falls back to an overview for broad questions', async () => {
  await chatEvents({ messages: [{ role: 'user', content: 'Summarize everything' }] });
  assert.match(lastChat.messages[0].content, /\(from (lease\.md|report\.pdf)\)/);
});

test('blocks requests from other websites and rebound hostnames', async () => {
  const evil = await post('/api/files', { name: 'x.md', text: 'x' }, { Origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  const plain = await fetch(`${base}/api/files`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"name":"x","text":"x"}' });
  assert.equal(plain.status, 403);
  assert.equal(await rawGet('/api/files', { Host: 'attacker.example' }), 403);
});

test('rejects unreadable uploads with a helpful message', async () => {
  const res = await post('/api/files', { name: 'scan.pdf', data: Buffer.from('%PDF-1.4\n').toString('base64') });
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /scan/);
});

test('loads the sample file and deletes files', async () => {
  const files = await (await post('/api/sample', {})).json();
  assert.ok(files.some((f) => f.name === 'apartment-lease.md'));
  await fetch(`${base}/api/files/apartment-lease.md`, { method: 'DELETE' });
  const after = await (await fetch(`${base}/api/files`)).json();
  assert.ok(!after.some((f) => f.name === 'apartment-lease.md'));
});

test('switches models', async () => {
  await post('/api/model', { name: 'other:2b' });
  const s = await (await fetch(`${base}/api/status`)).json();
  assert.equal(s.model, 'other:2b');
  assert.equal(s.modelReady, false);
  await post('/api/model', { name: 'tiny:1b' });
});
