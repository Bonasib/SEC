'use strict';
// Materials, tools & equipment catalog. Items specified on a work order are reserved while the
// work order is active; on closure materials are consumed from stock and damaged tools are written off.
const { all, get, run, tx } = require('./db');
const { audit, HttpError } = require('./util');
const { notify, idsByRole, once } = require('./notify');

const KINDS = ['material', 'tool', 'equipment'];
const UOMS = ['piece', 'meter', 'kg', 'liter', 'set', 'roll', 'box', 'pair'];
const ACTIVE_WO = "('awaiting_authorization','open','in_progress','pending_closure')";

const round = (n) => Math.round(Number(n) * 1000) / 1000;

function canManage(user) {
  return require('./access').can(user, 'materials.manage') === true;
}

/** Quantity reserved by active, not yet settled work orders. */
function reservedQty(itemId, excludeWoId = 0) {
  return get(`SELECT COALESCE(SUM(x.qty), 0) n FROM wo_items x JOIN work_orders w ON w.id = x.wo_id
    WHERE x.item_id = ? AND x.settled = 0 AND w.status IN ${ACTIVE_WO} AND w.id <> ?`, itemId, excludeWoId).n;
}

/** Quantity ordered from suppliers and not yet received. */
function onOrderQty(itemId) {
  return get("SELECT COALESCE(SUM(qty - received_qty), 0) n FROM item_orders WHERE item_id = ? AND status = 'open'", itemId).n;
}

function withStock(item, excludeWoId = 0) {
  const reserved = reservedQty(item.id, excludeWoId);
  const available = round(item.quantity - reserved);
  const onOrder = round(onOrderQty(item.id));
  const low = item.min_qty > 0 && available <= item.min_qty;
  // Suggested order: the reorder quantity, or enough to reach twice the minimum
  const suggest = low && !onOrder ? round(item.reorder_qty || Math.max(item.min_qty * 2 - available, item.min_qty)) : 0;
  return { ...item, reserved: round(reserved), available, on_order: onOrder, low, out: available <= 0, suggest };
}

const SORTS = {
  code: 'i.code', name: 'i.name_ar', kind: 'i.kind', category: 'i.category', quantity: 'i.quantity', location: 'i.location', updated: 'last_move',
};

function list(q = {}) {
  const cond = [], p = [];
  if (KINDS.includes(q.kind)) { cond.push('i.kind = ?'); p.push(q.kind); }
  if (q.category) { cond.push('i.category = ?'); p.push(q.category); }
  if (q.section) { cond.push('i.section_id = ?'); p.push(Number(q.section)); }
  if (q.status) { cond.push('i.status = ?'); p.push(q.status); } else cond.push("i.status = 'active'");
  if (q.q) { cond.push('(skey(i.code) LIKE skey(?) OR skey(i.inventory_no) LIKE skey(?) OR skey(i.name_ar) LIKE skey(?) OR skey(i.name_en) LIKE skey(?) OR skey(i.location) LIKE skey(?))'); p.push(...Array(5).fill(`%${q.q}%`)); }
  const col = SORTS[q.sort] || 'i.code';
  const dir = q.dir === 'desc' ? 'DESC' : 'ASC';
  let rows = all(`SELECT i.*, s.code section_code, (SELECT MAX(created_at) FROM item_movements m WHERE m.item_id = i.id) last_move,
      (SELECT COUNT(DISTINCT x.wo_id) FROM wo_items x JOIN work_orders w ON w.id = x.wo_id WHERE x.item_id = i.id AND x.settled = 0 AND w.status IN ${ACTIVE_WO}) active_wos
    FROM items i LEFT JOIN org_units s ON s.id = i.section_id ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY ${col} ${dir}, i.code`, ...p).map((i) => withStock(i));
  if (q.stock === 'low') rows = rows.filter((i) => i.low || i.out);
  if (q.stock === 'out') rows = rows.filter((i) => i.out);
  if (q.stock === 'ordered') rows = rows.filter((i) => i.on_order > 0);
  if (q.stock === 'reserved') rows = rows.filter((i) => i.reserved > 0);
  if (q.sort === 'available') rows.sort((a, b) => (a.available - b.available) * (dir === 'DESC' ? -1 : 1));
  return rows;
}

