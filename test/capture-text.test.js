'use strict';

// Capture intake is text-only by design: Plaud exports transcripts, and
// reMarkable notes arrive as text after the app converts the handwriting.
// There is no OCR path, so PDFs/images must fail loudly with instructions.

const test = require('node:test');
const assert = require('node:assert');

const {
  sniffBinary,
  plaudText,
  isBinaryNoise,
  uploadTextProblem,
  contentTextProblem,
  webhookTextProblem,
} = require('../src/lib/captureText');

const PDF = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n1 0 obj\n<<>>\nendobj\n');
const DOCX = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('capture text: binary signatures are identified by content, not extension', () => {
  assert.strictEqual(sniffBinary(PDF), 'PDF');
  assert.strictEqual(sniffBinary(DOCX), 'ZIP-based document (Word/Excel/PowerPoint)');
  assert.strictEqual(sniffBinary(PNG), 'PNG image');
  assert.strictEqual(sniffBinary(Buffer.from('CUST42 wants 500 bottles')), null);
});

test('capture text: a PDF upload is refused with the reMarkable conversion path', () => {
  const r = uploadTextProblem(PDF, 'note.pdf');
  assert.strictEqual(r.status, 415);
  assert.match(r.error, /text-only/i);
  assert.match(r.error, /no OCR/i);
  assert.match(r.error, /Convert to text/i);
});

test('capture text: images and Office files are refused, not decoded', () => {
  assert.strictEqual(uploadTextProblem(PNG, 'page1.png').status, 415);
  assert.match(uploadTextProblem(DOCX, 'notes.docx').error, /ZIP-based document/);
});

test('capture text: an unknown extension is refused even if it looks textual', () => {
  const r = uploadTextProblem(Buffer.from('plain words'), 'notes.pdf');
  assert.strictEqual(r.status, 415);
  assert.match(r.error, /Unsupported file type/);
});

test('capture text: a real text export passes', () => {
  assert.strictEqual(uploadTextProblem(Buffer.from('CUST42 wants 500 bottles'), 'CUST42-20261117-AL.txt'), null);
  assert.strictEqual(uploadTextProblem(Buffer.from('# Note\nDylan Blue x 24'), 'note.md'), null);
});

test('capture text: binary noise decoded as UTF-8 is rejected', () => {
  const junk = '\uFFFD\u0000\u0001\uFFFD\uFFFDbinary';
  assert.strictEqual(isBinaryNoise(junk), true);
  assert.strictEqual(contentTextProblem(junk).status, 400);
  assert.strictEqual(contentTextProblem('CUST42 wants 500 bottles of Dylan Blue at $32.50'), null);
});

test('capture text: webhook accepts text but refuses PDF/images and non-strings', () => {
  assert.strictEqual(webhookTextProblem('CUST42 wants 24 Dylan Blue'), null);
  assert.strictEqual(webhookTextProblem('%PDF-1.7\nhandwritten').status, 415);
  assert.strictEqual(webhookTextProblem('data:application/pdf;base64,JVBERi0=').status, 415);
  assert.strictEqual(webhookTextProblem('iVBORw0KGgoAAAANSUhEUg').status, 415);
  assert.strictEqual(webhookTextProblem({ file: 'note.pdf' }).status, 400);
  assert.match(webhookTextProblem('%PDF-1.7').error, /text-only|no OCR/i);
});

test('capture text: plaudText strips SRT cues, flattens JSON and passes plain text', () => {
  const srt = Buffer.from('1\n00:00:01,000 --> 00:00:03,000\nCUST42 needs 24 units\n\n2\n00:00:04,000 --> 00:00:05,000\nDylan Blue\n');
  const parsed = plaudText(srt, 'meeting.srt');
  assert.match(parsed, /CUST42 needs 24 units/);
  assert.doesNotMatch(parsed, /-->/);

  const json = Buffer.from(JSON.stringify({ summary: 'Customer wants 12 units', segments: ['price 32.50', 'barcode 3614220891234'] }));
  const fromJson = plaudText(json, 'meeting.json');
  assert.match(fromJson, /Customer wants 12 units/);
  assert.match(fromJson, /3614220891234/);

  assert.strictEqual(plaudText(Buffer.from('plain note'), 'note.txt'), 'plain note');
});
