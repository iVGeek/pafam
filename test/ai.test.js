'use strict';
// Tests for AI provider configuration, model fallback and health diagnostics.
// No network: the transport's fetch is swapped for a fake.
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_DB = path.join(os.tmpdir(), `ptp-ai-${process.pid}.db`);
process.env.PTP_DATA_DIR = path.dirname(TMP_DB);
process.env.PTP_DB = TMP_DB;
process.on('exit', () => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch (e) { /* ignore */ }
  }
});

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const ai = require('../server/services/ai');
const { db } = require('../server/db');

const SAVED = {};
for (const k of ['AI_MODEL', 'AI_MODELS', 'AI_BASE_URL', 'AI_API_KEY', 'PTP_AI_MOCK', 'AI_TIMEOUT_MS', 'AI_AUTO_DISCOVER', 'AI_AUTO_DISCOVER_MAX', 'AI_DISCOVER_MAX_PRICE', 'AI_MAX_STEPS']) SAVED[k] = process.env[k];

function setEnv(vars) {
  for (const k of Object.keys(SAVED)) delete process.env[k];
  Object.assign(process.env, { AI_BASE_URL: 'https://provider.test/v1', AI_API_KEY: 'test-key' }, vars);
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sse(chunks) {
  const body = chunks.map((c) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: c } }] }) + '\n\n').join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

afterEach(() => {
  ai.setFetch(null);
  ai.setTransport(null);
  ai._resetDiscovery();
  for (const k of Object.keys(SAVED)) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

test('status exposes the configured fallback chain', () => {
  setEnv({ AI_MODEL: 'primary:id', AI_MODELS: 'first:id, second:id , first:id' });
  const s = ai.status();
  assert.deepStrictEqual(s.models, ['first:id', 'second:id']);
  assert.strictEqual(s.model, 'first:id');
});

test('a retired model is skipped and the next model answers', async () => {
  setEnv({ AI_MODELS: 'retired:free, working:free' });
  const seen = [];
  ai.setFetch(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    seen.push(body.model);
    if (body.model === 'retired:free') {
      return json(404, { error: { message: 'This model is unavailable for free. The paid version is available now' } });
    }
    return json(200, { choices: [{ message: { role: 'assistant', content: 'hello' } }] });
  });
  const out = await ai.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(out.reply, 'hello');
  assert.strictEqual(out.model, 'working:free');
  assert.deepStrictEqual(seen, ['retired:free', 'working:free']);
});

test('a rate-limited model falls through to the next one', async () => {
  setEnv({ AI_MODELS: 'busy:free, calm:free' });
  const seen = [];
  ai.setFetch(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    seen.push(body.model);
    if (body.model === 'busy:free') return json(429, { error: { message: 'Provider returned error' } });
    return json(200, { choices: [{ message: { role: 'assistant', content: 'ok' } }] });
  });
  const out = await ai.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(out.reply, 'ok');
  assert.deepStrictEqual(seen, ['busy:free', 'calm:free']);
});

test('an auth failure stops immediately instead of retrying every model', async () => {
  setEnv({ AI_MODELS: 'a:id, b:id' });
  const seen = [];
  ai.setFetch(async (_url, opts) => {
    seen.push(JSON.parse(opts.body).model);
    return json(401, { error: { message: 'Invalid API key' } });
  });
  await assert.rejects(() => ai.chat({ messages: [{ role: 'user', content: 'hi' }] }), (e) => {
    assert.strictEqual(e.code, 'auth');
    assert.match(e.message, /AI_API_KEY/);
    return true;
  });
  assert.deepStrictEqual(seen, ['a:id']);
});

test('when every model is dead the error names the models and points at check:ai', async () => {
  setEnv({ AI_MODELS: 'gone:free, also-gone:free' });
  ai.setFetch(async () => json(404, { error: { message: 'No endpoints found for model' } }));
  await assert.rejects(() => ai.chat({ messages: [{ role: 'user', content: 'hi' }] }), (e) => {
    assert.strictEqual(e.status, 502);
    assert.strictEqual(e.code, 'model_unavailable');
    assert.strictEqual(e.failures.length, 2);
    assert.match(e.message, /gone:free/);
    assert.match(e.message, /also-gone:free/);
    assert.match(e.message, /check:ai/);
    return true;
  });
});

test('streaming also falls back and assembles the answer from the second model', async () => {
  setEnv({ AI_MODELS: 'dead:free, live:free' });
  ai.setFetch(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.model === 'dead:free') return json(404, { error: { message: 'unavailable for free' } });
    assert.strictEqual(body.stream, true);
    return sse(['Hel', 'lo!']);
  });
  const events = [];
  const out = await ai.chat({ messages: [{ role: 'user', content: 'hi' }], onEvent: (e) => events.push(e) });
  assert.strictEqual(out.reply, 'Hello!');
  assert.deepStrictEqual(events.filter((e) => e.type === 'delta').map((e) => e.text), ['Hel', 'lo!']);
});

