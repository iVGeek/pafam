'use strict';
// The staff brief is the source of the desk's non-negotiable rules. Keep the
// assistant's rulebook in sync with it so an edit cannot silently drop them.
const { test } = require('node:test');
const assert = require('node:assert');
const { SYSTEM_PROMPT } = require('../server/services/aiKnowledge');

test('assistant rulebook contains the staff brief rules', () => {
  const phrases = [
    'executable landed cost',
    'false zero',
    'gross profit / net revenue',
    'customer-default stress case',
    'units-per-case conversion',
    'dated snapshot',
    'available supply',
    'usable on hand - reservations',
    'matched-supplier series',
    'probability-weighted opportunities',
    'Never invent a barcode',
    'never reveal supplier names',
    'text transcripts only',
    'master-data exceptions',
    'Unknown values stay blank',
    'rate source/date',
    'quarantined',
    'stock-outs',
    'Maximum buy price',
    'aging buckets',
    'test restoration',
    'acceptance criterion is met',
    'barcode alias table',
    'gender/category',
    'with or without cap',
    'price sensitivity',
    'extraction confidence',
    '57.94%',
    'Partial receipts',
    'transport requirements',
    'Google Drive',
    'Verified by GS1',
    'machine-readable integration contract',
  ];
  for (const phrase of phrases) {
    assert.ok(SYSTEM_PROMPT.includes(phrase), 'missing staff rule: ' + phrase);
  }
});
