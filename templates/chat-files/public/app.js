// Browser side: saved chats, file uploads, and streamed answers from the local server.

const $ = (id) => document.getElementById(id);
const scroller = $('scroller');
const messagesEl = $('messages');
const input = $('input');
const sendBtn = $('send');
const stopBtn = $('stop');
const banner = $('banner');

const TEXT_EXT = /\.(txt|md|markdown|mdx|csv|tsv|json|jsonl|yaml|yml|toml|xml|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|vue|svelte|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|ps1|sql|graphql|ini|cfg|conf|log|tex|bib|rst|org|srt|vtt|ipynb|r|lua|dart|ex|exs|erl|hs|scala|clj|tf|proto|gradle|env\.example)$/i;
const DOC_EXT = /\.(pdf|docx|pptx)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'target', 'vendor', '__pycache__', 'venv', '.venv', 'coverage']);
const SKIP_FILES = /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|poetry\.lock|\.DS_Store)$/;
const MAX_TEXT_BYTES = 10 * 1024 * 1024;
const MAX_DOC_BYTES = 35 * 1024 * 1024;
const LEGACY_KEY = 'chat:{{APP_NAME}}'; // where 1.0 kept a single chat in the browser

let chats = []; // sidebar list: [{ id, title, updated, count }]
let chat = { id: null, title: '', messages: [] }; // the open chat; id is null until the first answer starts
let files = [];
let ready = false;
let busy = false;
let controller = null;
let lastStatus = '';
const pendingDeletes = new Map();

// ---------- icons ----------

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  upload: '<path d="M12 15V3m0 0L8 7m4-4 4 4"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7z"/>',
  arrowDown: '<path d="M12 5v14m0 0-6-6m6 6 6-6"/>',
  arrowUp: '<path d="M12 19V5m0 0-6 6m6-6 6 6"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/>',
  paperclip: '<path d="m21 11-8.6 8.6a5 5 0 0 1-7-7l8.5-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.3-2.3l7.9-8"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  retry: '<path d="M3 12a9 9 0 0 1 15.5-6.3L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16"/><path d="M3 21v-5h5"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
};

