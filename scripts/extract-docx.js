'use strict';
// Extract text from a .docx (zip with document.xml) without dependencies.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const src = process.argv[2];
const buf = fs.readFileSync(src);

// Local file header: PK.. signature, filename len at 26, extra len at 28, data at 30
let off = 0;
let xml = null;
while (off < buf.length) {
  const sig = buf.readUInt32LE(off);
  if (sig !== 0x04034b50) break;
  const method = buf.readUInt16LE(off + 8);
  const compSize = buf.readUInt32LE(off + 18);
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const name = buf.toString('utf8', off + 30, off + 30 + nameLen);
  const dataStart = off + 30 + nameLen + extraLen;
  const data = buf.subarray(dataStart, dataStart + compSize);
  if (name === 'word/document.xml') {
    xml = method === 8 ? zlib.inflateRawSync(data) : data;
    break;
  }
  off = dataStart + compSize;
}
if (!xml) { console.error('document.xml not found'); process.exit(1); }

// Paragraphs -> lines, runs -> text, tabs -> \t, breaks -> \n
let t = xml.toString('utf8');
t = t.replace(/<w:tab[^>]*\/>/g, '\t');
t = t.replace(/<w:br[^>]*\/>/g, '\n');
t = t.replace(/<\/w:p>/g, '\n');
t = t.replace(/<w:tab[^>]*>/g, '\t');
t = t.replace(/<w:br[^>]*>/g, '\n');
t = t.replace(/<[^>]+>/g, '');
t = t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
const out = t.split('\n').map((l) => l.replace(/\s+$/,'')).join('\n').replace(/\n{3,}/g, '\n\n');
const dest = process.argv[3] || path.join(__dirname, '..', 'output', 'brief.txt');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, out);
console.log(dest + ' (' + out.length + ' chars, ' + out.split('\n').length + ' lines)');