function stats() {
  const rows = all("SELECT * FROM items WHERE status = 'active'").map((i) => withStock(i));
  const by = (k) => rows.filter((i) => i.kind === k).length;
  return {
    total: rows.length, material: by('material'), tool: by('tool'), equipment: by('equipment'), low: rows.filter((i) => i.low && !i.out).length, out: rows.filter((i) => i.out).length,
    reserved: rows.filter((i) => i.reserved > 0).length, ordered: rows.filter((i) => i.on_order > 0).length,
  };
}

function fromBody(b) {
  const d = {
    code: String(b.code || '').trim().toUpperCase(), name_ar: String(b.name_ar || '').trim(), name_en: String(b.name_en || '').trim() || null,
    kind: KINDS.includes(b.kind) ? b.kind : null, category: String(b.category || '').trim() || null, uom: String(b.uom || 'piece').trim() || 'piece',
    min_qty: Math.max(0, Number(b.min_qty) || 0), location: String(b.location || '').trim() || null, section_id: Number(b.section_id) || null,
    status: b.status === 'inactive' ? 'inactive' : 'active', notes: String(b.notes || '').trim() || null,
    inventory_no: String(b.inventory_no || '').trim() || null, reorder_qty: Number(b.reorder_qty) > 0 ? Number(b.reorder_qty) : null, supplier: String(b.supplier || '').trim() || null,
  };
  if (!d.code) throw new HttpError(400, 'Item code is required / رمز الصنف مطلوب');
  if (!d.name_ar) throw new HttpError(400, 'Arabic name is required / الاسم العربي مطلوب');
  if (!d.kind) throw new HttpError(400, 'Choose material, tool or equipment / اختر مادة أو عدة أو معدة');
  if (d.inventory_no && get('SELECT 1 FROM items WHERE inventory_no = ? AND code <> ?', d.inventory_no, d.code)) throw new HttpError(400, `Inventory number ${d.inventory_no} already used / رقم المخزون مستخدم`);
  return d;
}

function save(body, req, id, photo) {
  const d = fromBody(body);
  const dup = get('SELECT id FROM items WHERE code = ? AND id <> ?', d.code, id || 0);
  if (dup) throw new HttpError(400, `Code ${d.code} already exists / الرمز موجود`);
  if (!id) {
    const qty = Math.max(0, Number(body.quantity) || 0);
    return tx(() => {
      const r = run(`INSERT INTO items(code, name_ar, name_en, kind, category, uom, min_qty, location, section_id, status, notes, inventory_no, reorder_qty, supplier, quantity)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`, ...Object.values(d));
      const newId = Number(r.lastInsertRowid);
      if (photo) setPhoto(newId, photo, req);
      if (qty) move(newId, 'receive', qty, 'Opening stock / رصيد افتتاحي', req);
      audit(req, 'create', 'item', d.code, null, { ...d, quantity: qty });
      return newId;
    });
  }
  const old = get('SELECT * FROM items WHERE id = ?', id);
  if (!old) throw new HttpError(404, 'Not found');
  run(`UPDATE items SET code=?, name_ar=?, name_en=?, kind=?, category=?, uom=?, min_qty=?, location=?, section_id=?, status=?, notes=?, inventory_no=?, reorder_qty=?, supplier=?
    WHERE id=?`, ...Object.values(d), id);
  if (photo) setPhoto(id, photo, req);
  audit(req, 'update', 'item', d.code, old, d);
  return id;
}

// Optional picture of the item (shown in the catalog and the work order picker)
function setPhoto(id, file, req) {
  const F = require('./files');
  const old = get('SELECT code, photo FROM items WHERE id = ?', id);
  run('UPDATE items SET photo = ? WHERE id = ?', file ? F.rel(file.path) : null, id);
  if (old.photo) F.remove(old.photo);
  audit(req, file ? 'update' : 'delete', 'item_photo', old.code, null, { photo: !!file });
}

