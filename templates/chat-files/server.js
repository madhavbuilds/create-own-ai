// {{APP_NAME}}: chat with your files, 100% local.
// Only listens on 127.0.0.1, and only talks to Ollama on your machine.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const ollama = require('./lib/ollama');
const { FileIndex } = require('./lib/search');
const { extractText, BINARY_TYPES } = require('./lib/extract');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');
const SAMPLES = path.join(__dirname, 'samples');
const MAX_BODY = 50 * 1024 * 1024;

let model = ollama.pickModel();
const index = new FileIndex(path.join(__dirname, 'data'));

const SYSTEM_PROMPT = `You are a helpful assistant that answers questions using the user's own files.
Use the numbered sources below when they are relevant and cite them like [1] or [2].
If the sources don't contain the answer, say so plainly, then answer from general knowledge if you can.
Be concise.`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// Websites you visit can send requests to localhost too. Only accept requests addressed to this
// machine (blocks DNS rebinding) and, for changes, only from this app's own page.
function isTrusted(req) {
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
  if (!local.test(req.headers.host || '')) return false;
  if (req.method === 'GET') return true;
  const origin = req.headers.origin;
  if (origin && !local.test(origin.replace(/^https?:\/\//, ''))) return false;
  return (req.headers['content-type'] || '').startsWith('application/json') || req.method === 'DELETE';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('File too large (max 35 MB)'), { status: 413 }));
        req.destroy();
      } else parts.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404);
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

// Finds what to show the model. Follow-ups like "tell me more" have no keywords of their own,
// so the previous question is searched too. Broad asks ("summarize my files") match nothing,
// so they get the start of the most recent files instead.
function findSources(messages) {
  const asks = messages.filter((m) => m.role === 'user').map((m) => m.content);
  let sources = index.search(asks.slice(-1).join(' '), 5);
  if (sources.length < 2 && asks.length > 1) sources = index.search(asks.slice(-2).join(' '), 5);
  if (!sources.length) sources = index.overview(5);
  return sources;
}

// Streams NDJSON events to the browser: {type:'sources'}, {type:'thinking'|'token'}, {type:'done'|'error'}.
async function handleChat(req, res) {
  const { messages = [] } = await readBody(req);
  const sources = findSources(messages);
  const files = index.list().map((f) => f.name);

  const context = sources.length
    ? sources.map((s, i) => `[${i + 1}] (from ${s.doc})\n${s.text}`).join('\n\n')
    : '(no files added yet)';
  const fileNote = files.length ? `The user has added these files: ${files.slice(0, 50).join(', ')}.` : '';

  const convo = [
    { role: 'system', content: `${SYSTEM_PROMPT}\n${fileNote}\n\nSources:\n${context}` },
    ...messages.slice(-10).map(({ role, content }) => ({ role, content: String(content) })),
  ];

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
  const send = (obj) => res.write(JSON.stringify(obj) + '\n');
  const abort = new AbortController();
  res.on('close', () => abort.abort());

  send({ type: 'sources', sources: sources.map((s) => ({ doc: s.doc, text: s.text })) });
  try {
    for await (const part of ollama.chat(model, convo, abort.signal)) {
      if (part.thinking) send({ type: 'thinking', token: part.thinking });
      if (part.token) send({ type: 'token', token: part.token });
      if (part.stats) send({ type: 'done', model, ...part.stats });
    }
  } catch (err) {
    if (!abort.signal.aborted) send({ type: 'error', error: err.message });
  }
  res.end();
}

async function handlePull(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  try {
    for await (const p of ollama.pull(model)) res.write(JSON.stringify(p) + '\n');
  } catch (err) {
    res.write(JSON.stringify({ error: err.message }) + '\n');
  }
  res.end();
}

async function handleUpload(req, res) {
  const { name, text, data } = await readBody(req);
  const fileName = String(name || '').slice(0, 200);
  if (!fileName) return json(res, 400, { error: 'Missing file name' });
  const ext = fileName.toLowerCase().split('.').pop();
  const content = data && BINARY_TYPES.includes(ext) ? extractText(fileName, Buffer.from(data, 'base64')) : text;
  if (typeof content !== 'string' || !content.trim()) return json(res, 400, { error: `${fileName} is empty` });
  return json(res, 200, index.add(fileName, content));
}

const routes = {
  'GET /api/status': async (req, res) => {
    const running = await ollama.isRunning();
    json(res, 200, {
      ollama: running,
      model,
      recommended: ollama.pickModel(),
      modelReady: running ? await ollama.hasModel(model) : false,
      ramGB: Math.round(os.totalmem() / 1024 ** 3),
    });
  },
  'GET /api/models': async (req, res) => json(res, 200, await ollama.listModels()),
  'POST /api/model': async (req, res) => {
    const { name } = await readBody(req);
    if (!name || typeof name !== 'string') return json(res, 400, { error: 'Missing model name' });
    model = name;
    json(res, 200, { model });
  },
  'POST /api/pull': handlePull,
  'POST /api/chat': handleChat,
  'GET /api/files': (req, res) => json(res, 200, index.list()),
  'POST /api/files': handleUpload,
  'POST /api/sample': (req, res) => {
    for (const f of fs.readdirSync(SAMPLES)) index.add(f, fs.readFileSync(path.join(SAMPLES, f), 'utf8'));
    json(res, 200, index.list());
  },
};

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  try {
    if (!isTrusted(req)) return json(res, 403, { error: 'Forbidden' });
    const route = routes[`${req.method} ${pathname}`];
    if (route) return await route(req, res);
    if (pathname.startsWith('/api/files/') && req.method === 'DELETE') {
      index.remove(decodeURIComponent(pathname.slice('/api/files/'.length)));
      return json(res, 200, { ok: true });
    }
    if (pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
    if (req.method === 'GET') return serveStatic(req, res);
    json(res, 404, { error: 'Not found' });
  } catch (err) {
    if (!res.headersSent) json(res, err.status || 500, { error: err.message });
    else res.end();
  }
});

function openBrowser(url) {
  if (process.env.NO_OPEN || !process.stdout.isTTY) return;
  const cmd = { darwin: ['open', [url]], win32: ['cmd', ['/c', 'start', '', url]] }[process.platform] || ['xdg-open', [url]];
  spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

// If the port is taken (another app, or this one twice), try the next few.
function listen(port, triesLeft = 10) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && triesLeft > 0 && !process.env.PORT) return listen(port + 1, triesLeft - 1);
    console.error(`\n  Couldn't start the server: ${err.message}\n`);
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  {{APP_NAME}} is running at \x1b[36m${url}\x1b[0m`);
    console.log(`  Model: ${model}  (switch it in the app, or MODEL=name npm run dev)`);
    console.log('  Everything stays on this machine. Press Ctrl+C to stop.\n');
    openBrowser(url);
  });
}

// Exit cleanly on Ctrl+C so the index's exit hook can save any pending changes.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

if (require.main === module) listen(PORT);

module.exports = { server, findSources, isTrusted };
