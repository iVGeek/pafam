'use strict';
// Tool results must not flood the provider context: each result is bounded and
// the whole turn has a budget, with an explicit marker so the model cannot
// mistake a truncated answer for complete data.
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_DB = path.join(os.tmpdir(), `ptp-ai-toolctx-${process.pid}.db`);
process.env.PTP_DATA_DIR = path.dirname(TMP_DB);
process.env.PTP_DB = TMP_DB;
process.env.PTP_AI_MOCK = '1';
process.env.AI_TOOL_RESULT_MAX_CHARS = '4000';
delete process.env.AI_API_KEY;
delete process.env.AI_BASE_URL;
process.on('exit', () => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch (_) { /* ignore */ }
  }
});

const { test, after } = require('node:test');
const assert = require('node:assert');
const ai = require('../server/services/ai');
const { db } = require('../server/db');

require('../server/seedData').seedData({ log: () => {} });

after(() => { ai.setTransport(null); });

test('boundToolResult keeps a small result untouched and marks a large one', () => {
  const small = ai.boundToolResult({ count: 1 }, 4000);
  assert.deepStrictEqual(JSON.parse(small), { count: 1 });

  const big = ai.boundToolResult({ rows: Array.from({ length: 500 }, (_, i) => ({ id: i, note: 'x'.repeat(80) })) }, 4000);
  assert.ok(big.length <= 4000, 'result is bounded');
  assert.match(big, /TRUNCATED/);
  assert.match(big, /Narrow the query/);
});

test('chat bounds the tool message it sends back to the provider', async () => {
  const insert = db.prepare(
    'INSERT INTO audit_log(actor, action, entity, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)'
  );
  for (let i = 0; i < 80; i += 1) {
    insert.run('probe', 'list', 'offer', i, 'x'.repeat(200), new Date().toISOString());
  }

  let seen = null;
  ai.setTransport(async ({ messages }) => {
    const toolMsg = messages.find((m) => m.role === 'tool');
    if (!toolMsg) {
      return {
        choices: [{ message: {
          role: 'assistant', content: '',
          tool_calls: [{ id: 'call1', type: 'function', function: { name: 'list_audit', arguments: JSON.stringify({ limit: 300 }) } }],
        } }],
      };
    }
    seen = toolMsg.content;
    return { choices: [{ message: { role: 'assistant', content: 'done' } }] };
  });

  const out = await ai.chat({ messages: [{ role: 'user', content: 'show me the audit log' }] });
  assert.strictEqual(out.reply, 'done');
  assert.ok(seen, 'a tool result was sent back');
  assert.ok(seen.length <= ai.toolResultMaxChars(), 'tool result stayed inside the per-result cap');
  assert.match(seen, /TRUNCATED/);
});
