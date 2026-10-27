// Local keyword search over your files (BM25). No embedding model to download,
// and the index is a plain JSON file in ./data you can inspect or delete.

const fs = require('node:fs');
const path = require('node:path');

const CHUNK_SIZE = 900;
const CHUNK_OVERLAP = 150;
const VERSION = 2; // bump when tokenize() changes, so old indexes get re-tokenized on load

const STOPWORDS = new Set(
  'a an and are as at be but by can do does for from has have how i if in into is it its me my of on or that the their there this to was what when where which who why will with you your'.split(' ')
);

// Rough English stemming so "payments" finds "payment" and "renewed" finds "renew".
function stem(t) {
  if (t.length > 5 && t.endsWith('ing')) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith('ies')) return `${t.slice(0, -3)}y`;
  if (t.length > 4 && t.endsWith('ed')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

function tokenize(text) {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

// Split on paragraph boundaries where possible so chunks read naturally.
function chunkText(text) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK_SIZE, text.length);
    if (end < text.length) {
      const para = text.lastIndexOf('\n\n', end);
      const sentence = text.lastIndexOf('. ', end);
      const cut = para > start + CHUNK_SIZE / 2 ? para : sentence > start + CHUNK_SIZE / 2 ? sentence + 1 : end;
      end = cut;
    }
    const piece = text.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= text.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return chunks;
}

function counts(tokens) {
  const m = new Map();
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

// Words in a file name that say what it's about ("car-insurance-2026.pdf" -> car, insurance).
const GENERIC_NAME_WORDS = new Set(['file', 'doc', 'document', 'final', 'copy', 'draft', 'new', 'old', 'sample', 'scan', 'untitled', 'v1', 'v2', 'v3']);
function nameWords(name) {
  const base = name.split('/').pop().replace(/\.[^.]+$/, '');
  return [...new Set(tokenize(base))].filter((t) => t.length > 2 && !/^\d+$/.test(t) && !GENERIC_NAME_WORDS.has(t));
}

class FileIndex {
  constructor(dir) {
    this.file = path.join(dir, 'index.json');
    fs.mkdirSync(dir, { recursive: true });
    this.docs = {};
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.version === VERSION) this.docs = saved.docs;
      else {
        // An index from an older version: keep the files, redo the search terms.
        this.docs = saved.docs || saved;
        for (const doc of Object.values(this.docs)) for (const ch of doc.chunks) ch.tokens = tokenize(ch.text);
      }
    } catch {
      // missing or unreadable index: start fresh
    }
    this.timer = null;
    process.on('exit', () => this.flush());
  }

  // Writes are batched so dropping a folder of 1,000 files doesn't rewrite the index 1,000 times.
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
    this.timer.unref();
  }

  flush() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, docs: this.docs }));
    fs.renameSync(tmp, this.file); // atomic, so a crash never leaves half a file
  }

  add(name, text) {
    const chunks = chunkText(text).map((t) => ({ text: t, tokens: tokenize(t) }));
    this.docs[name] = { name, chars: text.length, added: Date.now(), chunks };
    this.save();
    return { name, chunks: chunks.length };
  }

  remove(name) {
    delete this.docs[name];
    this.save();
  }

  has(name) {
    return name in this.docs;
  }

  list() {
    return Object.values(this.docs)
      .map(({ name, chars, added, chunks }) => ({ name, chars, added, chunks: chunks.length }))
      .sort((a, b) => b.added - a.added);
  }

  // Files the question mentions by name: "what does the car insurance cover?" -> car-insurance.md
  namedIn(question) {
    const words = new Set(tokenize(question));
    const lower = question.toLowerCase();
    return Object.keys(this.docs).filter((name) => {
      if (lower.includes(name.split('/').pop().toLowerCase())) return true;
      const w = nameWords(name);
      return w.length > 0 && w.filter((t) => words.has(t)).length * 2 >= w.length;
    });
  }

  // For broad questions that match no keywords: the start of each file, taking turns between
  // files so one long file doesn't crowd out the rest. `only` limits it to some files.
  overview(k = 5, only = null) {
    const docs = this.list()
      .filter((f) => !only || only.includes(f.name))
      .slice(0, k)
      .map((f) => this.docs[f.name]);
    const out = [];
    for (let i = 0; out.length < k && docs.some((d) => d.chunks[i]); i++) {
      for (const d of docs) if (d.chunks[i] && out.length < k) out.push({ doc: d.name, i, text: d.chunks[i].text, score: 0 });
    }
    return out;
  }

  search(query, k = 5, only = null) {
    const all = [];
    for (const doc of Object.values(this.docs)) {
      if (only && !only.includes(doc.name)) continue;
      doc.chunks.forEach((ch, i) => {
        // Term counts are built once per chunk and kept in memory (not saved to disk).
        if (!ch.tf) Object.defineProperty(ch, 'tf', { value: counts(ch.tokens) });
        all.push({ doc: doc.name, i, text: ch.text, tokens: ch.tokens, tf: ch.tf });
      });
    }
    if (!all.length) return [];

    const q = [...new Set(tokenize(query))];
    const avgLen = all.reduce((s, c) => s + c.tokens.length, 0) / all.length;
    const df = Object.fromEntries(q.map((t) => [t, all.filter((c) => c.tf.has(t)).length]));
    const k1 = 1.4;
    const b = 0.75;

    return all
      .map((c) => {
        let score = 0;
        for (const t of q) {
          const tf = c.tf.get(t) || 0;
          if (!tf) continue;
          const idf = Math.log(1 + (all.length - df[t] + 0.5) / (df[t] + 0.5));
          score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * c.tokens.length) / avgLen)));
        }
        return { doc: c.doc, i: c.i, text: c.text, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}

module.exports = { FileIndex, chunkText, tokenize };