// ---------- supplier orders (quantity ordered) ----------
function createOrder(itemId, b, req) {
  const item = get('SELECT * FROM items WHERE id = ?', itemId);
  if (!item) throw new HttpError(404, 'Not found');
  const qty = Number(b.qty);
  if (!(qty > 0)) throw new HttpError(400, 'Enter the ordered quantity / أدخل الكمية المطلوبة');
  const r = run('INSERT INTO item_orders(item_id, order_no, supplier, qty, expected_date, notes, created_by) VALUES (?,?,?,?,?,?,?)', itemId,
    String(b.order_no || '').trim() || null, String(b.supplier || item.supplier || '').trim() || null, round(qty), /^\d{4}-\d{2}-\d{2}$/.test(b.expected_date || '') ? b.expected_date : null,
    String(b.notes || '').trim() || null, req.user.id);
  audit(req, 'order', 'item', item.code, null, { qty, order_no: b.order_no, supplier: b.supplier });
  notify(idsByRole('warehouse'), { type: 'item_ordered', email: false, title: `${item.code} - طلب توريد ${qty} ${item.uom} / Order placed`, body: item.name_ar, link: `/materials/${itemId}#orders` });
  return Number(r.lastInsertRowid);
}

/** Receive all or part of an order: stock goes up, the order closes when complete. */
function receiveOrder(orderId, qty, req) {
  const o = get('SELECT * FROM item_orders WHERE id = ?', orderId);
  if (!o || o.status !== 'open') throw new HttpError(400, 'Order is not open / الطلب غير مفتوح');
  const left = round(o.qty - o.received_qty);
  const n = qty === undefined || qty === '' ? left : Number(qty);
  if (!(n > 0) || n > left) throw new HttpError(400, `Receive between 0 and ${left} / الكمية بين 0 و ${left}`);
  tx(() => {
    move(o.item_id, 'receive', n, `${o.order_no || 'PO#' + o.id}${o.supplier ? ' · ' + o.supplier : ''}`, req);
    const received = round(o.received_qty + n);
    run('UPDATE item_orders SET received_qty = ?, status = ?, closed_at = ? WHERE id = ?', received, received >= o.qty ? 'received' : 'open', received >= o.qty ? new Date().toISOString() : null, o.id);
  });
  const item = get('SELECT * FROM items WHERE id = ?', o.item_id);
  if (o.created_by) notify([o.created_by], { type: 'item_received', email: false, title: `${item.code} - تم استلام ${n} ${item.uom} / Received`, body: item.name_ar, link: `/materials/${item.id}` });
  lowStockCheck([o.item_id]);
  return o.item_id;
}

function cancelOrder(orderId, req) {
  const o = get('SELECT * FROM item_orders WHERE id = ?', orderId);
  if (!o || o.status !== 'open') throw new HttpError(400, 'Order is not open / الطلب غير مفتوح');
  run("UPDATE item_orders SET status = 'cancelled', closed_at = ? WHERE id = ?", new Date().toISOString(), o.id);
  audit(req, 'cancel', 'item_order', o.id, o, { status: 'cancelled' });
  return o.item_id;
}

/** Year summary of one item: in, out, damage, adjustments, average monthly use and months of cover. */
function summary(itemId, year = new Date().getFullYear()) {
  const y = String(year);
  const sum = (kind) => round(get(`SELECT COALESCE(SUM(qty), 0) n FROM item_movements WHERE item_id = ? AND kind = ? AND substr(created_at,1,4) = ?`, itemId, kind, y).n);
  const consumed = -sum('consume'), damaged = -sum('damage');
  const months = Math.max(1, new Date().getFullYear() === Number(year) ? new Date().getMonth() + 1 : 12);
  const avg = round(consumed / months);
  const item = withStock(get('SELECT * FROM items WHERE id = ?', itemId));
  return {
    year, received: sum('receive'), consumed, damaged, adjusted: sum('adjust'), avg_month: avg,
    cover_months: avg > 0 ? round(item.available / avg) : null,
    wo_count: get('SELECT COUNT(DISTINCT wo_id) n FROM wo_items WHERE item_id = ?', itemId).n,
  };
}

/**
 * Every transaction on items in one list: stock movements, work-order reservations
 * (reserved / released / settled) and supplier orders.
 */
