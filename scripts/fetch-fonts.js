'use strict';
// Download variable font files into public/fonts (run once, fonts then self-host).
const fs = require('fs');
const path = require('path');

const FONTS = [
  {
    out: 'Inter-var.ttf',
    url: 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/inter/Inter%5Bopsz,wght%5D.ttf',
    weight: '100 900',
    family: 'Inter',
    style: 'normal',
  },
  {
    out: 'Fraunces-var.ttf',
    url: 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/fraunces/Fraunces%5BSOFT,WONK,opsz,wght%5D.ttf',
    weight: '100 900',
    family: 'Fraunces',
    style: 'normal',
  },
  {
    out: 'JetBrainsMono-var.ttf',
    url: 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf',
    weight: '100 800',
    family: 'JetBrains Mono',
    style: 'normal',
  },
];

(async () => {
  const dir = path.join(__dirname, '..', 'public', 'fonts');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of FONTS) {
    const target = path.join(dir, f.out);
    if (fs.existsSync(target)) { console.log('skip ' + f.out); continue; }
    console.log('fetch ' + f.out);
    const res = await fetch(f.url);
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + f.url);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(target, buf);
    console.log('  ' + (buf.length / 1024).toFixed(0) + ' KB');
  }
})();
