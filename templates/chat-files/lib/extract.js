// Pulls plain text out of PDF, DOCX and PPTX files with nothing but Node's zlib.
// It covers the files most apps produce (Word, Google Docs, Chrome, LaTeX, Keynote...).
// Scanned PDFs have no text layer, so they come back empty and the UI says so.

const zlib = require('node:zlib');

const BINARY_TYPES = ['pdf', 'docx', 'pptx'];

function extractText(name, buf) {
  const ext = name.toLowerCase().split('.').pop();
  const readers = { pdf: pdfText, docx: docxText, pptx: pptxText };
  if (!readers[ext]) throw Object.assign(new Error(`Can't read .${ext} files yet`), { status: 415 });
  const text = readers[ext](buf);
  if (!/[\p{L}\p{N}]/u.test(text)) {
    const hint = ext === 'pdf' ? ' It may be a scan or an image-only PDF.' : '';
    throw Object.assign(new Error(`No readable text found in ${name}.${hint}`), { status: 422 });
  }
  return text;
}

// ---------- ZIP (DOCX and PPTX are zip files full of XML) ----------

function unzip(buf) {
  // The "end of central directory" record sits in the last 64 KB of the file.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid zip file');

  const files = {};
  let p = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let n = 0; n < count && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + size);
    files[name] = () => (method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function decodeXml(s) {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
    const named = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e.toLowerCase()];
    if (named) return named;
    return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
}

// Keeps text runs, turns paragraphs into newlines, drops all other markup.
function xmlText(xml, textTag, paraTag) {
  return decodeXml(
    xml
      .replace(new RegExp(`</${paraTag}>`, 'g'), '\n')
      .replace(/<w:tab\/>|<a:tab\/>/g, '\t')
      .replace(/<w:br\/>|<a:br\/>/g, '\n')
      .replace(new RegExp(`<${textTag}(?:\\s[^>]*)?>([^<]*)</${textTag}>|<[^>]+>`, 'g'), (_, t) => t || '')
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function docxText(buf) {
  const files = unzip(buf);
  if (!files['word/document.xml']) throw new Error('This .docx has no document body');
  return xmlText(files['word/document.xml'](), 'w:t', 'w:p');
}

function pptxText(buf) {
  const files = unzip(buf);
  const slides = Object.keys(files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
  return slides.map((f, i) => `Slide ${i + 1}\n${xmlText(files[f](), 'a:t', 'a:p')}`).join('\n\n');
}

// ---------- PDF ----------

function inflate(data) {
  try {
    return zlib.inflateSync(data);
  } catch {
    // Some writers leave junk after the stream; take what decodes.
    return zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  }
}

// Reads every "N 0 obj ... endobj" into { dict, stream }, including objects packed in object streams.
function readObjects(src, buf) {
  const objects = {};
  const re = /(\d+)\s+\d+\s+obj\b/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    const end = src.indexOf('endobj', start);
    if (end < 0) break;
    let body = src.slice(start, end);
    let stream = null;
    const s = body.search(/\bstream\r?\n/);
    if (s >= 0) {
      const dataStart = start + s + body.slice(s).match(/^stream\r?\n/)[0].length;
      // Trust /Length when it lands on "endstream", otherwise search for it.
      const len = Number(body.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/)?.[1]);
      const byLength = len && /^\s*endstream/.test(src.slice(dataStart + len, dataStart + len + 12));
      const dataEnd = byLength ? dataStart + len : src.indexOf('endstream', dataStart);
      stream = buf.subarray(dataStart, byLength ? dataEnd : dataEnd - (src[dataEnd - 2] === '\r' ? 2 : 1));
      body = body.slice(0, s);
    }
    objects[m[1]] = { dict: body, stream };
    re.lastIndex = end;
  }

  for (const obj of Object.values(objects)) {
    if (!/\/Type\s*\/ObjStm/.test(obj.dict)) continue;
    const data = decodeStream(obj);
    if (!data) continue;
    const text = data.toString('latin1');
    const first = Number(obj.dict.match(/\/First\s+(\d+)/)?.[1]);
    const nums = text.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < nums.length; i += 2) {
      const from = first + nums[i + 1];
      const to = i + 3 < nums.length ? first + nums[i + 3] : text.length;
      if (!objects[nums[i]]) objects[nums[i]] = { dict: text.slice(from, to), stream: null };
    }
  }
  return objects;
}

