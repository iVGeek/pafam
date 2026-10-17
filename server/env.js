'use strict';
// Minimal, dependency-free .env loader.
//
// Real environment variables always win: a value already present in
// process.env is never overwritten, so a shell/`Railway`/`Render` variable
// takes precedence over the local .env file. Used for local development
// (e.g. pointing the AI assistant at an OpenAI-compatible provider).

const fs = require('fs');
const path = require('path');

function parse(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      const hash = val.search(/\s#/);
      if (hash !== -1) val = val.slice(0, hash).trim();
    }
    out[key] = val;
  }
  return out;
}

function load(filePath) {
  const file = filePath || path.join(__dirname, '..', '.env');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return {};
  }
  const parsed = parse(text);
  for (const key of Object.keys(parsed)) {
    if (process.env[key] === undefined) process.env[key] = parsed[key];
  }
  return parsed;
}

module.exports = { load, parse };
