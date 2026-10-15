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
    console.log('analyst POST /captures (expect 200):', aCap.status, '| id:', aCap.body.id, '| auto task:', aCap.body.taskId);
    const aPromote = await analyst.req('POST', `/captures/${aCap.body.id}/promote`, { customerId: 1, productId: 1, quantity: 300 });
    console.log('analyst promote (expect 403):', aPromote.status);

    // admin can promote
    const promote = await admin.req('POST', `/captures/${aCap.body.id}/promote`, { customerId: 1, productId: 1, quantity: 300 });
    console.log('admin promote (expect 200):', promote.status, '| demandId:', promote.body.demandId);

    // follow-up tasks: auto-created by the capture, closed by promoting it
    const taskList = await admin.req('GET', '/tasks');
    const autoTask = (taskList.body.rows || []).find((t) => t.capture_id === aCap.body.id);
    console.log('tasks:', taskList.status, '| summary:', JSON.stringify(taskList.body.summary),
      '| capture task status:', autoTask && autoTask.status);
    const newCap = await admin.req('POST', '/captures', { source: 'plaud', title: 'lead', text: 'Wants 120 units at 9.00 USD' });
    const t2 = await admin.req('GET', '/tasks');
    const leadTask = (t2.body.rows || []).find((t) => t.capture_id === newCap.body.id && t.status === 'open');
    console.log('new lead task:', leadTask ? `open due ${leadTask.due_date} overdue=${leadTask.overdue}` : 'NONE');
    if (leadTask) {
      const doneRes = await admin.req('POST', `/tasks/${leadTask.id}/done`, {});
      console.log('task done (expect 200):', doneRes.status, '| open now:', doneRes.body.summary && doneRes.body.summary.open);
      const twice = await admin.req('POST', `/tasks/${leadTask.id}/done`, {});
      console.log('task done twice (expect 400):', twice.status);
    }

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
    console.log('deal scenarios:', (deal.body.deal.scenarios || []).map((s) => s.kind).join(', '));

    // §9 worked example reconciliation over HTTP (deal costs included)
    const s9 = await admin.req('POST', '/deals/compute', {
      quantity: 1000, landedUnitCost: 33, sellingUnitPrice: 40, outboundPerUnit: 2,
      supplierPayDays: 0, customerPayDays: 90, orderDate: '2026-01-01',
    });
    const s9d = s9.body.deal || {};
    console.log('§9 reconcile:', s9.status,
      '| grossProfit:', s9d.metrics && s9d.metrics.grossProfitTotal,
      '| contribution:', s9d.contribution && s9d.contribution.total,
      '| deployedCapital:', s9d.return && s9d.return.deployedCapital,
      '| simpleReturn:', s9d.return && s9d.return.simpleReturnPct,
      '| annualised(90d):', s9d.return && s9d.return.annualisedReturnPct);

    // reservations: availability, oversell guard, release (section 11/20)
    const inv = await admin.req('GET', '/inventory');
    const lot = (inv.body.rows || [])[0];
    if (lot) {
      const avail = await admin.req('GET', `/inventory/availability`);
      const a0 = (avail.body || []).find((l) => l.lotId === lot.id) || {};
      const tooMuch = await admin.req('POST', '/reservations', { lotId: lot.id, quantity: 999999 });
      console.log('reserve oversell (expect 400):', tooMuch.status, '|', tooMuch.body && tooMuch.body.error);
      const ok = await admin.req('POST', '/reservations', { lotId: lot.id, quantity: 1 });
      console.log('reserve 1 (expect 200):', ok.status, '| availableToSell:', ok.body && ok.body.availableToSell);
      if (ok.body && ok.body.id) {
        const rel = await admin.req('POST', `/reservations/${ok.body.id}/release`, {});
        console.log('release (expect 200):', rel.status, '| availableToSell:', rel.body && rel.body.availableToSell);
      }
      console.log('availability lot', lot.id, ':', JSON.stringify(a0));
    }
    const reservationsList = await admin.req('GET', '/reservations');
    console.log('reservations listing:', reservationsList.status, '| lots:', (reservationsList.body.lots || []).length);
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

    // integrations surface: GL journal + stock snapshot + contract
    const gl = await admin.req('GET', '/export/gl.xlsx');
    console.log('export gl.xlsx (GL journal):', gl.status, '| chars:', gl.len);
    const stkl = await admin.req('GET', '/export/stock.xlsx');
    console.log('export stock.xlsx:', stkl.status, '| chars:', stkl.len);
    const integ = await admin.req('GET', '/integrations');
    console.log('integrations:', integ.status, '| exports:', (integ.body.exports || []).length, '| webhook:', integ.body.webhook && integ.body.webhook.url);

    // trends series + customer quote export (masked)
    const trSeries = await admin.req('GET', `/trends?productId=${pid}`);
    console.log('trends series:', trSeries.status, '| suppliers:', (trSeries.body.series || []).length,
      '| windows:', (trSeries.body.series || [])[0] && JSON.stringify(Object.keys((trSeries.body.series[0].windows) || {})));
    const qx = await admin.req('GET', `/export/quote/${save.body.id}.xlsx`);
    console.log('quote export (expect 200):', qx.status, '| chars:', qx.len);
    const qxBad = await admin.req('GET', '/export/quote/999999.xlsx');
    console.log('quote export missing (expect 404):', qxBad.status);

    // shipment cost allocation (section 8 control 2)
    const drv = await admin.req('GET', '/shipments/drivers');
    console.log('shipment drivers:', drv.status, '|', (drv.body || []).map((d) => d.key).join(','));
    const badDrv = await admin.req('POST', '/shipments', { totalCost: 100, driver: 'vibes' });
    console.log('shipment bad driver (expect 400):', badDrv.status);
    const shp = await admin.req('POST', '/shipments', {
      direction: 'inbound', supplierCode: 'ALCODIS', costType: 'freight', totalCost: 1000,
      driver: 'value', declaredValue: 6000,
      lines: [{ productId: pid, quantity: 10, basisValue: 4000 }, { productId: pid, quantity: 5, basisValue: 2000 }],
    });
    const alloc = await admin.req('POST', `/shipments/${shp.body.id}/allocate`, {});
    console.log('shipment allocate:', alloc.status, '| total:', alloc.body.shipmentTotal,
      '| allocated:', alloc.body.allocatedTotal, '| reconciled:', alloc.body.reconciled,
      '| lines:', (alloc.body.lines || []).map((l) => l.allocatedCost).join('+'));
    const shpList = await admin.req('GET', '/shipments');
    console.log('shipments listing:', shpList.status, '| count:', (shpList.body || []).length);

    // buying recommendations (demand -> cheapest executable supplier)
    const recs = await admin.req('GET', '/recommendations');
    console.log('recommendations:', recs.status, '| rows:', (recs.body.rows || []).length, '| actionable:', recs.body.summary && recs.body.summary.actionable);
    const recOne = (recs.body.rows || [])[0];
    if (recOne) {
      const recDetail = await admin.req('GET', `/recommendations/${recOne.productId}`);
      console.log('recommendation detail:', recDetail.status, '| orderQty:', recDetail.body.orderQuantity, '| supplier:', recDetail.body.supplier && recDetail.body.supplier.code, '| sellSource:', recDetail.body.sellSource, '| candidates:', (recDetail.body.candidates || []).length);
    }
    const recBad = await admin.req('GET', '/recommendations/999999');
    console.log('recommendation missing (expect 404):', recBad.status);

    // purchase plan consolidation
    const pp = await admin.req('GET', '/purchase-plan');
    console.log('purchase-plan:', pp.status, '| items:', (pp.body.items || []).length, '| actionable:', pp.body.totals && pp.body.totals.actionable, '| cap:', pp.body.totals && pp.body.totals.capital);
    const ppA = await admin.req('GET', '/purchase-plan?approvedOnly=1');
    console.log('purchase-plan (approved):', ppA.status, '| items:', (ppA.body.items || []).length);

    // KPI suite
    const kp = await admin.req('GET', '/kpis');
    console.log('kpis:', kp.status, '| grossProfit:', kp.body.summary && kp.body.summary.grossProfit, '| grossMargin:', kp.body.summary && kp.body.summary.grossMarginPct, '| ar:', kp.body.cash && kp.body.cash.ar, '| capitalRequired:', kp.body.cash && kp.body.cash.capitalRequired);

    // demand forecast baseline
    const fc = await admin.req('GET', '/forecast');
    console.log('forecast:', fc.status, '| products:', (fc.body.byProduct || []).length, '| forecastable:', fc.body.sufficientCount, '| minObs:', fc.body.minObservations);

    // webhook with secret
    const hook = await anon.req('POST', '/captures/webhook', { source: 'plaud', text: 'Client wants 50 units of Tanqueray. secret: nope' });
    console.log('webhook wrong secret (expect 401):', hook.status);
  } catch (e) {
    console.error('SMOKE ERROR', e);
    } finally {
    server.close();
  }
});

async function run() {
  // quick check via direct HTTP? easier: call a second spawn? just inline with the same pattern
}

