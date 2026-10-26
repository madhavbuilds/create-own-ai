// Local keyword search over your files (BM25). No embedding model to download,
// and the index is a plain JSON file in ./data you can inspect or delete.

const fs = require('node:fs');
const path = require('node:path');

const CHUNK_SIZE = 900;
const CHUNK_OVERLAP = 150;

const STOPWORDS = new Set(
  'a an and are as at be but by for from has have how i if in into is it its of on or that the their this to was what when where which who why will with you your'.split(' ')
);

function tokenize(text) {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
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

class FileIndex {
  constructor(dir) {
    this.file = path.join(dir, 'index.json');
    fs.mkdirSync(dir, { recursive: true });
    try {
      this.docs = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.docs = {}; // missing or unreadable index: start fresh
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
    fs.writeFileSync(tmp, JSON.stringify(this.docs));
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

  list() {
    return Object.values(this.docs)
      .map(({ name, chars, added, chunks }) => ({ name, chars, added, chunks: chunks.length }))
      .sort((a, b) => b.added - a.added);
  }

  // For broad questions that match no keywords: chunks from the most recent files, taking
  // turns between files so one long file doesn't crowd out the rest.
  overview(k = 5) {
    const docs = this.list().slice(0, k).map((f) => this.docs[f.name]);
    const out = [];
    for (let i = 0; out.length < k && docs.some((d) => d.chunks[i]); i++) {
      for (const d of docs) if (d.chunks[i] && out.length < k) out.push({ doc: d.name, text: d.chunks[i].text, score: 0 });
    }
    return out;
  }

  search(query, k = 5) {
    const all = [];
    for (const doc of Object.values(this.docs)) {
      for (const ch of doc.chunks) {
        // Term counts are built once per chunk and kept in memory (not saved to disk).
        if (!ch.tf) Object.defineProperty(ch, 'tf', { value: counts(ch.tokens) });
        all.push({ doc: doc.name, ...ch, tf: ch.tf });
      }
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
        return { doc: c.doc, text: c.text, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}

module.exports = { FileIndex, chunkText, tokenize };
