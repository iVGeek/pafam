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
      return { status: r.status, body: b, ctype: r.headers.get('content-type') || '', len: t.length };
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

    // sourcing: lowest executable landed cost
    const multi = await admin.req('GET', '/products?multi=1&limit=1');
    const pid = multi.body.rows && multi.body.rows[0] && multi.body.rows[0].id;
    const low = await admin.req('GET', `/sourcing/lowest?productId=${pid}&quantity=12&destination=US`);
    console.log('sourcing/lowest:', low.status, '| offers:', low.body.counts && low.body.counts.offers,
      '| executable:', low.body.counts && low.body.counts.executable,
      '| winner:', low.body.winner && `${low.body.winner.supplier} @ ${low.body.winner.landedUnitCost} ${low.body.baseCurrency} (complete=${low.body.winner.complete})`);
    const lowBad = await admin.req('GET', '/sourcing/lowest');
    console.log('sourcing/lowest no args (expect 400):', lowBad.status);

    // deals: profitability + cash flow
    const offers = await admin.req('GET', '/offers?limit=1');
    const offerRow = (offers.body.rows || offers.body)[0];
    const deal = await admin.req('POST', '/deals/compute', { offerId: offerRow.id, customerId: 1, quantity: 24, sellingUnitPrice: 60 });
    console.log('deals/compute:', deal.status, '| margin:', deal.body.deal && deal.body.deal.metrics.marginPct,
      '| contribution:', deal.body.deal && deal.body.deal.contribution.total,
      '| capital:', deal.body.deal && deal.body.deal.cashflow.peakCapital,
      '| capitalDays:', deal.body.deal && deal.body.deal.cashflow.capitalDays,
      '| terms(sup/cus):', deal.body.terms && `${deal.body.terms.supplierPayDays}/${deal.body.terms.customerPayDays}`);
    const save = await admin.req('POST', '/deals', { offerId: offerRow.id, customerId: 1, quantity: 24, sellingUnitPrice: 60 });
    console.log('deals save (expect 200):', save.status, '| id:', save.body.id);
    const quotes = await admin.req('GET', '/quotes');
    console.log('quotes listing:', quotes.status, '| count:', (quotes.body || []).length, '| latest contribution:', (quotes.body || [])[0] && quotes.body[0].contribution_total);

    // trends & alerts
    const al = await admin.req('GET', '/alerts');
    console.log('alerts listing:', al.status, '| counts:', JSON.stringify(al.body.counts), '| rows:', (al.body.rows || []).length);
    const alRefresh = await admin.req('POST', '/alerts/refresh');
    console.log('alerts refresh:', alRefresh.status, '| created:', JSON.stringify(alRefresh.body));
    const tr = await admin.req('GET', '/trends?changed=1&limit=5');
    console.log('trends:', tr.status, '| movers:', (tr.body.rows || []).length, '| top:', (tr.body.rows || [])[0] && `${(tr.body.rows[0].supplierCode)} ${tr.body.rows[0].changePct}%`);
    if ((al.body.rows || [])[0]) {
      const mr = await admin.req('POST', `/alerts/${al.body.rows[0].id}/read`);
      console.log('alert mark read:', mr.status);
    }

    // orders & realised margin
    const ordList = await admin.req('GET', '/orders');
    const ordRealised = (ordList.body || []).filter((o) => o.realised && o.realised.settled)
      .reduce((s, o) => s + o.realised.realisedMargin, 0);
    console.log('orders listing:', ordList.status, '| count:', (ordList.body || []).length, '| realised margin:', ordRealised);
    const ordNew = await admin.req('POST', '/orders', { customerId: 1, productId: pid, quantity: 20, unitCost: 7, unitPrice: 11, currency: 'USD' });
    console.log('orders create (expect 200):', ordNew.status, '| id:', ordNew.body.id);
    if (ordNew.body.id) {
      const pay = await admin.req('POST', `/orders/${ordNew.body.id}/payments`, { direction: 'outbound', amount: 140, method: 'Transfer' });
      console.log('payment record (expect 200):', pay.status, '| id:', pay.body.id);
      const o1 = await admin.req('GET', `/orders/${ordNew.body.id}`);
      console.log('order detail:', o1.status, '| paidOut:', o1.body.realised && o1.body.realised.paidOut, '| outstanding:', o1.body.realised && o1.body.realised.revenueOutstanding);
    }

    // reports & excel exports
    const rep = await admin.req('GET', '/reports');
    console.log('reports:', rep.status, '| suppliers:', (rep.body.suppliers || []).length, '| wins:', Object.keys(rep.body.wins || {}).length);
    const xl = await admin.req('GET', '/export/orders.xlsx');
    console.log('export orders.xlsx:', xl.status, '| chars:', xl.len, '| type:', xl.ctype);
    const xlBad = await admin.req('GET', '/export/nope.xlsx');
    console.log('export unknown (expect 404):', xlBad.status);

    // webhook with secret
    const hook = await anon.req('POST', '/captures/webhook', { source: 'plaud', text: 'Client wants 50 units of Tanqueray. secret: nope' });
    console.log('webhook wrong secret (expect 401):', hook.status);
  } catch (e) {
    console.error('SMOKE ERROR', e);
  } finally {
    server.close();
  }
});