function transactions(q = {}) {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : '0000-01-01', to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : '9999-12-31';
  const item = q.item ? Number(q.item) : null;
  const rd = (c) => `date(${c}, '+3 hours')`;
  const itemCond = item ? ' AND i.id = ' + item : '';
  const out = [];
  for (const m of all(`SELECT m.*, i.code, i.name_ar, i.name_en, i.uom, i.inventory_no, w.wo_number, e.name_ar by_ar, e.name_en by_en FROM item_movements m JOIN items i ON i.id = m.item_id
      LEFT JOIN work_orders w ON w.id = m.wo_id LEFT JOIN employees e ON e.id = m.created_by WHERE ${rd('m.created_at')} BETWEEN ? AND ?${itemCond}`, from, to)) {
    out.push({ at: m.created_at, kind: m.kind, item_id: m.item_id, code: m.code, inventory_no: m.inventory_no, name_ar: m.name_ar, name_en: m.name_en, uom: m.uom, qty: m.qty, balance: m.balance, wo_id: m.wo_id, wo_number: m.wo_number, note: m.note, by_ar: m.by_ar, by_en: m.by_en });
  }
  for (const x of all(`SELECT x.*, i.code, i.name_ar, i.name_en, i.uom, i.inventory_no, w.wo_number, w.status wo_status, e.name_ar by_ar, e.name_en by_en FROM wo_items x JOIN items i ON i.id = x.item_id
      JOIN work_orders w ON w.id = x.wo_id LEFT JOIN employees e ON e.id = x.added_by WHERE ${rd('x.added_at')} BETWEEN ? AND ?${itemCond}`, from, to)) {
    const state = x.settled ? 'settled' : w_active(x.wo_status) ? 'reserved' : 'released';
    out.push({ at: x.added_at, kind: 'reserve_' + state, item_id: x.item_id, code: x.code, inventory_no: x.inventory_no, name_ar: x.name_ar, name_en: x.name_en, uom: x.uom, qty: -x.qty, balance: null, wo_id: x.wo_id, wo_number: x.wo_number, note: x.notes, by_ar: x.by_ar, by_en: x.by_en });
  }
  for (const o of all(`SELECT o.*, i.code, i.name_ar, i.name_en, i.uom, i.inventory_no, e.name_ar by_ar, e.name_en by_en FROM item_orders o JOIN items i ON i.id = o.item_id
      LEFT JOIN employees e ON e.id = o.created_by WHERE ${rd('o.created_at')} BETWEEN ? AND ?${itemCond}`, from, to)) {
    out.push({ at: o.created_at, kind: 'order_' + o.status, item_id: o.item_id, code: o.code, inventory_no: o.inventory_no, name_ar: o.name_ar, name_en: o.name_en, uom: o.uom, qty: o.qty, balance: null, order_no: o.order_no, note: [o.supplier, o.received_qty ? `received ${o.received_qty}` : ''].filter(Boolean).join(' · '), by_ar: o.by_ar, by_en: o.by_en });
  }
  let rows = out;
  if (q.kind) rows = rows.filter((r) => r.kind === q.kind || r.kind.startsWith(q.kind + '_'));
  if (q.wo) rows = rows.filter((r) => (r.wo_number || '').includes(String(q.wo).toUpperCase()));
  return rows.sort((a, b) => (a.at < b.at ? 1 : -1));
}
const w_active = (st) => ['awaiting_authorization', 'open', 'in_progress', 'pending_closure'].includes(st);

/** Record a stock movement and update the balance. qty is signed for 'adjust'; positive otherwise. */
function move(itemId, kind, qty, note, req, woId = null) {
  const item = get('SELECT * FROM items WHERE id = ?', itemId);
  if (!item) throw new HttpError(404, 'Item not found');
  const delta = kind === 'receive' ? Math.abs(qty) : kind === 'adjust' ? Number(qty) : -Math.abs(qty);
  const balance = round(item.quantity + delta);
  if (balance < 0) throw new HttpError(400, `${item.code}: stock cannot go below zero (on hand ${item.quantity}) / لا يمكن أن يقل الرصيد عن صفر`);
  run('UPDATE items SET quantity = ? WHERE id = ?', balance, itemId);
  run('INSERT INTO item_movements(item_id, wo_id, kind, qty, balance, note, created_by) VALUES (?,?,?,?,?,?,?)', itemId, woId, kind, round(delta), balance, note || null, req?.user?.id ?? null);
  audit(req, 'stock_' + kind, 'item', item.code, { quantity: item.quantity }, { quantity: balance, wo_id: woId }, note);
  return balance;
}

function stockMove(itemId, { kind, qty, note }, req) {
  if (!['receive', 'adjust', 'damage'].includes(kind)) throw new HttpError(400, 'Bad movement type');
  const n = Number(qty);
  if (!n || Number.isNaN(n)) throw new HttpError(400, 'Enter a quantity / أدخل الكمية');
  if (kind !== 'receive' && !String(note || '').trim()) throw new HttpError(400, 'A reason is required / السبب مطلوب');
  tx(() => move(itemId, kind, n, note, req));
  lowStockCheck([itemId]);
}

