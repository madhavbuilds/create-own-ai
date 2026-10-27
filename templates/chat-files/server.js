// {{APP_NAME}}: chat with your files, 100% local.
// Only listens on 127.0.0.1, and only talks to Ollama on your machine.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const ollama = require('./lib/ollama');
const { FileIndex } = require('./lib/search');
const { ChatStore } = require('./lib/chats');
const { extractText, BINARY_TYPES } = require('./lib/extract');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');
const SAMPLES = path.join(__dirname, 'samples');
const DATA = path.join(__dirname, 'data');
const MAX_BODY = 50 * 1024 * 1024;
// How much text the model reads at once, in tokens. Ollama's default (often 4096) is easy to
// overflow with sources plus a long chat, and then it quietly drops the start of the conversation.
const NUM_CTX = Number(process.env.NUM_CTX) || 8192;
const MAX_SOURCES = 6;

let model = ollama.pickModel();
const index = new FileIndex(DATA);
const chats = new ChatStore(DATA);

const SYSTEM_PROMPT = `You are a helpful assistant that answers questions about the user's own files.
- Below are numbered sources for the latest question: passages from the user's files, each labeled with its file name. Use them and cite the ones you use like [1] or [2].
- Different files are about different things. Don't mix facts from different files unless the question asks for that. If a follow-up question is unclear, assume it is about the same file as the conversation so far.
- If the sources don't contain the answer, say so plainly, then answer from general knowledge if you can.
- Be concise.`;

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

const BROAD = /\b(summar\w*|overview|outline|tl;?dr|key points|main points|what('s| is) in)\b/i;
const ALL_FILES = /\b(all|every|each)( of)? (my |the )?(files|documents|docs)\b|\beverything\b/i;

// Picks the passages the model sees for a question. `history` is the conversation so far.
// - A question that names a file ("what does the car insurance cover?") only looks in that file.
// - Follow-ups ("and the notice period there?") also search the previous question, weighted
//   lower, and favor the files the last answer used, so the chat stays on the same document.
// - Weak matches are dropped: a passage from an unrelated file is how answers get mixed up.
// - Broad asks ("summarize the lease") get the start of the file(s) instead.
function findSources(question, history = []) {
  if (!index.list().length) return [];
  const named = index.namedIn(question);
  const only = named.length ? named : null;
  const prevQuestion = history.findLast((m) => m.role === 'user')?.content || '';
  const lastFiles = new Set((history.findLast((m) => m.role === 'assistant')?.sources || []).map((s) => s.doc));

  // The previous question only re-ranks what this one matched, so it can't drag in a file that
  // has nothing to do with the new question. If this one matches nothing, it's used directly.
  const key = (h) => `${h.doc}\0${h.i}`;
  const current = index.search(question, 20, only);
  const previous = prevQuestion ? index.search(prevQuestion, 20, only) : [];
  const prevScore = new Map(previous.map((h) => [key(h), h.score]));
  const pool = current.length ? current : previous;
  const found = pool.map((h) => ({
    ...h,
    score: (h.score + (current.length ? 0.35 * (prevScore.get(key(h)) || 0) : 0)) * (!only && lastFiles.has(h.doc) ? 1.3 : 1),
  }));

  // Keep files that match about as well as the best one; within those, any decent passage.
  let sources = found.sort((a, b) => b.score - a.score);
  const top = sources[0]?.score || 0;
  const best = {};
  for (const s of sources) best[s.doc] = Math.max(best[s.doc] || 0, s.score);
  sources = sources.filter((s) => best[s.doc] >= top * 0.5 && s.score >= top * 0.15).slice(0, MAX_SOURCES);

  if (BROAD.test(question) && only) sources = index.overview(MAX_SOURCES, only);
  else if (ALL_FILES.test(question) && !only) sources = index.overview(MAX_SOURCES);
  else if (!sources.length) sources = index.overview(5, only);

  // Read each file's passages together and in order, like the original document.
  const order = [...new Set(sources.map((s) => s.doc))];
  return sources.sort((a, b) => order.indexOf(a.doc) - order.indexOf(b.doc) || a.i - b.i).map(({ doc, i, text }) => ({ doc, i, text }));
}

// What the model is shown of earlier turns: answers without reasoning or [n] markers (those
// pointed at sources from another turn), newest turns first until the budget runs out.
function modelHistory(messages, budgetChars) {
  const out = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.error) continue;
    let content = m.role === 'assistant'
      ? String(m.content).replace(/<think>[\s\S]*?<\/think>/g, '').replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, '').trim()
      : String(m.content);
    // A long earlier answer only needs its gist; the full text would crowd out everything else.
    if (content.length > 1500) content = `${content.slice(0, 1500)}…`;
    if (!content) continue;
    used += content.length;
    if (used > budgetChars) break;
    out.unshift({ role: m.role === 'assistant' ? 'assistant' : 'user', content });
  }
  while (out[0]?.role === 'assistant') out.shift();
  return out;
}

