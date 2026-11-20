'use strict';

// Health check for the AI provider. Free model catalogues retire models
// without notice, so this answers "is the assistant still able to answer?"
// from the command line.
//
//   npm run check:ai            report only
//   npm run check:ai -- --write repair .env with a model that passes a real
//                              tool call (free models are often ZDR-blocked
//                              or rate-limited, so the catalogue is not enough)
//
// Exit code 1 when no configured model is usable.

require('../server/env').load();

const fs = require('fs');
const path = require('path');
const ai = require('../server/services/ai');

const ENV_FILE = path.join(__dirname, '..', '.env');

function line(label, value) {
  console.log('  ' + label.padEnd(16) + String(value));
}

function candidates(diag) {
  const configured = new Set(diag.configured);
  const ids = []
    .concat((diag.fallbacks || []), (diag.freeAlternatives || []).map((m) => m.id), diag.configured)
    .filter((id) => id && !configured.has(id));
  return ids.filter((id, i) => ids.indexOf(id) === i);
}

// A catalogue entry that lists tool support can still be unusable: account ZDR
// rules exclude providers at routing time and free tiers commonly return 429.
// Prove the candidate can execute a tool before writing it into .env.
async function verifyModel(id) {
  const base = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const key = process.env.AI_API_KEY || '';
  try {
    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, key ? { authorization: 'Bearer ' + key } : {}),
      body: JSON.stringify({
        model: id,
        messages: [{ role: 'user', content: 'Find the cheapest landed cost for GTIN 08400000000437, quantity 120, to US.' }],
        tools: [{ type: 'function', function: {
          name: 'lowest_cost',
          description: 'Lowest landed cost for a GTIN and quantity.',
          parameters: { type: 'object', properties: { gtin: { type: 'string' }, quantity: { type: 'integer' } }, required: ['gtin', 'quantity'] },
        } }],
        tool_choice: { type: 'function', function: { name: 'lowest_cost' } },
        max_tokens: 512,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return false;
    const data = await res.json();
    const calls = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.tool_calls;
    if (!calls || !calls.length) return false;
    const args = typeof calls[0].function.arguments === 'string' ? JSON.parse(calls[0].function.arguments || '{}') : calls[0].function.arguments;
    return String(args.gtin) === '08400000000437' && Number(args.quantity) === 120;
  } catch (_) {
    return false;
  }
}

function writeEnv(primary, chain) {
  const exists = fs.existsSync(ENV_FILE);
  const text = exists ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text ? text.split(/\r?\n/) : [];
  const set = (key, value) => {
    const i = lines.findIndex((l) => l.trim().startsWith(key + '='));
    const row = key + '=' + value;
    if (i >= 0) lines[i] = row;
    else lines.push(row);
  };
  set('AI_MODEL', primary);
  set('AI_MODELS', chain.join(','));
  let out = lines.join(eol);
  if (eol === '\n' && !out.endsWith('\n')) out += '\n';
  fs.writeFileSync(ENV_FILE, out);
  console.log('\nUpdated ' + ENV_FILE + ' -> AI_MODELS=' + chain.join(','));
}

(async () => {
  const diag = await ai.diagnose();
  console.log('\nAI assistant health check\n');
  line('provider', diag.provider);
  line('key', diag.hasKey ? 'set' : 'not set (fine for a local server)');
  line('reachable', diag.reachable === null ? 'unknown' : diag.reachable === false ? 'NO' : 'yes (HTTP ' + diag.reachable + ')');
  line('configured', diag.configured.join(', '));
  if (diag.key) {
    line('key limit', diag.key.limit === null || diag.key.limit === undefined ? 'unlimited' : '$' + diag.key.limit);
    line('key remaining', diag.key.remaining === null || diag.key.remaining === undefined ? '-' : '$' + diag.key.remaining);
    line('key usage', '$' + (diag.key.usage || 0));
  }

  console.log('\n  models:');
  for (const m of diag.models) {
    if (m.present === null) console.log('    ?  ' + m.id + '  (catalogue unavailable, cannot verify)');
    else if (!m.present) console.log('    X  ' + m.id + '  MISSING on this provider (retired or renamed)');
    else if (!m.supportsTools) console.log('    !  ' + m.id + '  exists but does NOT support tool calls');
    else console.log('    OK ' + m.id + (m.free ? '  (free)' : '  (paid)'));
  }

  if (diag.freeAlternatives.length) {
    console.log('\n  free models that support tools (newest catalogue order):');
    for (const m of diag.freeAlternatives.slice(0, 8)) {
      console.log('    -  ' + m.id + (m.context ? '  (context ' + Math.round(m.context / 1000) + 'k)' : ''));
    }
  }

  const args = process.argv.slice(2);
  if (args.includes('--write')) {
    if (diag.ok) {
      console.log('\nNothing to fix: configured models look usable.');
      return;
    }
    const verified = [];
    for (const id of candidates(diag)) {
      process.stdout.write('  verifying ' + id + ' ... ');
      const ok = await verifyModel(id);
      console.log(ok ? 'OK' : 'not usable');
      if (ok) verified.push(id);
      if (verified.length >= 2) break;
    }
    if (!verified.length) {
      console.log('\nNothing to fix: no candidate passed a live tool call. Check the key, credit and account privacy settings.');
      return;
    }
    writeEnv(verified[0], verified);
    console.log('Restart the server for the change to take effect.');
    return;
  }

  if (diag.hint) console.log('\n  hint: ' + diag.hint);
  console.log('\n  ' + (diag.ok ? 'RESULT: at least one configured model can answer.' : 'RESULT: no usable model - run with --write to verify and install a working one.') + '\n');
  process.exitCode = diag.ok ? 0 : 1;
})();
