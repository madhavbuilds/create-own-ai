const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FileIndex, chunkText } = require('../templates/chat-files/lib/search');

test('chunks long text with overlap and no empty chunks', () => {
  const text = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
  const chunks = chunkText(text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length > 0 && c.length <= 900));
});

test('finds the relevant document and persists the index', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-idx-'));
  const idx = new FileIndex(dir);
  idx.add('lease.md', 'The apartment lease ends on 31 March. Rent is 950 euros per month, due on the 1st.');
  idx.add('recipe.txt', 'Mix flour, sugar and eggs. Bake the cake for 40 minutes at 180 degrees.');

  const hits = idx.search('when is rent due for the apartment?');
  assert.equal(hits[0].doc, 'lease.md');

  idx.flush();
  const reloaded = new FileIndex(dir);
  assert.equal(reloaded.list().length, 2);
  reloaded.remove('recipe.txt');
  reloaded.flush();
  assert.deepEqual(new FileIndex(dir).list().map((f) => f.name), ['lease.md']);
});

test('gives an overview of recent files for broad questions', () => {
  const idx = new FileIndex(fs.mkdtempSync(path.join(os.tmpdir(), 'cla-idx-')));
  idx.add('a.md', 'Alpha notes.');
  idx.add('b.md', 'Beta notes.');
  assert.deepEqual(idx.search('summarize everything'), []);
  assert.deepEqual(idx.overview().map((s) => s.doc).sort(), ['a.md', 'b.md']);
  idx.add('long.md', Array.from({ length: 100 }, (_, i) => `Paragraph ${i} of a long file.`).join('\n\n'));
  const mix = idx.overview(5).map((s) => s.doc);
  assert.equal(mix.length, 5);
  assert.ok(mix.includes('a.md') && mix.includes('b.md'), 'short files still get a turn');
});

test('survives a corrupt index file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-idx-'));
  fs.writeFileSync(path.join(dir, 'index.json'), '{not json');
  assert.deepEqual(new FileIndex(dir).list(), []);
});

test('returns nothing for an empty index', () => {
  const idx = new FileIndex(fs.mkdtempSync(path.join(os.tmpdir(), 'cla-idx-')));
  assert.deepEqual(idx.search('anything'), []);
});