// The sources for this question go in the system message (small models follow them better
// there than inside the question), then the trimmed conversation, then the question.
function buildPrompt(question, history, sources) {
  const files = index.list().map((f) => f.name);
  const fileNote = files.length ? `The user's files: ${files.slice(0, 50).join(', ')}.` : 'The user has not added any files yet.';
  const context = sources.length
    ? `Sources for the latest question:\n\n${sources.map((s, n) => `[${n + 1}] (from ${s.doc})\n${s.text}`).join('\n\n')}`
    : 'No sources matched this question.';
  const system = `${SYSTEM_PROMPT}\n${fileNote}\n\n${context}`;
  // ~3 characters per token, leaving room for the answer.
  const budget = (NUM_CTX - 1500) * 3 - system.length - question.length;
  return [{ role: 'system', content: system }, ...modelHistory(history, budget), { role: 'user', content: question }];
}

function cleanTitle(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').split('\n').find((l) => l.trim())?.replace(/^(title:)?\s*["'*#]*|["'*.]*\s*$/gi, '').trim().slice(0, 60) || '';
}

async function titleFor(question) {
  const fallback = question.length > 48 ? `${question.slice(0, 45).trim()}…` : question;
  try {
    const t = cleanTitle(await ollama.complete(model, `Write a 3 to 6 word title for a conversation that starts with this question. Reply with only the title.\n\nQuestion: ${question}`, { num_ctx: NUM_CTX }));
    return t || fallback;
  } catch {
    return fallback;
  }
}

// Streams NDJSON events to the browser:
// {type:'chat'} (which saved chat this is), {type:'sources'}, {type:'thinking'|'token'},
// {type:'done'|'error'}, then {type:'title'} if a new chat just got its name.
//
// Body: { message, chatId?, truncate? }. With no chatId a new chat is created. `truncate` cuts the
// chat to that many messages first, which is how editing a question and "Retry" work.
// Also accepts { messages: [...] } for a one-off chat that isn't saved.
async function handleChat(req, res) {
  const body = await readBody(req);
  let chat = null;
  let question;
  let history;
  if (Array.isArray(body.messages)) {
    history = body.messages.slice(0, -1);
    question = String(body.messages.at(-1)?.content || '').trim();
  } else {
    question = String(body.message || '').trim();
    chat = body.chatId ? chats.get(body.chatId) : chats.create();
    if (!chat) return json(res, 404, { error: 'Chat not found' });
    if (Number.isInteger(body.truncate) && body.truncate >= 0) chat.messages = chat.messages.slice(0, body.truncate);
    history = chat.messages.slice();
  }
  if (!question) return json(res, 400, { error: 'Missing message' });

  const sources = findSources(question, history);
  const convo = buildPrompt(question, history, sources);
  if (chat) {
    chat.messages.push({ role: 'user', content: question, at: Date.now() });
    chats.save(chat);
  }

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
  const send = (obj) => !res.writableEnded && res.write(JSON.stringify(obj) + '\n');
  const abort = new AbortController();
  res.on('close', () => abort.abort());

  if (chat) send({ type: 'chat', id: chat.id, title: chat.title });
  send({ type: 'sources', sources });
  const answer = { role: 'assistant', content: '', thinking: '', sources, at: Date.now() };
  try {
    for await (const part of ollama.chat(model, convo, { signal: abort.signal, options: { num_ctx: NUM_CTX, temperature: 0.3 } })) {
      if (part.thinking) {
        answer.thinking += part.thinking;
        send({ type: 'thinking', token: part.thinking });
      }
      if (part.token) {
        answer.content += part.token;
        send({ type: 'token', token: part.token });
      }
      if (part.stats) {
        answer.stats = { model, ...part.stats };
        send({ type: 'done', ...answer.stats });
      }
    }
  } catch (err) {
    if (abort.signal.aborted) answer.stopped = true;
    else {
      answer.error = err.message;
      send({ type: 'error', error: err.message });
    }
  }

  if (chat) {
    if (!answer.thinking) delete answer.thinking;
    chat.messages.push(answer);
    chats.save(chat);
    if (!chat.title && !answer.error) {
      chat.title = abort.signal.aborted ? question.slice(0, 60) : await titleFor(question);
      chats.save(chat);
      send({ type: 'title', id: chat.id, title: chat.title });
    }
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

// Saved chats: list, open, rename, delete, and create (used to bring back a deleted chat).
async function handleChats(req, res, id) {
  if (!id) {
    if (req.method === 'GET') return json(res, 200, chats.list());
    if (req.method === 'POST') {
      const { title = '', messages = [] } = await readBody(req);
      const clean = (Array.isArray(messages) ? messages : [])
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-500);
      return json(res, 200, chats.create({ title: String(title).slice(0, 80), messages: clean }));
    }
  }
  const chat = chats.get(id);
  if (!chat) return json(res, 404, { error: 'Chat not found' });
  if (req.method === 'GET') return json(res, 200, chat);
  if (req.method === 'PATCH') {
    const { title } = await readBody(req);
    if (typeof title === 'string' && title.trim()) chat.title = title.trim().slice(0, 80);
    chats.save(chat);
    return json(res, 200, { id: chat.id, title: chat.title });
  }
  if (req.method === 'DELETE') return json(res, 200, { ok: chats.remove(id) });
  json(res, 405, { error: 'Method not allowed' });
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
    if (pathname === '/api/chats' || pathname.startsWith('/api/chats/')) {
      return await handleChats(req, res, decodeURIComponent(pathname.slice('/api/chats/'.length)));
    }
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

module.exports = { server, findSources, buildPrompt, isTrusted };
