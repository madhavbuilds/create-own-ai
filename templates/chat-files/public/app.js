// Browser side: reads files locally, sends text to the local server, streams answers.

const $ = (id) => document.getElementById(id);
const messagesEl = $('messages');
const input = $('input');
const sendBtn = $('send');
const stopBtn = $('stop');
const banner = $('banner');

const STORE_KEY = 'chat:{{APP_NAME}}';
const TEXT_EXT = /\.(txt|md|markdown|mdx|csv|tsv|json|jsonl|yaml|yml|toml|xml|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|vue|svelte|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|ps1|sql|graphql|ini|cfg|conf|log|tex|bib|rst|org|srt|vtt|ipynb|r|lua|dart|ex|exs|erl|hs|scala|clj|tf|proto|gradle|env\.example)$/i;
const DOC_EXT = /\.(pdf|docx|pptx)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'target', 'vendor', '__pycache__', 'venv', '.venv', 'coverage']);
const SKIP_FILES = /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|poetry\.lock|\.DS_Store)$/;
const MAX_TEXT_BYTES = 10 * 1024 * 1024;
const MAX_DOC_BYTES = 35 * 1024 * 1024;

let history = loadHistory(); // [{ role, content, sources?, stats? }]
let ready = false;
let busy = false;
let controller = null;
let lastStatus = '';
let files = [];

// ---------- helpers ----------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveHistory() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(history.slice(-100)));
  } catch {
    // storage full or blocked: the chat still works, it just won't survive a reload
  }
}

function toast(msg, kind = 'error') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('toasts').append(el);
  setTimeout(() => el.classList.add('hide'), 4500);
  setTimeout(() => el.remove(), 5000);
}

async function* readNdjson(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) if (line.trim()) yield JSON.parse(line);
  }
  if (buf.trim()) yield JSON.parse(buf);
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- markdown ----------

// Reasoning models sometimes write their thinking inline. Split it out so it can be folded away.
function splitThinking(text) {
  const open = text.indexOf('<think>');
  const close = text.indexOf('</think>');
  if (open >= 0 && close > open) return { thinking: text.slice(open + 7, close), answer: text.slice(0, open) + text.slice(close + 8), live: false };
  if (open >= 0) return { thinking: text.slice(open + 7), answer: text.slice(0, open), live: true };
  if (close >= 0) return { thinking: text.slice(0, close), answer: text.slice(close + 8), live: false };
  return { thinking: '', answer: text, live: false };
}

function inline(s, sources) {
  return s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (m, list) => {
      const nums = list.split(/\s*,\s*/).map(Number);
      if (!nums.every((n) => sources[n - 1])) return m;
      return nums.map((n) => `<button type="button" class="cite" data-src="${n - 1}" title="${escapeHtml(sources[n - 1].doc)}">${n}</button>`).join('');
    });
}

// Small Markdown renderer: code blocks, headings, lists, tables, quotes, inline styles, [n] citations.
function renderMarkdown(text, sources = []) {
  const blocks = [];
  let src = text.replace(/```[\w+-]*\n?([\s\S]*?)(```|$)/g, (_, code) => {
    blocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return `\n\u0000${blocks.length - 1}\u0000\n`;
  });
  src = escapeHtml(src);

  const out = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // table: a row of pipes followed by a |---| separator
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim(), sources));
      let html = `<table><thead><tr>${cells(line).map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>`;
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) html += `<tr>${cells(lines[i++]).map((c) => `<td>${c}</td>`).join('')}</tr>`;
      i--;
      out.push(`<div class="table-wrap">${html}</tbody></table></div>`);
      continue;
    }
    const item = line.match(/^\s*([-*•]|\d+[.)])\s+(.*)/);
    if (item) {
      const tag = /\d/.test(item[1]) ? 'ol' : 'ul';
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*([-*•]|\d+[.)])\s+(.*)/);
        if (!m || /\d/.test(m[1]) !== (tag === 'ol')) break;
        items.push(`<li>${inline(m[2], sources)}</li>`);
        i++;
      }
      i--;
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.*)/);
    if (heading) out.push(`<h4>${inline(heading[2], sources)}</h4>`);
    else if (/^\s*&gt;\s?/.test(line)) out.push(`<blockquote>${inline(line.replace(/^\s*&gt;\s?/, ''), sources)}</blockquote>`);
    else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) out.push('<hr />');
    else if (/^\u0000\d+\u0000$/.test(line.trim())) out.push(line.trim());
    else if (line.trim()) out.push(`<p>${inline(line, sources)}</p>`);
  }
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[i]);
}

