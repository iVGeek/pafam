'use strict';

// Capture intake is text-only.
//
// Plaud exports transcripts/summaries as text, and reMarkable notes reach us
// as text only after the handwriting is converted (reMarkable app "Convert to
// text" / select-and-copy). This platform has **no OCR pipeline**, so a PDF or
// page image must be rejected with instructions rather than stored as binary
// noise in the capture inbox.

const TEXT_UPLOAD_RE = /\.(txt|md|markdown|srt|vtt|json)$/i;
const TEXT_UPLOAD_HINT = '.txt, .md, .srt, .vtt or .json';
const MAX_TEXT = 200000;

// Binary file signatures we can name in the error message. Reading only the
// first bytes is enough and avoids trusting the (client-controlled) extension.
function sniffBinary(buffer) {
  if (!buffer || !buffer.length) return null;
  const head = buffer.subarray(0, 16).toString('latin1');
  if (head.startsWith('%PDF-')) return 'PDF';
  if (head.startsWith('PK\u0003\u0004')) return 'ZIP-based document (Word/Excel/PowerPoint)';
  if (head.startsWith('\x89PNG\r\n\x1a\n')) return 'PNG image';
  if (head.startsWith('\xff\xd8\xff')) return 'JPEG image';
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'GIF image';
  if (head.startsWith('{\\rtf')) return 'RTF document';
  if (head.startsWith('II*\u0000') || head.startsWith('MM\u0000*')) return 'TIFF image';
  return null;
}

// Plaud exports are transcript + summary; SRT/VTT arrive as plain text.
// Extract readable sentences (strip cue/timing lines).
function plaudText(buffer, filename) {
  const raw = buffer.toString('utf8');
  const name = String(filename || '').toLowerCase();
  if (name.endsWith('.json')) {
    try {
      const j = JSON.parse(raw);
      const parts = [];
      const collect = (v) => {
        if (typeof v === 'string') parts.push(v);
        else if (Array.isArray(v)) v.forEach(collect);
        else if (v && typeof v === 'object') Object.values(v).forEach(collect);
      };
      collect(j);
      const text = parts.filter((s) => s.length > 2).join('\n');
      return text.slice(0, MAX_TEXT) || raw.slice(0, MAX_TEXT);
    } catch (_) { return raw.slice(0, MAX_TEXT); }
  }
  if (name.endsWith('.srt') || name.endsWith('.vtt')) {
    return raw.split('\n')
      .filter((l) => l.trim() && !/^\d+$/.test(l.trim()) && !/-->/.test(l) && !l.startsWith('WEBVTT'))
      .join('\n').slice(0, MAX_TEXT);
  }
  return raw.slice(0, MAX_TEXT);
}

// UTF-8 decoding of a binary file leaves NULs and replacement characters.
// Reject that instead of storing a page of noise as a note.
function isBinaryNoise(text) {
  const sample = String(text || '').slice(0, 4000);
  if (!sample) return false;
  let bad = 0;
  for (const ch of sample) {
    const c = ch.codePointAt(0);
    if (c === 0xFFFD || c === 0 || (c < 9) || (c > 13 && c < 32)) bad += 1;
  }
  return bad / sample.length > 0.02;
}

// Returns { status, error } when an uploaded file must not be ingested,
// otherwise null. Mirrors the file input in Capture Inbox.
function uploadTextProblem(buffer, filename) {
  const kind = sniffBinary(buffer);
  if (kind === 'PDF') {
    return {
      status: 415,
      error: 'PDFs are not accepted: the capture inbox is text-only (no OCR). '
        + 'In the reMarkable app open the notebook and use Convert to text (or select the '
        + 'handwriting and Copy), then paste it into Add a note or upload the saved .txt/.md file.',
    };
  }
  if (kind) {
    return {
      status: 415,
      error: `${kind} is not a text file. Convert the note to text first (${TEXT_UPLOAD_HINT}), then paste or upload it.`,
    };
  }
  if (!TEXT_UPLOAD_RE.test(String(filename || ''))) {
    return {
      status: 415,
      error: `Unsupported file type. This inbox accepts text exports only (${TEXT_UPLOAD_HINT}); PDFs, images and Office files are not converted.`,
    };
  }
  return null;
}

function contentTextProblem(text) {
  if (isBinaryNoise(text)) {
    return {
      status: 400,
      error: 'That file does not contain readable text (binary or unsupported encoding). '
        + 'Export/convert it to a plain-text file and try again.',
    };
  }
  return null;
}

// Webhook payloads arrive as JSON. Zapier/IFTTT can only send text; a PDF or
// image pasted as base64/data-URI is rejected rather than decoded.
function webhookTextProblem(text) {
  if (typeof text !== 'string') {
    return {
      status: 400,
      error: 'The capture webhook accepts plain text only: send {"text":"..."} (no files, PDFs or attachments).',
    };
  }
  const s = text.trimStart();
  if (/^data:application\/pdf/i.test(s) || /^%PDF-/i.test(s)) {
    return {
      status: 415,
      error: 'PDFs are not accepted by the capture webhook (text-only, no OCR). '
        + 'Convert the note to text in the reMarkable app first and POST the text.',
    };
  }
  if (/^data:image\//i.test(s) || /^iVBORw0KGgo/i.test(s) || /^\/9j\//i.test(s)) {
    return {
      status: 415,
      error: 'Images are not accepted by the capture webhook (text-only, no OCR). Convert the note to text first.',
    };
  }
  if (isBinaryNoise(text)) {
    return {
      status: 400,
      error: 'The capture webhook received binary or unreadable text. Send plain text only.',
    };
  }
  return null;
}

module.exports = {
  TEXT_UPLOAD_RE,
  TEXT_UPLOAD_HINT,
  MAX_TEXT,
  sniffBinary,
  plaudText,
  isBinaryNoise,
  uploadTextProblem,
  contentTextProblem,
  webhookTextProblem,
};