function ascii85(buf) {
  const s = buf.toString('latin1').replace(/^<~|\s/g, '').replace(/~>.*$/, '');
  const out = [];
  for (let i = 0; i < s.length; ) {
    if (s[i] === 'z') { out.push(0, 0, 0, 0); i++; continue; }
    const group = s.slice(i, i + 5);
    i += 5;
    let n = 0;
    for (let k = 0; k < 5; k++) n = n * 85 + ((group.charCodeAt(k) || 117) - 33);
    const bytes = [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    out.push(...bytes.slice(0, group.length - 1));
  }
  return Buffer.from(out);
}

function lzw(buf) {
  const out = [];
  let dict = [];
  let width = 9;
  let prev = null;
  let bits = 0;
  let acc = 0;
  const reset = () => { dict = Array.from({ length: 258 }, (_, i) => [i]); width = 9; prev = null; };
  reset();
  for (const byte of buf) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= width) {
      const code = (acc >>> (bits - width)) & ((1 << width) - 1);
      bits -= width;
      if (code === 256) { reset(); continue; }
      if (code === 257) return Buffer.from(out);
      const entry = dict[code] || (prev && [...prev, prev[0]]);
      if (!entry) return Buffer.from(out);
      out.push(...entry);
      if (prev) dict.push([...prev, entry[0]]);
      prev = entry;
      if (dict.length + 1 >= 1 << width && width < 12) width++;
    }
  }
  return Buffer.from(out);
}

const FILTERS = {
  FlateDecode: inflate,
  Fl: inflate,
  ASCII85Decode: ascii85,
  A85: ascii85,
  ASCIIHexDecode: (b) => Buffer.from(b.toString('latin1').replace(/[^0-9a-f]/gi, ''), 'hex'),
  AHx: (b) => Buffer.from(b.toString('latin1').replace(/[^0-9a-f]/gi, ''), 'hex'),
  LZWDecode: lzw,
  LZW: lzw,
};

function decodeStream(obj) {
  if (!obj?.stream) return null;
  const filters = obj.dict.match(/\/Filter\s*(\[[^\]]*\]|\/\w+)/)?.[1].match(/\w+/g) || [];
  let data = obj.stream;
  try {
    for (const f of filters) {
      if (!FILTERS[f]) return null; // images (DCT, JBIG2...) hold no text anyway
      data = FILTERS[f](data);
    }
  } catch {
    return null;
  }
  return data;
}

// Value of /Key in a dict: an "N 0 R" reference is followed, << >> and [ ] are returned as text.
function dictValue(dict, key, objects) {
  const i = dict.search(new RegExp(`/${key}(?![A-Za-z])`));
  if (i < 0) return null;
  const rest = dict.slice(i + key.length + 1).trimStart();
  const ref = rest.match(/^(\d+)\s+\d+\s+R/);
  if (ref) return objects[ref[1]]?.dict ?? null;
  for (const [open, close] of [['<<', '>>'], ['[', ']']]) {
    if (!rest.startsWith(open)) continue;
    let depth = 0;
    for (let j = 0; j < rest.length; j++) {
      if (rest.startsWith(open, j)) { depth++; j += open.length - 1; }
      else if (rest.startsWith(close, j)) { depth--; j += close.length - 1; if (!depth) return rest.slice(0, j + 1); }
    }
  }
  return rest.match(/^[^/\s>\]]+|^\/\w+/)?.[0] ?? null;
}

const refs = (s) => [...(s || '').matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => m[1]);

// ToUnicode CMaps map glyph codes back to characters.
function parseCMap(text) {
  const map = new Map();
  let bytes = 1;
  const hexStr = (h) => {
    let out = '';
    for (let i = 0; i + 4 <= h.length; i += 4) out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    return h.length === 2 ? String.fromCharCode(parseInt(h, 16)) : out;
  };
  const range = text.match(/begincodespacerange\s*<([0-9a-f]+)>/i);
  if (range) bytes = range[1].length / 2;
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, from, to] of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]*)>/gi)) map.set(parseInt(from, 16), hexStr(to));
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, lo, hi, dst] of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*(<[0-9a-f]*>|\[[^\]]*\])/gi)) {
      const a = parseInt(lo, 16);
      const b = parseInt(hi, 16);
      if (dst.startsWith('[')) {
        [...dst.matchAll(/<([0-9a-f]*)>/gi)].forEach(([, h], k) => map.set(a + k, hexStr(h)));
      } else {
        const base = hexStr(dst.slice(1, -1));
        for (let c = a; c <= b && c - a < 65536; c++) {
          map.set(c, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (c - a)));
        }
      }
    }
  }
  return { map, bytes };
}

