const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { extractText } = require('../templates/chat-files/lib/extract');

const fixture = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f));

// Builds a minimal zip (stored + deflated entries), enough to fake a .pptx.
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = zlib.deflateRawSync(Buffer.from(text));
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(text.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(text.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function ascii85(buf) {
  let out = '';
  for (let i = 0; i < buf.length; i += 4) {
    const chunk = Buffer.concat([buf.subarray(i, i + 4), Buffer.alloc(4)]).subarray(0, 4);
    let n = chunk.readUInt32BE(0);
    const digits = [];
    for (let k = 0; k < 5; k++) { digits.unshift(String.fromCharCode((n % 85) + 33)); n = Math.floor(n / 85); }
    out += digits.join('').slice(0, Math.min(4, buf.length - i) + 1);
  }
  return `${out}~>`;
}

test('reads a PDF printed by Chrome (Type0 fonts with ToUnicode maps)', () => {
  const text = extractText('report.pdf', fixture('report.pdf'));
  assert.match(text, /Quarterly Report/);
  assert.match(text, /Revenue grew by 18 percent to 4\.2 million euros\./);
  assert.match(text, /warehouse in Lyon opens on 12 May\. Café owners/);
});

test('reads a hand-made PDF with ASCII85 + Flate filters and an object stream', () => {
  const content = zlib.deflateSync(Buffer.from('BT /F1 12 Tf 72 700 Td (Hello from page one.) Tj 0 -14 Td [(Second) -300 (line)] TJ ET'));
  // Objects 3 (the page) and 5 (its font) live inside a compressed object stream.
  const page = '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>';
  const font = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  const objStmBody = `3 0 5 ${page.length + 1} `;
  const objStm = zlib.deflateSync(Buffer.from(`${objStmBody}${page} ${font}`));
  const parts = [
    '%PDF-1.5\n',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n',
    `7 0 obj << /Type /ObjStm /N 2 /First ${objStmBody.length} /Filter /FlateDecode /Length ${objStm.length} >> stream\n`,
    objStm,
    '\nendstream endobj\n',
  ];
  const a85 = ascii85(content);
  parts.push(`6 0 obj << /Filter [/ASCII85Decode /FlateDecode] /Length ${a85.length} >> stream\n${a85}\nendstream endobj\n`);
  parts.push('trailer << /Root 1 0 R >>\n%%EOF');
  const pdf = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, 'latin1'))));
  assert.equal(extractText('made.pdf', pdf), 'Hello from page one.\nSecond line');
});

test('reads a .docx made by TextEdit', () => {
  assert.equal(
    extractText('report.docx', fixture('report.docx')),
    'Quarterly Report\nRevenue grew by 18 percent to 4.2 million euros.\nThe new warehouse in Lyon opens on 12 May. Café owners loved the pilot.'
  );
});

test('reads .pptx slides in order', () => {
  const slide = (t) => `<p:sld><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sld>`;
  const pptx = zip({
    'ppt/slides/slide10.xml': slide('Ten'),
    'ppt/slides/slide2.xml': slide('Two &amp; more'),
    'ppt/slides/slide1.xml': slide('One'),
  });
  assert.equal(extractText('deck.pptx', pptx), 'Slide 1\nOne\n\nSlide 2\nTwo & more\n\nSlide 3\nTen');
});

test('explains files it cannot read', () => {
  assert.throws(() => extractText('x.pdf', Buffer.from('not a pdf')), /Not a PDF/);
  assert.throws(() => extractText('x.docx', Buffer.from('nope')), /zip/);
  assert.throws(() => extractText('x.pdf', Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj')), /No readable text.*scan/);
  assert.throws(() => extractText('x.xlsx', Buffer.alloc(10)), /Can't read \.xlsx/);
});