function icon(name, size = 18) {
  return `<svg class="ic" aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
}
document.querySelectorAll('[data-icon]').forEach((el) => el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon)));

// ---------- helpers ----------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

function toast(msg, kind = 'error', action) {
  const node = el('div', `toast ${kind}`);
  node.append(el('span', '', escapeHtml(msg)));
  if (action) {
    const btn = el('button', 'toast-action', escapeHtml(action.label));
    btn.onclick = () => { action.run(); node.remove(); };
    node.append(btn);
  }
  $('toasts').append(node);
  setTimeout(() => node.classList.add('hide'), action ? 5500 : 4000);
  setTimeout(() => node.remove(), action ? 6000 : 4500);
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

async function api(path, body, method) {
  const opts = body === undefined && !method ? {} : {
    method: method || 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    return null; // storage blocked: these are only conveniences
  }
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
  let src = text.replace(/```([\w+-]*)\n?([\s\S]*?)(```|$)/g, (_, lang, code) => {
    blocks.push(`<div class="code"><div class="code-head"><span>${escapeHtml(lang || 'code')}</span><button type="button" class="copy-code">${icon('copy', 14)}Copy</button></div><pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre></div>`);
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
      const start = tag === 'ol' ? parseInt(item[1], 10) : 1;
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*([-*•]|\d+[.)])\s+(.*)/);
        if (!m || /\d/.test(m[1]) !== (tag === 'ol')) break;
        items.push(`<li>${inline(m[2], sources)}</li>`);
        i++;
      }
      i--;
      out.push(`<${tag}${start > 1 ? ` start="${start}"` : ''}>${items.join('')}</${tag}>`);
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

const msgOf = new WeakMap(); // message element -> message object, for clicks on citations etc.

function actionButton(name, label, onClick) {
  const b = el('button', 'act', icon(name, 15));
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.onclick = onClick;
  return b;
}

async function copyText(btn, text) {
  try {
    await navigator.clipboard.writeText(text);
    const old = btn.innerHTML;
    btn.innerHTML = icon('check', 15);
    setTimeout(() => (btn.innerHTML = old), 1400);
  } catch {
    toast("Couldn't copy to the clipboard");
  }
}

function renderAssistant(node, msg, streaming = false) {
  const body = node.querySelector('.body');
  const split = splitThinking(msg.content);
  const answer = split.answer;
  const thinking = (msg.thinking || '') + split.thinking;
  const live = streaming && (split.live || (!!msg.thinking && !answer.trim()));
  let html = '';
  if (thinking.trim()) {
    html += `<details class="thinking"${live ? ' open' : ''}><summary>${live ? 'Thinking…' : 'Show reasoning'}</summary>${renderMarkdown(thinking)}</details>`;
  }
  if (!answer.trim() && streaming && !thinking.trim()) {
    // Say what's happening while the model reads, so a slow first word doesn't feel stuck.
    const docs = [...new Set((msg.sources || []).map((s) => s.doc.split('/').pop()))];
    const doing = !msg.sources ? 'Searching your files' : docs.length ? `Reading ${docs.length > 2 ? `${docs.length} files` : docs.join(' and ')}` : 'Thinking';
    html += `<div class="waiting"><div class="dots"><i></i><i></i><i></i></div><span>${escapeHtml(doing)}…</span></div>`;
  }
  html += renderMarkdown(answer, msg.sources || []);
  if (streaming && answer.trim()) {
    // Put the blinking caret at the end of the last line of text.
    const at = Math.max(...['</p>', '</li>', '</h4>', '</td>', '</blockquote>'].map((t) => html.lastIndexOf(t)));
    if (at > 0) html = `${html.slice(0, at)}<span class="caret"></span>${html.slice(at)}`;
  }
  if (msg.error) html += `<div class="error-box">${icon('x', 15)}<span>${escapeHtml(msg.error)}</span></div>`;
  body.innerHTML = html;

  node.querySelector('.sources')?.remove();
  node.querySelector('.msg-actions')?.remove();
  if (streaming) return;

  const docs = [...new Set((msg.sources || []).map((s) => s.doc))];
  if (docs.length) {
    const row = el('div', 'sources');
    row.append(el('span', 'sources-label', 'Sources'));
    for (const doc of docs) {
      const parts = msg.sources.filter((s) => s.doc === doc);
      const chip = el('button', 'source', `<span class="ftype ${typeOf(doc).cls}">${typeOf(doc).label}</span><span class="source-name"></span>`);
      chip.type = 'button';
      chip.querySelector('.source-name').textContent = doc.split('/').pop();
      chip.title = parts.length > 1 ? `${doc} · ${parts.length} passages` : doc;
      chip.onclick = () => showSource(msg, parts);
      row.append(chip);
    }
    node.append(row);
  }

  const bar = el('div', 'msg-actions');
  bar.append(actionButton('copy', 'Copy answer', (e) => copyText(e.currentTarget, splitThinking(msg.content).answer.trim())));
  const isLast = chat.messages.at(-1) === msg;
  if (isLast || msg.error) bar.append(actionButton('retry', 'Regenerate answer', () => regenerate(msg)));
  if (msg.stopped) bar.append(el('span', 'tag', 'Stopped'));
  if (msg.stats) {
    bar.append(el('span', 'stats', `${escapeHtml(msg.stats.model)} · ${Math.round(msg.stats.tokensPerSec)} tokens/s · on this computer`));
  }
  node.append(bar);
}

function renderUser(node, msg) {
  node.innerHTML = '<div class="bubble"></div>';
  node.querySelector('.bubble').textContent = msg.content;
  const bar = el('div', 'msg-actions');
  bar.append(actionButton('edit', 'Edit question', () => editQuestion(node, msg)));
  bar.append(actionButton('copy', 'Copy question', (e) => copyText(e.currentTarget, msg.content)));
  node.append(bar);
}

function addMessage(msg) {
  const node = el('div', `msg ${msg.role}`);
  if (msg.role === 'assistant') node.append(el('div', 'body'));
  msgOf.set(node, msg);
  messagesEl.append(node);
  if (msg.role === 'user') renderUser(node, msg);
  else renderAssistant(node, msg);
  return node;
}

function renderChat() {
  messagesEl.innerHTML = '';
  for (const msg of chat.messages) addMessage(msg);
  updateEmpty();
  $('chatTitle').textContent = chat.title || 'New chat';
  document.title = chat.title ? `${chat.title} · {{APP_NAME}}` : '{{APP_NAME}}';
  renderChatList();
  scrollDown(true);
}

function updateEmpty() {
  const empty = !chat.messages.length;
  $('empty').hidden = !empty;
  messagesEl.hidden = empty;
  if (!empty) return;
  const n = files.length;
  $('emptyTitle').textContent = n ? `Ask about your ${n === 1 ? 'file' : `${n} files`}` : 'What do you want to know?';
  $('emptyText').textContent = n
    ? 'Answers cite the passages they come from. Everything stays on this computer.'
    : 'Add files to chat with them, or just ask. Everything stays on this computer.';
  $('sampleBtn').hidden = n > 0;
  const first = files[0]?.name.split('/').pop();
  const ideas = n
    ? [`Summarize ${first}`, 'What are the key dates and deadlines?', `What should I watch out for in ${first}?`, 'List the most important numbers and what they mean']
    : ['What can you help me with?', 'Explain how a local AI model works', 'Write a polite email asking for a deadline extension', 'Give me 5 ideas for a weekend project'];
  const box = $('suggestions');
  box.innerHTML = '';
  for (const q of ideas) {
    const b = el('button', 'suggestion', `${icon(n ? 'file' : 'chat', 16)}<span></span>`);
    b.type = 'button';
    b.querySelector('span').textContent = q;
    b.onclick = () => {
      if (!ready) return toast('Finish the setup above first');
      if (!busy) ask(q);
    };
    box.append(b);
  }
}

function nearBottom() {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
}

function scrollDown(force) {
  // Only follow the stream if the reader hasn't scrolled up to read something.
  if (force || nearBottom()) scroller.scrollTop = scroller.scrollHeight;
}
scroller.addEventListener('scroll', () => ($('toBottom').hidden = nearBottom()), { passive: true });
$('toBottom').onclick = () => scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });

// Citations and code copy buttons, for every message.
messagesEl.addEventListener('click', (e) => {
  const cite = e.target.closest('.cite');
  if (cite) {
    const msg = msgOf.get(cite.closest('.msg'));
    return showSource(msg, [msg.sources[cite.dataset.src]], Number(cite.dataset.src) + 1);
  }
  const copy = e.target.closest('.copy-code');
  if (copy) copyText(copy, copy.closest('.code').querySelector('code').textContent);
});

// Shows the passages an answer used, with the words from the question highlighted.
function showSource(msg, parts, number) {
  const i = chat.messages.indexOf(msg);
  const question = chat.messages.slice(0, i).findLast((m) => m.role === 'user')?.content || '';
  const common = new Set('what when where which that this with have does will your about there they them then than from into could would should much many some also just like'.split(' '));
  const terms = [...new Set(question.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || [])]
    .filter((t) => !common.has(t))
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, Math.max(4, t.length - 2)));
  const mark = (text) => {
    const safe = escapeHtml(text);
    return terms.length ? safe.replace(new RegExp(`(?<![\\p{L}\\p{N}])(${terms.join('|')})[\\p{L}\\p{N}]*`, 'giu'), '<mark>$&</mark>') : safe;
  };
  const doc = parts[0].doc;
  $('sourceEyebrow').textContent = number ? `Source ${number}` : parts.length > 1 ? `${parts.length} passages used` : 'Passage used';
  $('sourceTitle').textContent = doc;
  $('sourceText').innerHTML = parts.map((p) => `<div class="passage">${mark(p.text)}</div>`).join('');
  $('sourceDialog').showModal();
  $('sourceText').scrollTop = 0;
  $('sourceText').querySelector('mark')?.scrollIntoView({ block: 'center' });
}
$('closeSource').onclick = () => $('sourceDialog').close();
$('sourceDialog').onclick = (e) => { if (e.target === $('sourceDialog')) $('sourceDialog').close(); };

// ---------- saved chats ----------

function groupLabel(time) {
  const day = 864e5;
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  if (time >= startOfToday) return 'Today';
  if (time >= startOfToday - day) return 'Yesterday';
  if (time >= startOfToday - 7 * day) return 'Previous 7 days';
  if (time >= startOfToday - 30 * day) return 'Previous 30 days';
  return new Date(time).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

async function loadChats() {
  try {
    chats = await api('/api/chats');
  } catch {
    return;
  }
  renderChatList();
}

function renderChatList() {
  const list = $('chatList');
  const q = $('chatSearch').value.trim().toLowerCase();
  const shown = chats.filter((c) => !pendingDeletes.has(c.id) && (!q || c.title.toLowerCase().includes(q)));
  list.innerHTML = '';
  if (!shown.length) {
    list.append(el('p', 'list-empty', q ? 'No chats match.' : 'Your chats will show up here. They are saved on this computer.'));
    return;
  }
  let group = '';
  for (const c of shown) {
    const label = groupLabel(c.updated);
    if (label !== group) list.append(el('div', 'group', escapeHtml((group = label))));
    const item = el('div', `chat-item${c.id === chat.id ? ' active' : ''}`);
    item.innerHTML = '<button type="button" class="chat-link"></button><div class="chat-tools"></div>';
    const link = item.querySelector('.chat-link');
    link.textContent = c.title;
    link.title = c.title;
    if (c.id === chat.id) link.setAttribute('aria-current', 'page');
    link.onclick = () => openChat(c.id);
    link.ondblclick = () => renameInList(item, c);
    const tools = item.querySelector('.chat-tools');
    tools.append(actionButton('edit', 'Rename', () => renameInList(item, c)));
    tools.append(actionButton('trash', 'Delete', () => deleteChat(c)));
    list.append(item);
  }
}
$('chatSearch').addEventListener('input', renderChatList);

async function saveTitle(id, title) {
  title = title.trim();
  const c = chats.find((x) => x.id === id);
  if (!title || !c || title === c.title) return;
  c.title = title;
  if (chat.id === id) {
    chat.title = title;
    $('chatTitle').textContent = title;
    document.title = `${title} · {{APP_NAME}}`;
  }
  renderChatList();
  try {
    await api(`/api/chats/${id}`, { title }, 'PATCH');
  } catch (err) {
    toast(err.message);
  }
}

function renameInList(item, c) {
  const field = el('input', 'rename');
  field.value = c.title;
  field.setAttribute('aria-label', 'Chat name');
  item.replaceChildren(field);
  field.focus();
  field.select();
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    if (keep) saveTitle(c.id, field.value);
    renderChatList();
  };
  field.onkeydown = (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  };
  field.onblur = () => finish(true);
}

// The title in the top bar can be renamed in place too.
$('chatTitle').onclick = () => {
  if (!chat.id) return;
  const h = $('chatTitle');
  try {
    h.contentEditable = 'plaintext-only';
  } catch {
    h.contentEditable = 'true'; // older Firefox
  }
  h.focus();
  document.getSelection().selectAllChildren(h);
};
$('chatTitle').onkeydown = (e) => {
  if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
  if (e.key === 'Escape') { e.target.textContent = chat.title; e.target.blur(); }
};
$('chatTitle').onblur = (e) => {
  e.target.contentEditable = 'false';
  if (e.target.textContent.trim()) saveTitle(chat.id, e.target.textContent);
  else e.target.textContent = chat.title || 'New chat';
};

// Deleting waits a few seconds so it can be undone.
function deleteChat(c) {
  if (chat.id === c.id) newChat();
  const timer = setTimeout(async () => {
    pendingDeletes.delete(c.id);
    chats = chats.filter((x) => x.id !== c.id);
    try {
      await api(`/api/chats/${c.id}`, undefined, 'DELETE');
    } catch (err) {
      toast(err.message);
    }
  }, 5500);
  pendingDeletes.set(c.id, timer);
  renderChatList();
  toast(`Deleted "${c.title}"`, 'info', {
    label: 'Undo',
    run: () => {
      clearTimeout(pendingDeletes.get(c.id));
      pendingDeletes.delete(c.id);
      renderChatList();
    },
  });
}
// Leaving the page finishes any delete that's waiting.
addEventListener('pagehide', () => {
  for (const id of pendingDeletes.keys()) fetch(`/api/chats/${id}`, { method: 'DELETE', keepalive: true });
});

async function openChat(id, push = true) {
  if (busy) controller?.abort();
  closeSidebarOnMobile();
  if (chat.id === id) return;
  try {
    chat = await api(`/api/chats/${encodeURIComponent(id)}`);
  } catch {
    toast('That chat no longer exists');
    return newChat();
  }
  if (push) history.pushState(null, '', `#/c/${id}`);
  renderChat();
  input.focus();
}

function newChat() {
  if (busy) controller?.abort();
  chat = { id: null, title: '', messages: [] };
  if (location.hash) history.pushState(null, '', location.pathname);
  renderChat();
  closeSidebarOnMobile();
  input.focus();
}

function route() {
  const id = location.hash.match(/^#\/c\/([a-z0-9]+)$/)?.[1];
  if (id) openChat(id, false);
  else if (chat.id) newChat();
}
addEventListener('popstate', route);

// 1.0 kept one chat in the browser. Move it into the saved chats once.
async function importLegacyChat() {
  let old;
  try {
    old = JSON.parse(store(LEGACY_KEY));
  } catch {
    return;
  }
  if (!Array.isArray(old) || !old.length) return;
  try {
    const first = old.find((m) => m.role === 'user')?.content || 'Earlier chat';
    await api('/api/chats', { title: first.slice(0, 60), messages: old });
    store(LEGACY_KEY, null);
  } catch {
    // try again next time
  }
}

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

  dot.className = `dot ${ready ? 'ok' : 'bad'}`;
  $('meta').textContent = !s ? 'Server offline' : !s.ollama ? 'Ollama not running' : !s.modelReady ? 'Model not downloaded' : `Ready · ${s.ramGB} GB RAM`;

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
      <button id="pullBtn" class="btn primary">Download model</button><div class="progress" hidden><div></div></div><div id="pullText" class="pull-text"></div>`);
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

function typeOf(name) {
  const ext = name.split('.').pop().toLowerCase();
  if (ext === 'pdf') return { label: 'PDF', cls: 't-pdf' };
  if (ext === 'docx') return { label: 'DOC', cls: 't-doc' };
  if (ext === 'pptx') return { label: 'PPT', cls: 't-ppt' };
  if (['csv', 'tsv', 'json', 'jsonl'].includes(ext)) return { label: ext.toUpperCase().slice(0, 4), cls: 't-data' };
  if (['md', 'markdown', 'mdx', 'txt'].includes(ext)) return { label: ext === 'txt' ? 'TXT' : 'MD', cls: 't-text' };
  return { label: '</>', cls: 't-code' };
}

async function refreshFiles() {
  try {
    files = await api('/api/files');
  } catch {
    return;
  }
  const count = $('fileCount');
  count.textContent = files.length;
  count.hidden = !files.length;
  const list = $('fileList');
  list.innerHTML = '';
  if (!files.length) list.append(el('li', 'list-empty', 'No files yet. Without files it works as a private chat.'));
  for (const f of files) {
    const t = typeOf(f.name);
    const li = el('li', '', `<span class="ftype ${t.cls}">${t.label}</span><div class="finfo"><div class="name"></div><div class="size"></div></div>`);
    li.querySelector('.name').textContent = f.name;
    li.querySelector('.name').title = f.name;
    const pages = Math.max(1, Math.round(f.chars / 3000));
    li.querySelector('.size').textContent = `~${pages} ${pages === 1 ? 'page' : 'pages'} · ${f.chars >= 1000 ? `${(f.chars / 1000).toFixed(1)}k` : f.chars} characters`;
    li.append(actionButton('trash', `Remove ${f.name}`, async () => {
      await fetch(`/api/files/${encodeURIComponent(f.name)}`, { method: 'DELETE' });
      refreshFiles();
    }));
    list.append(li);
  }
  updateEmpty();
  updateSend();
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
    $('uploadText').textContent = `Adding ${i + 1} of ${entries.length}: ${name}`;
    $('uploadBar').style.width = `${Math.round((i / entries.length) * 100)}%`;
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

$('fileInput').onchange = (e) => {
  addFiles([...e.target.files].map((file) => ({ file })));
  e.target.value = '';
};
$('attach').onclick = () => $('fileInput').click();

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
document.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
document.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
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

// ---------- sidebar ----------

function showTab(name) {
  for (const t of ['Chats', 'Files']) {
    $(`tab${t}`).setAttribute('aria-selected', String(t === name));
    $(`panel${t}`).hidden = t !== name;
  }
  store('tab', name);
}
$('tabChats').onclick = () => showTab('Chats');
$('tabFiles').onclick = () => showTab('Files');

const mobile = matchMedia('(max-width: 760px)');
function closeSidebarOnMobile() {
  document.body.classList.remove('sidebar-open');
}
$('openSidebar').onclick = () => {
  if (mobile.matches) document.body.classList.add('sidebar-open');
  else {
    document.body.classList.remove('sidebar-collapsed');
    store('collapsed', null);
  }
};
$('collapseSidebar').onclick = () => {
  if (mobile.matches) return closeSidebarOnMobile();
  document.body.classList.add('sidebar-collapsed');
  store('collapsed', '1');
};
$('newChat').onclick = newChat;
$('newChatMini').onclick = newChat;
document.querySelector('.chat').addEventListener('click', (e) => {
  if (document.body.classList.contains('sidebar-open') && !e.target.closest('#openSidebar')) closeSidebarOnMobile();
});

// ---------- chat ----------

function updateSend() {
  sendBtn.disabled = !ready || busy || !input.value.trim();
  sendBtn.hidden = busy;
  stopBtn.hidden = !busy;
  input.placeholder = ready ? (files.length ? 'Ask about your files…' : 'Ask anything, or add files first…') : 'Finish the setup above to start chatting';
}

// Sends a question. `truncate` first cuts the chat to that many messages (edit and regenerate).
async function ask(question, truncate) {
  busy = true;
  updateSend();
  if (truncate !== undefined) {
    chat.messages = chat.messages.slice(0, truncate);
    renderChat();
  }
  const userMsg = { role: 'user', content: question };
  chat.messages.push(userMsg);
  updateEmpty();
  addMessage(userMsg);
  const msg = { role: 'assistant', content: '', thinking: '', sources: files.length ? undefined : [] };
  const node = el('div', 'msg assistant');
  node.append(el('div', 'body'));
  msgOf.set(node, msg);
  messagesEl.append(node);
  renderAssistant(node, msg, true);
  scrollDown(true);

  const ctrl = (controller = new AbortController());
  const started = chat;
  let finished = false;
  let res;
  try {
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: chat.id || undefined, message: question, truncate }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Server error ${res.status}`);
    let frame = 0;
    for await (const ev of readNdjson(res)) {
      if (ev.type === 'chat' && !started.id) {
        started.id = ev.id;
        history.replaceState(null, '', `#/c/${ev.id}`);
        chats.unshift({ id: ev.id, title: 'New chat', updated: Date.now(), count: 0 });
        renderChatList();
      }
      if (ev.type === 'sources') {
        msg.sources = ev.sources;
        renderAssistant(node, msg, true);
      }
      if (ev.type === 'thinking' || ev.type === 'token') {
        if (ev.type === 'thinking') msg.thinking += ev.token;
        else msg.content += ev.token;
        // Re-render at most once per animation frame so long answers stay smooth.
        if (!frame) frame = requestAnimationFrame(() => { frame = 0; renderAssistant(node, msg, true); scrollDown(); });
      }
      if (ev.type === 'done') {
        cancelAnimationFrame(frame);
        msg.stats = { model: ev.model, tokensPerSec: ev.tokensPerSec };
        finish();
      }
      if (ev.type === 'error') throw new Error(ev.error);
      if (ev.type === 'title') {
        const c = chats.find((x) => x.id === ev.id);
        if (c) c.title = ev.title;
        if (chat.id === ev.id) {
          chat.title = ev.title;
          $('chatTitle').textContent = ev.title;
          document.title = `${ev.title} · {{APP_NAME}}`;
        }
        renderChatList();
      }
    }
    cancelAnimationFrame(frame);
  } catch (err) {
    if (err.name === 'AbortError') msg.stopped = true;
    else msg.error = `Something went wrong: ${err.message}`;
  }
  finish();

  // Runs once, at 'done' (the stream stays open a moment longer for the chat's title) or at the end.
  function finish() {
    if (finished) return;
    finished = true;
    if (started !== chat) return; // switched chats mid-answer
    chat.messages.push(msg);
    renderAssistant(node, msg);
    // The answer before this one loses its Regenerate button.
    const prev = [...messagesEl.querySelectorAll('.msg.assistant')].at(-2);
    if (prev) renderAssistant(prev, msgOf.get(prev));
    const c = chats.find((x) => x.id === chat.id);
    if (c) {
      c.updated = Date.now();
      chats = [c, ...chats.filter((x) => x !== c)];
      renderChatList();
    }
    scrollDown();
    busy = false;
    controller = null;
    updateSend();
    input.focus();
  }
  if (started !== chat && controller === ctrl) {
    busy = false;
    controller = null;
    updateSend();
  }
}