// Fonts and form XObjects (reusable chunks of page content) available to a page or form.
function resourcesFor(owner, objects, cache, parent = { fonts: {}, xobjects: {} }) {
  const resources = dictValue(owner, 'Resources', objects) || '';
  const fonts = { ...parent.fonts, ...fontsIn(resources, objects, cache) };
  const xobjects = { ...parent.xobjects };
  const xDict = dictValue(resources, 'XObject', objects) || '';
  for (const [, name, num] of xDict.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
    if (/\/Subtype\s*\/Form/.test(objects[num]?.dict || '')) xobjects[name] = num;
  }
  return { fonts, xobjects };
}

function fontsIn(resources, objects, cache) {
  const fonts = {};
  const fontDict = dictValue(resources, 'Font', objects) || '';
  for (const [, name, num] of fontDict.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
    if (!cache[num]) {
      const font = objects[num]?.dict || '';
      const cmapRef = font.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/)?.[1];
      const cmapData = cmapRef && decodeStream(objects[cmapRef]);
      const cmap = cmapData ? parseCMap(cmapData.toString('latin1')) : null;
      const twoByte = /\/Subtype\s*\/Type0/.test(font);
      cache[num] = { cmap, bytes: cmap ? cmap.bytes : twoByte ? 2 : 1 };
    }
    fonts[name] = cache[num];
  }
  return fonts;
}

function decodePdfString(bytes, font) {
  if (font?.cmap) {
    let out = '';
    for (let i = 0; i + font.bytes <= bytes.length; i += font.bytes) {
      const code = font.bytes === 2 ? (bytes[i] << 8) | bytes[i + 1] : bytes[i];
      out += font.cmap.map.get(code) ?? '';
    }
    return out;
  }
  if (font?.bytes === 2) return ''; // glyph IDs with no map: can't be turned into text
  return Buffer.from(bytes).toString('latin1');
}

// Walks a content stream and collects text, adding spaces and line breaks from positioning operators.
function contentText(data, res, objects, cache, depth = 0) {
  const { fonts, xobjects } = res;
  const s = data.toString('latin1');
  let out = '';
  let font = null;
  let fontSize = 12;
  let scale = 1; // from the text matrix; size = fontSize * scale in page units
  let size = 12;
  let lineX = 0; // x where the current line started
  let x = 0; // estimated x of the end of the last shown text
  let y = null;
  const stack = [];
  const newline = () => { if (out && !out.endsWith('\n')) out += '\n'; };
  const space = () => { if (out && !/\s$/.test(out)) out += ' '; };
  const show = (v) => {
    const t = decodePdfString(v, font);
    out += t;
    x += t.length * size * 0.5; // rough glyph advance; only used to spot word gaps
  };
  // Moving to a new spot on the same line: add a space only if it jumps past the text so far.
  const moveTo = (nx, ny) => {
    if (y !== null && Math.abs(ny - y) > size * 0.3) newline();
    else if (y !== null && nx > x + size * 0.25) space();
    lineX = nx;
    x = nx;
    y = ny;
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '%') { while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
    if (ch === '(') {
      const bytes = [];
      let depth = 1;
      i++;
      while (i < s.length && depth) {
        let c = s[i++];
        if (c === '\\') {
          const n = s[i++];
          const esc = { n: 10, r: 13, t: 9, b: 8, f: 12 }[n];
          if (esc !== undefined) bytes.push(esc);
          else if (/[0-7]/.test(n)) {
            let oct = n;
            while (oct.length < 3 && /[0-7]/.test(s[i])) oct += s[i++];
            bytes.push(parseInt(oct, 8) & 255);
          } else if (n !== '\n' && n !== '\r') bytes.push(n.charCodeAt(0));
          continue;
        }
        if (c === '(') depth++;
        if (c === ')' && !--depth) break;
        bytes.push(c.charCodeAt(0));
      }
      stack.push(bytes);
      continue;
    }
    if (ch === '<' && s[i + 1] !== '<') {
      const end = s.indexOf('>', i);
      const hex = s.slice(i + 1, end).replace(/\s/g, '');
      const bytes = [];
      for (let k = 0; k < hex.length; k += 2) bytes.push(parseInt(hex.slice(k, k + 2).padEnd(2, '0'), 16));
      stack.push(bytes);
      i = end + 1;
      continue;
    }
    if (ch === '[') { stack.push('['); i++; continue; }
    if (ch === ']') {
      const arr = [];
      while (stack.length && stack[stack.length - 1] !== '[') arr.unshift(stack.pop());
      stack.pop();
      stack.push({ array: arr });
      i++;
      continue;
    }
    if (ch === '<' || ch === '>') { i += 2; continue; } // inline dicts (<< >>) carry no text
    const tok = s.slice(i).match(/^[^\s()<>[\]{}/%]+|^\/[^\s()<>[\]{}/%]*/)[0];
    i += tok.length || 1;
    if (tok[0] === '/' || /^[-+.\d]/.test(tok)) { stack.push(tok); continue; }

    switch (tok) {
      case 'BT': lineX = 0; x = 0; break;
      case 'Tf': {
        font = fonts[String(stack[stack.length - 2]).slice(1)] || null;
        fontSize = Math.abs(Number(stack[stack.length - 1])) || fontSize;
        size = fontSize * scale;
        break;
      }
      case 'Tj': show(stack[stack.length - 1] || []); break;
      case "'": case '"': newline(); show(stack[stack.length - 1] || []); break;
      case 'TJ':
        for (const part of stack[stack.length - 1]?.array || []) {
          if (Array.isArray(part)) show(part);
          else if (Number(part) < -200) { space(); x -= (Number(part) / 1000) * size; } // big negative kern = word gap
        }
        break;
      case 'Td': case 'TD': {
        const ty = Number(stack[stack.length - 1]);
        moveTo(lineX + Number(stack[stack.length - 2]) * scale, (y ?? 0) + ty * scale);
        break;
      }
      case 'Tm': {
        const [a, b, , , e, f] = stack.slice(-6).map(Number);
        scale = Math.hypot(a, b) || 1;
        size = fontSize * scale;
        moveTo(e, f);
        break;
      }
      case 'T*': newline(); x = lineX; break;
      case 'ET': break;
      case 'Do': {
        const num = xobjects[String(stack[stack.length - 1]).slice(1)];
        const form = num && depth < 8 && decodeStream(objects[num]);
        if (form) {
          newline();
          out += contentText(form, resourcesFor(objects[num].dict, objects, cache, res), objects, cache, depth + 1);
          newline();
        }
        break;
      }
      case 'BI': { const e = s.indexOf('EI', i); i = e < 0 ? s.length : e + 2; break; } // skip inline images
    }
    stack.length = 0;
  }
  return out;
}