// ---------- messages ----------

function renderAssistant(bubble, msg, streaming = false) {
  const split = splitThinking(msg.content);
  const answer = split.answer;
  const thinking = (msg.thinking || '') + split.thinking;
  const live = streaming && (split.live || (!!msg.thinking && !answer.trim()));
  let html = '';
  if (thinking.trim()) {
    html += `<details class="thinking"${live ? ' open' : ''}><summary>${live ? 'Thinking…' : 'Reasoning'}</summary>${renderMarkdown(thinking)}</details>`;
  }
  html += renderMarkdown(answer, msg.sources || []);
  if (streaming) html += '<span class="typing"></span>';
  if (msg.error) html += `<p class="error">${escapeHtml(msg.error)}</p>`;
  bubble.innerHTML = html;

  if (streaming) return;
  const names = [...new Set((msg.sources || []).map((s) => s.doc))];
  if (names.length) {
    const row = document.createElement('div');
    row.className = 'sources';
    for (const n of names) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'source';
      chip.textContent = n;
      chip.onclick = () => showSource(n, msg.sources.filter((s) => s.doc === n).map((s) => s.text).join('\n\n· · ·\n\n'));
      row.append(chip);
    }
    bubble.append(row);
  }
  bubble.querySelectorAll('.cite').forEach((b) => {
    b.onclick = () => {
      const s = msg.sources[b.dataset.src];
      showSource(`[${Number(b.dataset.src) + 1}] ${s.doc}`, s.text);
    };
  });

  const bar = document.createElement('div');
  bar.className = 'msg-actions';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy';
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(splitThinking(msg.content).answer.trim());
      copy.textContent = 'Copied';
      setTimeout(() => (copy.textContent = 'Copy'), 1500);
    } catch {
      toast("Couldn't copy to the clipboard");
    }
  };
  bar.append(copy);
  if (msg.error) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Retry';
    retry.onclick = () => {
      const i = history.indexOf(msg);
      const q = history[i - 1]?.content;
      history.splice(i - 1, 2);
      renderHistory();
      if (q) ask(q);
    };
    bar.append(retry);
  }
  if (msg.stats) {
    const s = document.createElement('span');
    s.className = 'stats';
    s.textContent = `${msg.stats.model} · ${Math.round(msg.stats.tokensPerSec)} tokens/s · on this computer`;
    bar.append(s);
  }
  bubble.append(bar);
}

function addBubble(role) {
  $('empty').hidden = true;
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.innerHTML = '<div class="bubble"></div>';
  messagesEl.append(el);
  return el.querySelector('.bubble');
}

function renderHistory() {
  messagesEl.querySelectorAll('.msg').forEach((m) => m.remove());
  $('empty').hidden = history.length > 0;
  for (const msg of history) {
    const bubble = addBubble(msg.role);
    if (msg.role === 'user') bubble.textContent = msg.content;
    else renderAssistant(bubble, msg);
  }
  scrollDown(true);
}