function regenerate(msg) {
  if (busy || !ready) return;
  const i = chat.messages.indexOf(msg);
  const userIndex = chat.messages.slice(0, i).findLastIndex((m) => m.role === 'user');
  if (userIndex < 0) return;
  ask(chat.messages[userIndex].content, userIndex);
}

function editQuestion(node, msg) {
  if (busy) return;
  const i = chat.messages.indexOf(msg);
  const box = el('div', 'edit-box', '<textarea rows="1"></textarea><div class="edit-actions"><button type="button" class="btn">Cancel</button><button type="button" class="btn primary">Send</button></div>');
  const area = box.querySelector('textarea');
  area.value = msg.content;
  node.replaceChildren(box);
  const fit = () => { area.style.height = 'auto'; area.style.height = `${area.scrollHeight}px`; };
  fit();
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
  area.oninput = fit;
  const cancel = () => renderUser(node, msg);
  const save = () => {
    const q = area.value.trim();
    if (!q || !ready) return;
    ask(q, i);
  };
  box.querySelector('.btn').onclick = cancel;
  box.querySelector('.primary').onclick = save;
  area.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); save(); }
    if (e.key === 'Escape') cancel();
  };
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
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
  updateSend();
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && busy) controller?.abort();
  else if (e.key === 'Escape') closeSidebarOnMobile();
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); newChat(); }
  if (e.key === '/' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName) && !document.activeElement.isContentEditable) { e.preventDefault(); input.focus(); }
});

// ---------- start ----------

if (store('collapsed')) document.body.classList.add('sidebar-collapsed');
if (store('tab') === 'Files') showTab('Files');
renderChat();
checkStatus();
setInterval(checkStatus, 5000);
refreshFiles();
importLegacyChat().then(loadChats).then(route);
input.focus();