function pdfText(buf) {
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('Not a PDF file');
  const src = buf.toString('latin1');
  if (/\/Encrypt\s/.test(src)) throw new Error('This PDF is password-protected');
  const objects = readObjects(src, buf);

  // Pages in reading order: walk the page tree from the catalog.
  const pages = [];
  const seen = new Set();
  // Pages can inherit /Resources from their parent node.
  const walk = (num, inherited = '') => {
    if (seen.has(num) || !objects[num]) return;
    seen.add(num);
    let d = objects[num].dict;
    if (!/\/Resources\b/.test(d) && inherited) d += ` /Resources ${inherited}`;
    const own = d.match(/\/Resources\s*(\d+\s+\d+\s+R)/)?.[1] || dictValue(d, 'Resources', {}) || inherited;
    if (/\/Type\s*\/Pages\b/.test(d)) refs(dictValue(d, 'Kids', {})).forEach((k) => walk(k, own));
    else if (/\/Type\s*\/Page\b/.test(d)) pages.push(d);
  };
  const root = src.match(/\/Root\s+(\d+)\s+\d+\s+R/)?.[1]
    || Object.keys(objects).find((k) => /\/Type\s*\/Catalog/.test(objects[k].dict));
  const pagesRef = root && objects[root]?.dict.match(/\/Pages\s+(\d+)\s+\d+\s+R/)?.[1];
  if (pagesRef) walk(pagesRef);
  if (!pages.length) {
    for (const o of Object.values(objects)) if (/\/Type\s*\/Page\b/.test(o.dict)) pages.push(o.dict);
  }

  const fontCache = {};
  const text = pages.map((page) => {
    const res = resourcesFor(page, objects, fontCache);
    const contents = page.match(/\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/)?.[1];
    const data = refs(contents).map((n) => decodeStream(objects[n])).filter(Boolean);
    return contentText(Buffer.concat(data.flatMap((d) => [d, Buffer.from('\n')])), res, objects, fontCache);
  });
  return text
    .map((t) => t.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

module.exports = { extractText, BINARY_TYPES, pdfText, docxText, pptxText };