// ---------- work orders ----------
/** Validate requested lines [{item_id, qty}] against available stock (excluding this work order). */
function checkLines(lines, excludeWoId = 0) {
  const errors = [];
  for (const l of lines) {
    const item = get('SELECT * FROM items WHERE id = ?', l.item_id);
    if (!item) { errors.push(`Unknown item ${l.item_id}`); continue; }
    if (item.status !== 'active') errors.push(`${item.code} ${item.name_ar}: inactive / غير فعال`);
    if (!(l.qty > 0)) errors.push(`${item.code}: quantity must be more than zero / الكمية يجب أن تكون أكبر من صفر`);
    const s = withStock(item, excludeWoId);
    if (l.qty > s.available) errors.push(`${item.code} ${item.name_ar}: requested ${l.qty} ${item.uom}, available ${s.available} / الكمية المتاحة ${s.available}`);
  }
  return errors;
}

function parseLines(body) {
  const ids = [].concat(body.item_ids || []), qtys = [].concat(body.item_qtys || []);
  const map = new Map();
  ids.forEach((id, i) => {
    const itemId = Number(id), qty = Number(qtys[i]);
    // The picker lists every item; rows left empty (or zero) are not requested
    if (!itemId || !(qty > 0)) return;
    map.set(itemId, round((map.get(itemId) || 0) + (qty || 0)));
  });
  return [...map].map(([item_id, qty]) => ({ item_id, qty }));
}

function addLines(woId, lines, req) {
  for (const l of lines) {
    run('INSERT INTO wo_items(wo_id, item_id, qty, added_by) VALUES (?,?,?,?)', woId, l.item_id, l.qty, req?.user?.id ?? null);
  }
}

function ofWo(woId) {
  return all(`SELECT x.*, i.code, i.name_ar, i.name_en, i.kind, i.uom, i.quantity on_hand, i.photo, i.inventory_no FROM wo_items x JOIN items i ON i.id = x.item_id
    WHERE x.wo_id = ? ORDER BY CASE i.kind WHEN 'material' THEN 1 WHEN 'tool' THEN 2 ELSE 3 END, i.code`, woId);
}

const woLabel = (wo) => `${wo.wo_number}:items`;

function addToWo(wo, { itemId, qty, notes }, req) {
  if (!['awaiting_authorization', 'open', 'in_progress'].includes(wo.status)) throw new HttpError(400, 'Locked for this status / مقفل لهذه الحالة');
  const existing = get('SELECT * FROM wo_items WHERE wo_id = ? AND item_id = ?', wo.id, itemId);
  const total = round((existing?.qty || 0) + Number(qty));
  const errors = checkLines([{ item_id: itemId, qty: total }], wo.id);
  if (errors.length) throw new HttpError(400, errors.join('\n'));
  if (existing) run('UPDATE wo_items SET qty = ?, notes = COALESCE(?, notes) WHERE id = ?', total, notes || null, existing.id);
  else run('INSERT INTO wo_items(wo_id, item_id, qty, notes, added_by) VALUES (?,?,?,?,?)', wo.id, itemId, total, notes || null, req.user.id);
  audit(req, existing ? 'update' : 'create', 'wo_item', woLabel(wo), existing || null, { item_id: itemId, qty: total });
}

function updateWoLine(wo, lineId, b, req) {
  const line = get('SELECT * FROM wo_items WHERE id = ? AND wo_id = ?', lineId, wo.id);
  if (!line) throw new HttpError(404, 'Not found');
  if (line.settled || !['awaiting_authorization', 'open', 'in_progress'].includes(wo.status)) throw new HttpError(400, 'Locked / مقفل');
  const qty = b.qty === undefined || b.qty === '' ? line.qty : Number(b.qty);
  const used = b.used_qty === undefined || b.used_qty === '' ? null : Number(b.used_qty);
  const damaged = Math.max(0, Number(b.damaged_qty) || 0);
  const item = get('SELECT * FROM items WHERE id = ?', line.item_id);
  const errors = checkLines([{ item_id: line.item_id, qty }], wo.id);
  if (used != null && (used < 0 || used > qty)) errors.push(`${item.code}: used must be between 0 and ${qty} / المستخدم بين 0 و ${qty}`);
  if (damaged > qty) errors.push(`${item.code}: damaged more than quantity / التالف أكبر من الكمية`);
  if (errors.length) throw new HttpError(400, errors.join('\n'));
  const after = { qty, used_qty: item.kind === 'material' ? used : null, damaged_qty: damaged, notes: b.notes ?? line.notes };
  run('UPDATE wo_items SET qty = ?, used_qty = ?, damaged_qty = ?, notes = ? WHERE id = ?', after.qty, after.used_qty, after.damaged_qty, after.notes || null, line.id);
  audit(req, 'update', 'wo_item', woLabel(wo), line, after);
}