function scrollDown(force) {
  // Only follow the stream if the reader hasn't scrolled up to read something.
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
  if (force || nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function showSource(title, text) {
  $('sourceTitle').textContent = title;
  $('sourceText').textContent = text;
  $('sourceDialog').showModal();
}
$('closeSource').onclick = () => $('sourceDialog').close();
$('sourceDialog').onclick = (e) => { if (e.target === $('sourceDialog')) $('sourceDialog').close(); };

// ---------- status & first-run setup ----------

async function checkStatus() {
  const dot = $('statusDot');
  let s;
  try {
    s = await api('/api/status');
  } catch {
    s = null;
  }
  const state = !s ? 'offline' : !s.ollama ? 'no-ollama' : !s.modelReady ? `no-model:${s.model}` : `ready:${s.model}`;
  ready = state.startsWith('ready');
  updateSend();
  if (state === lastStatus) return;
  lastStatus = state;

  if (s) $('meta').textContent = `${s.ramGB} GB RAM · works offline`;
  dot.className = `dot ${ready ? 'ok' : 'bad'}`;

  if (!s) {
    dot.setAttribute('aria-label', 'Server offline');
    showBanner('<strong>Lost connection to the local server.</strong> Is <code>npm run dev</code> still running?');
  } else if (!s.ollama) {
    dot.setAttribute('aria-label', 'Ollama is not running');
    showBanner(`<strong>One more thing: start Ollama.</strong> It's the free app that runs AI models on your computer.<br />
      Install it from <a href="https://ollama.com/download" target="_blank" rel="noopener">ollama.com/download</a> and open it. This page connects by itself.`);
  } else if (!s.modelReady) {
    dot.setAttribute('aria-label', 'Model not downloaded');
    const picked = s.model === s.recommended ? `picked for your ${s.ramGB} GB of RAM` : 'the model you chose';
    showBanner(`<strong>One-time setup:</strong> download <code>${escapeHtml(s.model)}</code> (${picked}). After this, everything works offline.<br />
      <button id="pullBtn" class="primary">Download model</button><div class="progress" hidden><div></div></div><div id="pullText" class="pull-text"></div>`);
    $('pullBtn').onclick = pullModel;
  } else {
    dot.setAttribute('aria-label', 'Ready');
    if (!banner.dataset.pulling) banner.hidden = true;
  }
  if (s?.ollama) loadModels(s.model);
}

function showBanner(html) {
  if (banner.dataset.pulling) return;
  banner.innerHTML = html;
  banner.hidden = false;
}

async function pullModel() {
  banner.dataset.pulling = '1';
  $('pullBtn').disabled = true;
  const bar = banner.querySelector('.progress');
  bar.hidden = false;
  try {
    const res = await fetch('/api/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    for await (const p of readNdjson(res)) {
      if (p.error) throw new Error(p.error);
      if (p.total) bar.firstElementChild.style.width = `${Math.round((p.completed / p.total) * 100)}%`;
      $('pullText').textContent = p.total
        ? `${p.status} · ${((p.completed || 0) / 1e9).toFixed(2)} / ${(p.total / 1e9).toFixed(2)} GB`
        : p.status;
    }
  } catch (err) {
    $('pullText').textContent = `Download failed: ${err.message}. Check your internet connection and try again.`;
    $('pullBtn').disabled = false;
  }
  delete banner.dataset.pulling;
  lastStatus = '';
  checkStatus();
}

async function loadModels(current) {
  const select = $('modelSelect');
  let models = [];
  try {
    models = await api('/api/models');
  } catch {
    // leave the list as it is
  }
  const names = models.map((m) => m.name);
  const options = names.includes(current) ? models : [{ name: current, missing: true }, ...models];
  select.innerHTML = options
    .map((m) => `<option value="${escapeHtml(m.name)}">${escapeHtml(m.name)}${m.missing ? ' (not downloaded)' : m.params ? ` · ${escapeHtml(m.params)}` : ''}</option>`)
    .join('');
  select.value = current;
}

$('modelSelect').onchange = async (e) => {
  try {
    await api('/api/model', { name: e.target.value });
    lastStatus = '';
    await checkStatus();
    toast(`Switched to ${e.target.value}`, 'info');
  } catch (err) {
    toast(err.message);
  }
};

// ---------- files ----------

const ICONS = { pdf: '📕', docx: '📘', pptx: '📙', csv: '📊', tsv: '📊', md: '📝', txt: '📄' };
const iconFor = (name) => ICONS[name.split('.').pop().toLowerCase()] || (TEXT_EXT.test(name) ? '🧩' : '📄');

async function refreshFiles() {
  try {
    files = await api('/api/files');
  } catch {
    return;
  }
  $('fileCount').textContent = files.length ? `(${files.length})` : '';
  $('sampleBtn').hidden = files.length > 0;
  const list = $('fileList');
  list.innerHTML = files.length ? '' : '<li class="placeholder">No files yet. Without files it works as a private chat.</li>';
  for (const f of files) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="ficon" aria-hidden="true"></span><div class="finfo"><div class="name"></div><div class="size"></div></div><button class="icon-btn" title="Remove">✕</button>`;
    li.querySelector('.ficon').textContent = iconFor(f.name);
    li.querySelector('.name').textContent = f.name;
    li.querySelector('.name').title = f.name;
    li.querySelector('.size').textContent = `${f.chars >= 1000 ? `${(f.chars / 1000).toFixed(1)}k` : f.chars} chars · ${f.chunks} ${f.chunks === 1 ? 'chunk' : 'chunks'}`;
    li.querySelector('button').setAttribute('aria-label', `Remove ${f.name}`);
    li.querySelector('button').onclick = async () => {
      await fetch(`/api/files/${encodeURIComponent(f.name)}`, { method: 'DELETE' });
      refreshFiles();
    };
    list.append(li);
  }
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

// Accepts [{ file, path }] and uploads them one by one with progress.
async function addFiles(entries) {
  const status = $('uploadStatus');
  let added = 0;
  const skipped = [];
  status.hidden = false;
  for (const [i, { file, path }] of entries.entries()) {
    const name = path || file.name;
    status.textContent = `Adding ${i + 1} of ${entries.length}: ${name}`;
    try {
      let body;
      if (DOC_EXT.test(file.name)) {
        if (file.size > MAX_DOC_BYTES) throw new Error('too large (max 35 MB)');
        body = { name, data: await readAsBase64(file) };
      } else {
        if (file.size > MAX_TEXT_BYTES) throw new Error('too large (max 10 MB)');
        const text = await file.text();
        // Images, archives and other binaries: not readable as text.
        if (text.includes('\u0000') || (!TEXT_EXT.test(file.name) && file.type && !file.type.startsWith('text/'))) {
          throw new Error('not a text, PDF, Word or PowerPoint file');
        }
        body = { name, text };
      }
      await api('/api/files', body);
      added++;
    } catch (err) {
      skipped.push(`${name}: ${err.message}`);
    }
    if (i % 10 === 9) refreshFiles();
  }
  status.hidden = true;
  await refreshFiles();
  if (added) toast(`Added ${added} ${added === 1 ? 'file' : 'files'}`, 'info');
  if (skipped.length === 1) toast(`Skipped ${skipped[0]}`);
  else if (skipped.length) toast(`Skipped ${skipped.length} files (${skipped[0]}, ...)`);
}

// Walks dropped folders, skipping dependency and build folders.
async function collectEntries(items) {
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.name.startsWith('.') && prefix) return;
    if (entry.isFile) {
      if (SKIP_FILES.test(entry.name)) return;
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path: prefix + entry.name });
    } else if (entry.isDirectory && !SKIP_DIRS.has(entry.name)) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      } while (batch.length);
    }
  };
  for (const entry of items) if (entry) await walk(entry, '');
  return out;
}

const drop = $('drop');
$('fileInput').onchange = (e) => {
  addFiles([...e.target.files].map((file) => ({ file })));
  e.target.value = '';
};
let dragDepth = 0;
document.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const items = [...(e.dataTransfer.items || [])].filter((i) => i.kind === 'file');
  const entries = items.length && items[0].webkitGetAsEntry
    ? await collectEntries(items.map((i) => i.webkitGetAsEntry()))
    : [...e.dataTransfer.files].map((file) => ({ file }));
  if (entries.length) addFiles(entries);
});

$('sampleBtn').onclick = async () => {
  try {
    await api('/api/sample', {});
    await refreshFiles();
    toast('Added a sample lease. Try asking when the rent is due.', 'info');
    input.value = 'When is the rent due, and what happens if I pay late?';
    input.dispatchEvent(new Event('input'));
    input.focus();
  } catch (err) {
    toast(err.message);
  }
};

// ---------- chat ----------

function updateSend() {
  sendBtn.disabled = !ready || busy || !input.value.trim();
  sendBtn.hidden = busy;
  stopBtn.hidden = !busy;
  input.placeholder = ready ? (files.length ? 'Ask about your files...' : 'Ask anything, or add files first...') : 'Finish setup above to start chatting';
}

async function ask(question) {
  busy = true;
  updateSend();
  const userMsg = { role: 'user', content: question };
  history.push(userMsg);
  addBubble('user').textContent = question;
  const msg = { role: 'assistant', content: '', thinking: '', sources: [] };
  const bubble = addBubble('assistant');
  bubble.innerHTML = '<span class="typing"></span>';
  scrollDown(true);

  controller = new AbortController();
  try {
    // The model only needs the answers, not its own reasoning or our UI extras.
    const convo = history.map((m) => ({ role: m.role, content: m.role === 'assistant' ? splitThinking(m.content).answer : m.content }));
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: convo }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Server error ${res.status}`);
    let frame = 0;
    for await (const ev of readNdjson(res)) {
      if (ev.type === 'sources') msg.sources = ev.sources;
      if (ev.type === 'thinking' || ev.type === 'token') {
        if (ev.type === 'thinking') msg.thinking = (msg.thinking || '') + ev.token;
        else msg.content += ev.token;
        // Re-render at most once per animation frame so long answers stay smooth.
        if (!frame) frame = requestAnimationFrame(() => { frame = 0; renderAssistant(bubble, msg, true); scrollDown(); });
      }
      if (ev.type === 'done') msg.stats = { model: ev.model, tokensPerSec: ev.tokensPerSec };
      if (ev.type === 'error') throw new Error(ev.error);
    }
    cancelAnimationFrame(frame);
  } catch (err) {
    if (err.name === 'AbortError') msg.content += msg.content ? '\n\n*(stopped)*' : '*(stopped)*';
    else msg.error = `Something went wrong: ${err.message}`;
  }
  history.push(msg);
  saveHistory();
  renderAssistant(bubble, msg);
  scrollDown();
  busy = false;
  controller = null;
  updateSend();
  input.focus();
}

$('composer').onsubmit = (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (!q || !ready || busy) return;
  input.value = '';
  input.style.height = 'auto';
  ask(q);
};
stopBtn.onclick = () => controller?.abort();
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
  updateSend();
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && busy) controller?.abort(); });
document.querySelectorAll('.suggestion').forEach((b) => (b.onclick = () => {
  if (!ready) return toast('Finish the setup above first');
  if (!busy) ask(b.textContent);
}));

$('newChat').onclick = () => {
  if (busy) controller?.abort();
  history = [];
  saveHistory();
  renderHistory();
  input.focus();
};

// Small screens: the file list slides in from the left.
$('openSidebar').onclick = () => document.body.classList.add('sidebar-open');
$('closeSidebar').onclick = () => document.body.classList.remove('sidebar-open');
document.querySelector('.chat').addEventListener('click', (e) => {
  if (document.body.classList.contains('sidebar-open') && e.target.id !== 'openSidebar') document.body.classList.remove('sidebar-open');
});

renderHistory();
checkStatus();
refreshFiles().then(updateSend);
setInterval(checkStatus, 5000);
input.focus();
