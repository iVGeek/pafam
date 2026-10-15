'use strict';

// Follow-up tasks (brief section 15).
//
// The capture inbox receives notes from Plaud / reMarkable / the webhook. A
// note is not a deal: somebody has to review it, confirm the numbers and
// actually follow up with the customer. This service keeps that loop explicit
// so a lead cannot quietly rot in the inbox.
//
// Rules that matter:
//   * A capture that contains a real lead signal (a quantity, a price or a
//     named customer) automatically gets an open task. A capture with no
//     signals is still stored, but does not generate noise.
//   * Promoting a capture into a demand closes its task automatically,
//     because the note has now been actioned.
//   * Due dates come from the `followup_days` setting; overdue tasks are
//     reported, never silently dropped.

const { db, getSetting, audit } = require('../db');

const OPEN = 'open';

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(days) {
  const d = new Date(Date.now() + (Number(days) || 0) * 864e5);
  return d.toISOString().slice(0, 10);
}

function defaultDueDate() {
  return addDaysIso(Number(getSetting('followup_days', '2')));
}

// A note is "actionable" when the parser found something a human can act on.
function looksLikeLead(parsed) {
  if (!parsed) return false;
  return Boolean(
    (Number(parsed.suggestedQuantity) > 0) ||
    (Number(parsed.suggestedPrice) > 0) ||
    parsed.customerHint ||
    (parsed.barcodes && parsed.barcodes.length)
  );
}

function create(input) {
  const info = db.prepare(
    `INSERT INTO tasks(capture_id, demand_id, customer_id, title, detail, due_date, owner, priority, status, created_by, notes)
     VALUES(?,?,?,?,?,?,?,?,'open',?,?)`
  ).run(
    input.captureId ? Number(input.captureId) : null,
    input.demandId ? Number(input.demandId) : null,
    input.customerId ? Number(input.customerId) : null,
    input.title || 'Follow up',
    input.detail || null,
    input.dueDate || defaultDueDate(),
    input.owner || null,
    input.priority || 'normal',
    input.createdBy || 'system',
    input.notes || null
  );
  return Number(info.lastInsertRowid);
}

// Create the automatic review task for a newly captured note. Returns null when
// the note carries no lead signal, so we do not manufacture work.
function taskForCapture(capture, parsed, actor) {
  if (!looksLikeLead(parsed)) return null;
  const bits = [];
  if (parsed.suggestedQuantity) bits.push(`${parsed.suggestedQuantity} units`);
  if (parsed.suggestedPrice) bits.push(`target ${parsed.suggestedPrice}${parsed.suggestedCurrency ? ' ' + parsed.suggestedCurrency : ''}`);
  if (parsed.customerHint) bits.push(parsed.customerHint);
  const detail = bits.length ? `Parsed signals: ${bits.join(', ')}` : null;
  const title = `Review ${capture.source} note${capture.title ? `: ${capture.title}` : ''}`;
  return create({
    captureId: capture.id,
    title,
    detail,
    dueDate: defaultDueDate(),
    priority: 'high',
    createdBy: actor || 'system',
  });
}

// Close any open task attached to a capture (used when it is promoted or
// ignored). Returns the number of tasks closed.
function closeForCapture(captureId, actor, note) {
  const open = db.prepare(
    "SELECT id FROM tasks WHERE capture_id = ? AND status = 'open'"
  ).all(Number(captureId));
  for (const t of open) {
    db.prepare(
      "UPDATE tasks SET status = 'done', completed_at = datetime('now'), completed_by = ?, notes = ? WHERE id = ?"
    ).run(actor || 'system', note || null, t.id);
  }
  return open.length;
}

function list(opts = {}) {
  const where = [];
  const params = [];
  if (opts.status) { where.push('t.status = ?'); params.push(String(opts.status)); }
  else if (opts.openOnly) { where.push("t.status = 'open'"); }
  if (opts.owner) { where.push('t.owner = ?'); params.push(String(opts.owner)); }
  if (opts.captureId) { where.push('t.capture_id = ?'); params.push(Number(opts.captureId)); }
  if (opts.overdue) {
    where.push("t.status = 'open' AND t.due_date IS NOT NULL AND t.due_date < ?");
    params.push(todayIso());
  }
  const sql = `
    SELECT t.*, c.source AS capture_source, c.title AS capture_title,
           cu.name AS customer_name
      FROM tasks t
      LEFT JOIN captures c ON c.id = t.capture_id
      LEFT JOIN customers cu ON cu.id = t.customer_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY t.status = 'done', t.due_date IS NULL, t.due_date, t.id DESC
     LIMIT ?`;
  params.push(Number(opts.limit) || 200);
  const today = todayIso();
  return db.prepare(sql).all(...params).map((r) => ({
    ...r,
    overdue: r.status === 'open' && r.due_date && r.due_date < today,
  }));
}

function summary() {
  const today = todayIso();
  const row = db.prepare(
    `SELECT
        COUNT(*) FILTER (WHERE status = 'open') AS open,
        COUNT(*) FILTER (WHERE status = 'open' AND due_date < ?) AS overdue,
        COUNT(*) FILTER (WHERE status = 'open' AND due_date = ?) AS dueToday,
        COUNT(*) FILTER (WHERE status = 'done') AS done
       FROM tasks`
  ).get(today, today);
  return {
    open: row.open || 0,
    overdue: row.overdue || 0,
    dueToday: row.dueToday || 0,
    done: row.done || 0,
  };
}

function complete(taskId, actor, notes) {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(taskId));
  if (!t) return { ok: false, error: 'task not found' };
  if (t.status !== 'open') return { ok: false, error: `task already ${t.status}` };
  db.prepare(
    "UPDATE tasks SET status = 'done', completed_at = datetime('now'), completed_by = ?, notes = ? WHERE id = ?"
  ).run(actor || 'system', notes || t.notes, Number(taskId));
  audit(actor || 'system', 'task-complete', 'task', Number(taskId));
  return { ok: true, id: Number(taskId), summary: summary() };
}

function cancel(taskId, actor) {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(taskId));
  if (!t) return { ok: false, error: 'task not found' };
  if (t.status !== 'open') return { ok: false, error: `task already ${t.status}` };
  db.prepare("UPDATE tasks SET status = 'cancelled', completed_at = datetime('now'), completed_by = ? WHERE id = ?")
    .run(actor || 'system', Number(taskId));
  audit(actor || 'system', 'task-cancel', 'task', Number(taskId));
  return { ok: true, id: Number(taskId), summary: summary() };
}

module.exports = {
  create, taskForCapture, closeForCapture, looksLikeLead,
  list, summary, complete, cancel, defaultDueDate,
};