function removeFromWo(wo, lineId, req) {
  const line = get('SELECT * FROM wo_items WHERE id = ? AND wo_id = ?', lineId, wo.id);
  if (!line) throw new HttpError(404, 'Not found');
  if (line.settled || !['awaiting_authorization', 'open', 'in_progress'].includes(wo.status)) throw new HttpError(400, 'Locked / مقفل');
  run('DELETE FROM wo_items WHERE id = ?', line.id);
  audit(req, 'delete', 'wo_item', woLabel(wo), line, null);
}

/** On closure: consume materials (used, or the full quantity when not recorded) and write off damage. */
function settle(wo, req) {
  const lines = all('SELECT x.*, i.kind, i.code FROM wo_items x JOIN items i ON i.id = x.item_id WHERE x.wo_id = ? AND x.settled = 0', wo.id);
  if (!lines.length) return;
  tx(() => {
    for (const l of lines) {
      const item = get('SELECT quantity FROM items WHERE id = ?', l.item_id);
      if (l.kind === 'material') {
        const used = Math.min(l.used_qty ?? l.qty, item.quantity);
        if (used > 0) move(l.item_id, 'consume', used, `${wo.wo_number}`, req, wo.id);
      }
      const left = get('SELECT quantity FROM items WHERE id = ?', l.item_id).quantity;
      const dmg = Math.min(l.damaged_qty || 0, left);
      if (dmg > 0) move(l.item_id, 'damage', dmg, `${wo.wo_number} damaged / تالف`, req, wo.id);
      run('UPDATE wo_items SET settled = 1 WHERE id = ?', l.id);
    }
  });
  lowStockCheck(lines.map((l) => l.item_id));
}

/** Alert the warehouse once each time an item falls to (or below) its minimum. */
function lowStockCheck(itemIds) {
  const rows = itemIds ? itemIds.map((id) => get('SELECT * FROM items WHERE id = ?', id)).filter(Boolean) : all("SELECT * FROM items WHERE status = 'active' AND min_qty > 0");
  for (const i of rows) {
    const s = withStock(i);
    if (!(s.min_qty > 0) || s.available > s.min_qty) { run('DELETE FROM alert_keys WHERE key LIKE ?', `stock-low-${i.id}-%`); continue; }
    once(`stock-low-${i.id}-${s.out ? 'out' : 'low'}`, () => notify(idsByRole('warehouse', 'admin'), {
      type: 'stock_low', severity: s.out ? 'critical' : 'warning',
      title: `${i.code} - ${s.out ? 'نفدت الكمية / Out of stock' : 'انخفاض المخزون / Low stock'}`,
      body: [`${i.name_ar}${i.name_en ? ' / ' + i.name_en : ''}`, `المتاح / Available: ${s.available} ${i.uom} · الحد الأدنى / Minimum: ${i.min_qty}`,
        s.on_order ? `مطلوب من المورد / On order: ${s.on_order}` : `الكمية المقترحة للطلب / Suggested order: ${s.suggest} ${i.uom}`].join('\n'), link: `/materials/${i.id}#orders`,
    }));
  }
}

/** Options for pickers: active items with live availability. */
function pickerOptions(excludeWoId = 0) {
  return all("SELECT * FROM items WHERE status = 'active' ORDER BY kind, code").map((i) => withStock(i, excludeWoId));
}

module.exports = {
  createOrder, receiveOrder, cancelOrder, summary, transactions, setPhoto, onOrderQty,
  KINDS, UOMS, canManage, list, stats, save, stockMove, withStock, reservedQty, checkLines, parseLines, addLines, ofWo,
  addToWo, updateWoLine, removeFromWo, settle, lowStockCheck, pickerOptions,
};
