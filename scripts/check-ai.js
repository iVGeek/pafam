'use strict';

// Health check for the AI provider. Free model catalogues retire models
// without notice, so this answers "is the assistant still able to answer?"
// from the command line.
//
//   npm run check:ai            report only
//   npm run check:ai -- --write repair .env with the first working free model
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

function chooseReplacement(diag) {
  const configured = new Set(diag.configured);
  const alt = (diag.freeAlternatives || []).find((m) => !configured.has(m.id));
  return alt ? alt.id : null;
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
    const replacement = diag.ok ? null : chooseReplacement(diag);
    if (!replacement) {
      console.log('\nNothing to fix: ' + (diag.ok ? 'configured models look usable.' : 'no free alternative found - check the key and provider URL.'));
    } else {
      const chain = [replacement].concat((diag.freeAlternatives || []).filter((m) => m.id !== replacement).slice(0, 1).map((m) => m.id));
      writeEnv(replacement, chain);
      console.log('Restart the server for the change to take effect.');
    }
    return;
  }

  if (diag.hint) console.log('\n  hint: ' + diag.hint);
  console.log('\n  ' + (diag.ok ? 'RESULT: at least one configured model can answer.' : 'RESULT: no usable model - run with --write to pick a working free one.') + '\n');
  process.exitCode = diag.ok ? 0 : 1;
})();