test('provider errors are classified for humans', () => {
  assert.strictEqual(ai._describeProvider(404, 'This model is unavailable for free', 'x').code, 'model_unavailable');
  assert.strictEqual(ai._describeProvider(404, 'No endpoints found', 'x').retry, true);
  assert.strictEqual(ai._describeProvider(401, 'Invalid key', 'x').code, 'auth');
  assert.strictEqual(ai._describeProvider(429, 'rate limited', 'x').retry, true);
  assert.strictEqual(ai._describeProvider(400, 'bad tools payload', 'x').retry, false);
  assert.match(ai._describeProvider(402, 'no credit', 'x').message, /credit/);
});

test('a stale chain self-heals from the provider catalogue and remembers the model', async () => {
  setEnv({ AI_MODELS: 'retired:free', AI_BASE_URL: 'https://openrouter.ai/api/v1' });
  const seen = [];
  ai.setFetch(async (url, opts) => {
    if (url.endsWith('/models')) {
      return json(200, {
        data: [
          { id: 'fresh:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
          { id: 'no-tools:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: [] },
        ],
      });
    }
    const body = JSON.parse(opts.body);
    seen.push(body.model);
    if (body.model === 'retired:free') return json(404, { error: { message: 'This model is unavailable for free' } });
    return json(200, { choices: [{ message: { role: 'assistant', content: 'rescued' } }] });
  });

  const first = await ai.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(first.reply, 'rescued');
  assert.strictEqual(first.model, 'fresh:free');
  assert.strictEqual(ai.status().discoveredModel, 'fresh:free');

  const second = await ai.chat({ messages: [{ role: 'user', content: 'again' }] });
  assert.strictEqual(second.reply, 'rescued');
  // Second turn starts with the discovered model: no dead-model attempt.
  assert.deepStrictEqual(seen, ['retired:free', 'fresh:free', 'fresh:free']);
});

test('auto-discovery can be disabled (AI_AUTO_DISCOVER=0)', async () => {
  setEnv({ AI_MODELS: 'gone:free', AI_BASE_URL: 'https://openrouter.ai/api/v1', AI_AUTO_DISCOVER: '0' });
  ai.setFetch(async (url) => {
    if (url.endsWith('/models')) throw new Error('catalogue must not be fetched');
    return json(404, { error: { message: 'This model is unavailable for free' } });
  });
  await assert.rejects(() => ai.chat({ messages: [{ role: 'user', content: 'hi' }] }), (e) => {
    assert.strictEqual(e.code, 'model_unavailable');
    return true;
  });
});

test('the SSE route streams delta + done instead of closing the response early', async () => {
  setEnv({ AI_MODELS: 'test:model' });
  ai.setTransport(async (_payload, onDelta) => {
    if (typeof onDelta === 'function') { onDelta('Hel'); onDelta('lo'); }
    return { choices: [{ message: { role: 'assistant', content: 'Hello' } }], _model: 'test:model' };
  });
  const http = require('http');
  const auth = require('../server/services/auth');
  try { auth.createUser({ username: 'admin', password: 'admin123', role: 'admin' }); } catch (e) { if (e.status !== 409) throw e; }
  const app = require('../server');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const login = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    assert.strictEqual(login.status, 200);
    const cookie = login.headers.get('set-cookie');
    const res = await fetch(base + '/api/ai/chat/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    assert.match(text, /event: delta/);
    assert.match(text, /"text":"Hel"/);
    assert.match(text, /event: done/);
    assert.match(text, /"reply":"Hello"/);
    assert.match(text, /"model":"test:model"/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// Minimal catalogue for the draft_placement tests: one supplier, one upload,
// four sizes of one product, and deliberately mixed offer shapes.
function seedPlacementFixture() {
  db.prepare("INSERT OR IGNORE INTO suppliers(code, name, currency) VALUES ('ALCO', 'Alcodis', 'EUR')").run();
  let up = db.prepare('SELECT id FROM uploads LIMIT 1').get();
  if (!up) {
    up = { id: Number(db.prepare("INSERT INTO uploads(supplier_code, filename, file_hash) VALUES ('ALCO', 'test.xlsx', 'hash')").run().lastInsertRowid) };
  }
  const sizes = [50, 100];
  const ids = {};
  for (const ml of sizes) {
    const name = 'Test Blue Eau de Toilette Vaporizador ' + ml + ' ml';
    let p = db.prepare('SELECT id FROM products WHERE display_name = ?').get(name);
    if (!p) {
      p = { id: Number(db.prepare('INSERT INTO products(brand, fragrance, concentration, size_ml, display_name) VALUES (?,?,?,?,?)')
        .run('Test', 'Blue', 'EDT', ml, name).lastInsertRowid) };
    }
    ids[ml] = p.id;
  }
  const offer = (productId, price, priceType, upc) => {
    db.prepare(`INSERT INTO offers(upload_id, supplier_code, description, size_ml, currency, price, price_basis, price_type, units_per_case, product_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(up.id, 'ALCO', 'test offer', null, 'EUR', price, 'unit', priceType, upc, productId);
  };
  const count = db.prepare("SELECT COUNT(*) n FROM offers WHERE supplier_code = 'ALCO'").get().n;
  if (!count) {
    // The RRP-derived offer is cheaper but must lose to the real cost offer.
    offer(ids[50], 5, 'rrp', 6);
    offer(ids[50], 10, 'cost', 6);
    offer(ids[100], 12, 'cost', 6);
  }
  return ids;
}

test('draft_placement resolves names and supplier offers in one call', () => {
  const ids = seedPlacementFixture();
  const out = ai.runTool('draft_placement', {
    supplierCode: 'ALCO',
    lines: [
      { productQuery: 'Test Blue Eau de Toilette 50 ml', boxes: 1 },
      { productQuery: 'Test Blue Eau de Toilette 100 ml', units: 7 },
    ],
  });
  assert.ok(out.proposal, JSON.stringify(out.result));
  const lines = out.proposal.apply.body.lines;
  assert.deepStrictEqual(lines.map((l) => l.productId), [ids[50], ids[100]]);
  // One full box, then 7 bottles rounded up to two boxes of six.
  assert.deepStrictEqual(lines.map((l) => l.units), [6, 12]);
  // Cost offer wins over the cheaper RRP-derived one.
  assert.strictEqual(lines[0].unitCost, 10);
  assert.strictEqual(lines[1].unitCost, 12);
  assert.match(out.proposal.fields[1].value, /2 box\(es\) = 12 units/);
  assert.match(out.proposal.summary, /204 EUR/);

  // The proposal body must be directly applicable by the real service.
  const placements = require('../server/services/placements');
  const created = placements.createPlacement(Object.assign({ createdBy: 'test' }, out.proposal.apply.body));
  assert.ok(created.ok, JSON.stringify(created));
  const saved = placements.getPlacement(created.id);
  assert.strictEqual(saved.lines.length, 2);
  assert.deepStrictEqual(saved.lines.map((l) => l.units), [6, 12]);
  assert.deepStrictEqual(saved.lines.map((l) => l.boxes), [1, 2]);
  assert.strictEqual(saved.totals.total, 204);
});

test('draft_placement asks for a size instead of guessing between variants', () => {
  seedPlacementFixture();
  const out = ai.runTool('draft_placement', {
    supplierCode: 'ALCO',
    lines: [{ productQuery: 'Test Blue Eau de Toilette', boxes: 1 }],
  });
  assert.match(out.result.error, /several products match/);
  assert.ok(out.result.candidates.length >= 2);
});

test('draft_placement explains a missing supplier offer', () => {
  seedPlacementFixture();
  db.prepare("INSERT OR IGNORE INTO suppliers(code, name, currency) VALUES ('OTHER', 'Other Co', 'EUR')").run();
  const out = ai.runTool('draft_placement', {
    supplierCode: 'OTHER',
    lines: [{ productQuery: 'Test Blue Eau de Toilette 50 ml', boxes: 1 }],
  });
  assert.match(out.result.error, /Other Co has no usable cost offer/);
});

test('drafts prepared before the step budget runs out are still returned', async () => {
  setEnv({ AI_MODELS: 'test:model', AI_MAX_STEPS: '2' });
  let n = 0;
  ai.setTransport(async () => {
    n += 1;
    return {
      choices: [{
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'c' + n, type: 'function', function: { name: 'draft_task', arguments: JSON.stringify({ title: 'follow up ' + n }) } }],
        },
      }],
      _model: 'test:model',
    };
  });
  const out = await ai.chat({ messages: [{ role: 'user', content: 'draft a task' }] });
  assert.strictEqual(out.proposals.length, 2);
  assert.match(out.reply, /prepared 2 drafts/);
});

test('repeated identical draft calls produce one card, not duplicates', async () => {
  setEnv({ AI_MODELS: 'test:model' });
  let turn = 0;
  ai.setTransport(async () => {
    turn += 1;
    if (turn === 1) {
      const call = (id) => ({ id, type: 'function', function: { name: 'draft_task', arguments: '{"title":"follow up"}' } });
      return { choices: [{ message: { role: 'assistant', content: '', tool_calls: [call('a'), call('b')] } }], _model: 'test:model' };
    }
    return { choices: [{ message: { role: 'assistant', content: 'Drafted.' } }], _model: 'test:model' };
  });
  const out = await ai.chat({ messages: [{ role: 'user', content: 'draft it' }] });
  assert.strictEqual(out.proposals.length, 1);
});

test('a bare "yes" is steered to act on the offered draft', async () => {
  setEnv({ AI_MODELS: 'test:model' });
  let seen = null;
  ai.setTransport(async (payload) => {
    seen = payload.messages;
    return { choices: [{ message: { role: 'assistant', content: 'Prepared.' } }], _model: 'test:model' };
  });
  await ai.chat({
    messages: [
      { role: 'user', content: 'cheapest supplier for X?' },
      { role: 'assistant', content: 'Alcodis. Want me to prepare a draft placement?' },
      { role: 'user', content: 'yes' },
    ],
  });
  assert.ok(seen.some((m) => m.role === 'system' && /confirmed your previous offer/i.test(m.content)));
});

test('a successful retry is described even if the model narrates the earlier error', async () => {
  setEnv({ AI_MODELS: 'test:model' });
  let turn = 0;
  ai.setTransport(async () => {
    turn += 1;
    if (turn === 1) {
      return {
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'a', type: 'function', function: { name: 'draft_task', arguments: '{"title":"follow up"}' } }],
          },
        }],
        _model: 'test:model',
      };
    }
    return { choices: [{ message: { role: 'assistant', content: 'It seems there was an issue preparing the draft.' } }], _model: 'test:model' };
  });
  const out = await ai.chat({ messages: [{ role: 'user', content: 'draft a task' }] });
  assert.strictEqual(out.proposals.length, 1);
  assert.match(out.reply, /I prepared 1 draft/);
  assert.doesNotMatch(out.reply, /issue/);
});

test('an exhausted free tier self-heals to a cheap paid model', async () => {
  setEnv({ AI_MODELS: 'retired:free', AI_BASE_URL: 'https://openrouter.ai/api/v1' });
  const seen = [];
  ai.setFetch(async (url, opts) => {
    if (url.endsWith('/models')) {
      return json(200, {
        data: [
          { id: 'busy:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'], context_length: 1000 },
          { id: 'cheap:paid', pricing: { prompt: '0.00000015', completion: '0.0000006' }, supported_parameters: ['tools'], context_length: 1000 },
          { id: 'pricey:paid', pricing: { prompt: '0.00001', completion: '0.00003' }, supported_parameters: ['tools'], context_length: 1000 },
        ],
      });
    }
    const body = JSON.parse(opts.body);
    seen.push(body.model);
    if (body.model === 'retired:free') return json(404, { error: { message: 'This model is unavailable for free' } });
    if (body.model === 'busy:free') return json(429, { error: { message: 'Provider returned error' } });
    return json(200, { choices: [{ message: { role: 'assistant', content: 'paid ok' } }] });
  });
  const out = await ai.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(out.reply, 'paid ok');
  assert.strictEqual(out.model, 'cheap:paid');
  assert.strictEqual(ai.status().discoveredModel, 'cheap:paid');
  // Free first, then the cheapest paid model; the expensive one is never tried.
  assert.deepStrictEqual(seen, ['retired:free', 'busy:free', 'cheap:paid']);
});

test('diagnose reports missing configured models and suggests free alternatives', async () => {
  setEnv({ AI_MODELS: 'gone:free, alive:free', AI_BASE_URL: 'https://openrouter.ai/api/v1' });
  ai.setFetch(async (url) => {
    if (url.endsWith('/models')) {
      return json(200, {
        data: [
          { id: 'alive:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'], context_length: 100000 },
          { id: 'candidate:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools', 'reasoning'], context_length: 200000 },
          { id: 'no-tools:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: [], context_length: 5000 },
          { id: 'paid:model', pricing: { prompt: '0.1', completion: '0.2' }, supported_parameters: ['tools'], context_length: 5000 },
        ],
      });
    }
    if (url.endsWith('/key')) return json(200, { data: { label: 'k', limit: 100, limit_remaining: 100, usage: 0 } });
    return json(404, {});
  });
  const d = await ai.diagnose();
  assert.strictEqual(d.ok, true);
  assert.deepStrictEqual(d.usable, ['alive:free']);
  assert.deepStrictEqual(d.models.map((m) => [m.id, m.present]), [['gone:free', false], ['alive:free', true]]);
  assert.deepStrictEqual(d.freeAlternatives.map((m) => m.id), ['candidate:free', 'alive:free']);
  assert.strictEqual(d.key.remaining, 100);
});
