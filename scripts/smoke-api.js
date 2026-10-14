'use strict';
const app = require('../server/index');

const PORT = 4199;

function client(base) {
  let cookie = '';
  return {
    async req(method, path, body) {
      const opts = { method, headers: {} };
      if (cookie) opts.headers['cookie'] = cookie;
      if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
      const r = await fetch(base + path, opts);
      const sc = r.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      const t = await r.text();
      let b; try { b = JSON.parse(t); } catch { b = t; }
      return { status: r.status, body: b };
    },
  };
}

const server = app.listen(PORT, async () => {
  const base = `http://localhost:${PORT}/api`;
  const anon = client(base);
  const admin = client(base);
  const viewer = client(base);
  const analyst = client(base);
  try {
    // unauthenticated access blocked
    const noauth = await anon.req('GET', '/dashboard');
    console.log('no-auth dashboard status (expect 401):', noauth.status);

    // login as admin
    const login = await admin.req('POST', '/auth/login', { username: 'admin', password: 'admin123' });
    console.log('admin login:', login.status, '| role:', login.body.user && login.body.user.role);
    const dash = await admin.req('GET', '/dashboard');
    console.log('admin dashboard:', dash.status, '| offers:', dash.body.overview && dash.body.overview.offers, '| opp:', (dash.body.opportunities || []).length, '| review:', (dash.body.reviewItems || []).length);

    // users list (admin only)
    const users = await admin.req('GET', '/users');
    console.log('admin users:', users.status, '| count:', (users.body || []).length);

    // captures
    const caps = await admin.req('GET', '/captures');
    console.log('captures:', caps.status, '| count:', (caps.body || []).length);
    const c0 = (caps.body || [])[0];
    if (c0) console.log('  first capture parsed:', JSON.stringify({ src: c0.source, qty: c0.parsed.suggestedQuantity, price: c0.parsed.suggestedPrice, cur: c0.parsed.suggestedCurrency, barcodes: c0.parsed.barcodes.length, intents: c0.parsed.intents.slice(0,3) }));

    // viewer restrictions
    await viewer.req('POST', '/auth/login', { username: 'viewer', password: 'viewer123' });
    const vSet = await viewer.req('POST', '/settings', { min_margin_pct: '20' });
    console.log('viewer POST /settings (expect 403):', vSet.status);
    const vUsers = await viewer.req('GET', '/users');
    console.log('viewer GET /users (expect 403):', vUsers.status);
    const vDash = await viewer.req('GET', '/dashboard');
    console.log('viewer GET /dashboard (expect 200):', vDash.status);

    // analyst can ingest capture, cannot promote
    await analyst.req('POST', '/auth/login', { username: 'analyst', password: 'analyst123' });
    const aCap = await analyst.req('POST', '/captures', { source: 'manual', title: 'test', text: 'Need 300 bottles of Absolut Vodka, 12.50 EUR' });
    console.log('analyst POST /captures (expect 200):', aCap.status, '| id:', aCap.body.id);
    const aPromote = await analyst.req('POST', `/captures/${aCap.body.id}/promote`, { customerId: 1, productId: 1, quantity: 300 });
    console.log('analyst promote (expect 403):', aPromote.status);

    // admin can promote
    const promote = await admin.req('POST', `/captures/${aCap.body.id}/promote`, { customerId: 1, productId: 1, quantity: 300 });
    console.log('admin promote (expect 200):', promote.status, '| demandId:', promote.body.demandId);

    // webhook with secret
    const hook = await anon.req('POST', '/captures/webhook', { source: 'plaud', text: 'Client wants 50 units of Tanqueray. secret: nope' });
    console.log('webhook wrong secret (expect 401):', hook.status);
  } catch (e) {
    console.error('SMOKE ERROR', e);
  } finally {
    server.close();
  }
});
