// API behind deepshift.co.il.
// Clients book a slot, which is held briefly while they pay Lital in Bit; Lital then confirms the
// transfer from the admin page, which sends the client a confirmation email. Data lives in D1 (env.DB).

const TZ = 'Asia/Jerusalem';
const WORK_DAYS = [0, 1, 2, 3, 4]; // Sun–Thu
const HOURS = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18]; // 60-minute sessions, last one 18:00–19:00
const BOOK_AHEAD_DAYS = 60;
const HOLD_MINUTES = 15;
const RETENTION_MONTHS = 12;
const ADMIN_SESSION_HOURS = 12;

// Prices are decided here, never by the browser.
const SERVICES = {
  theta: { name: 'תטא הילינג', prices: { single: 333, pack: 2222 } },
  'nlp-personal': { name: 'NLP אישי', prices: { single: 333, pack: 2222 } },
  'nlp-couple': { name: 'NLP זוגי', prices: { single: 333, pack: 2222 } },
  'nlp-business': { name: 'NLP עסקי', prices: { single: 333 } },
  'numerology-personal': { name: 'נומרולוגיה אישי', prices: { single: 444 } },
  'numerology-couple': { name: 'נומרולוגיה זוגי', prices: { single: 444 } },
  'numerology-business': { name: 'נומרולוגיה עסקי ושותפויות', prices: { single: 444 } },
};
const QUESTION_PRICE = 150;
const PRODUCT_NAMES = { single: 'מפגש בודד, 60 דקות', pack: 'תהליך, 10 מפגשים' };
const ACTIVE = "('held', 'claimed', 'paid')";

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = msg => { throw new HttpError(400, msg); };

export default {
  async fetch(req, env, ctx) {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res;
    try {
      res = await route(req, env, ctx);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      res = json({ error: e instanceof HttpError ? e.message : 'server error' }, e instanceof HttpError ? e.status : 500);
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(cleanup(env));
  },
};

async function route(req, env, ctx) {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, '');
  const m = req.method;
  let g;
  if (m === 'GET' && p === '/api/availability') return availability(url, env);
  if (m === 'GET' && p === '/api/workshops') return publicWorkshops(env);
  if (m === 'POST' && p === '/api/bookings') return createBooking(req, env);
  if (m === 'POST' && (g = p.match(/^\/api\/bookings\/(\d+)\/claim$/))) return claimBooking(req, env, ctx, +g[1]);
  if (m === 'POST' && p === '/api/admin/login') return login(req, env);
  if (p.startsWith('/api/admin/')) {
    await requireAdmin(req, env);
    if (m === 'GET' && p === '/api/admin/bookings') return adminBookings(env);
    if (m === 'POST' && (g = p.match(/^\/api\/admin\/bookings\/(\d+)\/(paid|cancel)$/))) return g[2] === 'paid' ? markPaid(env, +g[1]) : cancelBooking(env, +g[1]);
    if (m === 'GET' && p === '/api/admin/export.csv') return exportCsv(env);
    if (m === 'GET' && p === '/api/admin/workshops') return adminWorkshops(env);
    if (m === 'POST' && p === '/api/admin/workshops') return saveWorkshop(req, env, null);
    if (m === 'PUT' && (g = p.match(/^\/api\/admin\/workshops\/(\d+)$/))) return saveWorkshop(req, env, +g[1]);
    if (m === 'DELETE' && (g = p.match(/^\/api\/admin\/workshops\/(\d+)$/))) return archiveWorkshop(env, +g[1]);
  }
  throw new HttpError(404, 'not found');
}

// ---------- public ----------

async function availability(url, env) {
  const today = ilParts(Date.now()).date;
  const from = validDate(url.searchParams.get('from')) || today;
  const to = validDate(url.searchParams.get('to')) || addDays(today, BOOK_AHEAD_DAYS);
  const { results } = await env.DB.prepare(
    `SELECT date, hour FROM bookings WHERE kind = 'session' AND date BETWEEN ? AND ? AND hour IS NOT NULL
     AND (status IN ('claimed', 'paid') OR (status = 'held' AND hold_until > ?))`
  ).bind(from, to, Date.now()).all();
  return json({
    workDays: WORK_DAYS, hours: HOURS, today, lastDay: addDays(today, BOOK_AHEAD_DAYS),
    taken: results.map(r => `${r.date} ${r.hour}`),
  });
}

async function publicWorkshops(env) {
  const today = ilParts(Date.now()).date;
  const { results } = await env.DB.prepare(
    `SELECT w.id, w.cohort, w.title, w.date, w.start, w.end, w.place, w.price, w.capacity,
       (SELECT COUNT(*) FROM bookings b WHERE b.workshop_id = w.id AND (b.status IN ('claimed', 'paid') OR (b.status = 'held' AND b.hold_until > ?))) AS taken
     FROM workshops w WHERE w.active = 1 AND w.date >= ? ORDER BY w.date`
  ).bind(Date.now(), today).all();
  // The WhatsApp link is never public: it is emailed only after Lital confirms the payment.
  return json(results.map(w => ({ ...w, left: Math.max(0, w.capacity - w.taken) })));
}

async function createBooking(req, env) {
  await expireHolds(env);
  const b = await body(req);
  const name = text(b.name, 2, 60, 'name');
  const phone = String(b.phone || '').replace(/[\s-]/g, '');
  if (!/^0\d{8,9}$/.test(phone)) bad('phone');
  const email = String(b.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) bad('email');
  const now = Date.now();
  let rec;

  if (b.kind === 'session') {
    const svc = SERVICES[b.service];
    if (!svc) bad('service');
    const product = b.product === 'pack' ? 'pack' : 'single';
    const amount = svc.prices[product];
    if (!amount) bad('product');
    const personal = product === 'pack' && b.packMode === 'personal';
    let date = null, hour = null;
    if (!personal) {
      date = validDate(b.date);
      hour = Number(b.hour);
      if (!slotBookable(date, hour, now)) bad('slot');
    }
    rec = { kind: 'session', service: b.service, product, place: b.place === 'zoom' ? 'zoom' : 'clinic',
      pack_mode: product === 'pack' ? (personal ? 'personal' : 'calendar') : null, date, hour, workshop_id: null, amount };
  } else if (b.kind === 'workshop') {
    const w = await env.DB.prepare('SELECT * FROM workshops WHERE id = ? AND active = 1').bind(Number(b.workshopId)).first();
    if (!w || w.date < ilParts(now).date) bad('workshop');
    const { n } = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM bookings WHERE workshop_id = ? AND (status IN ('claimed', 'paid') OR (status = 'held' AND hold_until > ?))`
    ).bind(w.id, now).first();
    if (n >= w.capacity) throw new HttpError(409, 'full');
    rec = { kind: 'workshop', service: 'workshop', product: null, place: null, pack_mode: null, date: w.date, hour: null, workshop_id: w.id, amount: w.price };
  } else if (b.kind === 'question') {
    rec = { kind: 'question', service: 'numerology-question', product: null, place: null, pack_mode: null, date: null, hour: null, workshop_id: null, amount: QUESTION_PRICE };
  } else bad('kind');

  const token = crypto.randomUUID();
  const hold = holdUntil(now);
  let id;
  try {
    const r = await env.DB.prepare(
      `INSERT INTO bookings (token, kind, service, product, place, pack_mode, date, hour, workshop_id, amount, name, phone, email, hold_until, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    ).bind(token, rec.kind, rec.service, rec.product, rec.place, rec.pack_mode, rec.date, rec.hour, rec.workshop_id, rec.amount, name, phone, email, hold, now).first();
    id = r.id;
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) throw new HttpError(409, 'taken');
    throw e;
  }
  return json({ id, token, holdUntil: hold, amount: rec.amount }, 201);
}

async function claimBooking(req, env, ctx, id) {
  const { token } = await body(req);
  const now = Date.now();
  const r = await env.DB.prepare(
    `UPDATE bookings SET status = 'claimed', claimed_at = ? WHERE id = ? AND token = ? AND status = 'held' AND hold_until > ?`
  ).bind(now, id, String(token || ''), now).run();
  if (!r.meta.changes) {
    const row = await env.DB.prepare('SELECT status FROM bookings WHERE id = ? AND token = ?').bind(id, String(token || '')).first();
    if (!row) throw new HttpError(404, 'not found');
    if (row.status !== 'claimed' && row.status !== 'paid') throw new HttpError(410, 'expired');
    return json({ ok: true });
  }
  const row = await bookingWithWorkshop(env, id);
  ctx.waitUntil(sendMail(env, env.LITAL_EMAIL, `הזמנה חדשה ממתינה לאישור: ${row.name}`,
    mailLayout(`<p>${esc(row.name)} דיווחה שהעבירה <b>${row.amount} ₪</b> בביט.</p><p>${esc(describe(row))}</p>
      <p>טלפון: ${esc(row.phone)} · מייל: ${esc(row.email)}</p>
      <p>אחרי שבדקת שהכסף הגיע, אשרי בעמוד הניהול: <a href="${env.SITE_URL}/admin/">${env.SITE_URL}/admin/</a></p>`)));
  return json({ ok: true });
}

// ---------- admin ----------

async function login(req, env) {
  const { password } = await body(req);
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) throw new HttpError(500, 'admin not configured');
  if (!(await safeEqual(String(password || ''), env.ADMIN_PASSWORD, env.SESSION_SECRET))) {
    await new Promise(r => setTimeout(r, 800)); // slow down guessing
    throw new HttpError(401, 'wrong password');
  }
  const exp = Date.now() + ADMIN_SESSION_HOURS * 3600000;
  return json({ token: `${exp}.${await hmac(env.SESSION_SECRET, String(exp))}`, exp });
}

async function requireAdmin(req, env) {
  const t = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
  const [exp, sig] = t.split('.');
  if (!exp || !sig || !env.SESSION_SECRET || Number(exp) < Date.now() || sig !== await hmac(env.SESSION_SECRET, exp)) {
    throw new HttpError(401, 'login required');
  }
}

async function adminBookings(env) {
  await expireHolds(env);
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.kind, b.service, b.product, b.place, b.pack_mode, b.date, b.hour, b.amount, b.name, b.phone, b.email,
       b.status, b.hold_until, b.created_at, b.claimed_at, b.paid_at, b.anonymized, b.workshop_id, w.cohort, w.start AS w_start, w.place AS w_place
     FROM bookings b LEFT JOIN workshops w ON w.id = b.workshop_id
     WHERE b.status != 'expired' ORDER BY b.created_at DESC LIMIT 3000`
  ).all();
  return json(results.map(r => ({ ...r, label: describe(r) })));
}

async function markPaid(env, id) {
  const r = await env.DB.prepare(
    `UPDATE bookings SET status = 'paid', paid_at = ? WHERE id = ? AND status IN ('held', 'claimed')`
  ).bind(Date.now(), id).run();
  if (!r.meta.changes) throw new HttpError(409, 'not pending');
  const row = await bookingWithWorkshop(env, id);
  const sent = await sendMail(env, row.email, confirmationSubject(row), confirmationHtml(row, env));
  return json({ ok: true, emailed: sent });
}

async function cancelBooking(env, id) {
  const r = await env.DB.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = ? AND status IN ${ACTIVE}`).bind(id).run();
  if (!r.meta.changes) throw new HttpError(409, 'not active');
  return json({ ok: true });
}

async function exportCsv(env) {
  const { results } = await env.DB.prepare(
    `SELECT b.*, w.cohort FROM bookings b LEFT JOIN workshops w ON w.id = b.workshop_id
     WHERE b.status != 'expired' ORDER BY COALESCE(b.date, '') DESC, b.created_at DESC`
  ).all();
  const STATUS = { held: 'שמור', claimed: 'ממתין לאישור', paid: 'שולם', cancelled: 'בוטל' };
  const stamp = ms => ms ? ilParts(ms).date + ' ' + String(ilParts(ms).hour).padStart(2, '0') + ':' + String(ilParts(ms).minute).padStart(2, '0') : '';
  const rows = [['מספר', 'מה הוזמן', 'תאריך', 'שעה', 'מקום', 'שם', 'טלפון', 'מייל', 'סכום', 'סטטוס', 'נרשמה', 'שולם']]
    .concat(results.map(r => [r.id, describe(r), r.date || '', r.hour != null ? `${r.hour}:00` : '',
      r.place === 'zoom' ? 'זום' : r.place === 'clinic' ? 'קליניקה' : '', r.name || '(נמחק)', r.phone || '', r.email || '',
      r.amount, STATUS[r.status] || r.status, stamp(r.created_at), stamp(r.paid_at)]));
  const csv = '﻿' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="lital-${ilParts(Date.now()).date}.csv"` } });
}

async function adminWorkshops(env) {
  const { results } = await env.DB.prepare(
    `SELECT w.*, (SELECT COUNT(*) FROM bookings b WHERE b.workshop_id = w.id AND b.status IN ('claimed', 'paid')) AS registered,
       (SELECT COUNT(*) FROM bookings b WHERE b.workshop_id = w.id AND b.status = 'paid') AS paid
     FROM workshops w ORDER BY w.active DESC, w.date`
  ).all();
  return json(results);
}

async function saveWorkshop(req, env, id) {
  const b = await body(req);
  const w = {
    cohort: text(b.cohort, 2, 60, 'cohort'),
    title: text(b.title || 'מפגש פתיחה: טעימה מכל העולמות', 2, 120, 'title'),
    date: validDate(b.date) || bad('date'),
    start: /^\d{2}:\d{2}$/.test(b.start) ? b.start : bad('start'),
    end: /^\d{2}:\d{2}$/.test(b.end) ? b.end : bad('end'),
    place: text(b.place, 2, 120, 'place'),
    price: Number.isInteger(+b.price) && +b.price >= 0 ? +b.price : bad('price'),
    capacity: Number.isInteger(+b.capacity) && +b.capacity > 0 ? +b.capacity : bad('capacity'),
    wa_link: b.wa_link ? (/^https:\/\/chat\.whatsapp\.com\/\S+$/.test(b.wa_link) ? b.wa_link : bad('wa_link')) : null,
  };
  const vals = [w.cohort, w.title, w.date, w.start, w.end, w.place, w.price, w.capacity, w.wa_link];
  if (id) {
    await env.DB.prepare('UPDATE workshops SET cohort=?, title=?, date=?, start=?, end=?, place=?, price=?, capacity=?, wa_link=? WHERE id=?').bind(...vals, id).run();
    return json({ id });
  }
  const r = await env.DB.prepare('INSERT INTO workshops (cohort, title, date, start, end, place, price, capacity, wa_link) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id').bind(...vals).first();
  return json({ id: r.id }, 201);
}

async function archiveWorkshop(env, id) {
  await env.DB.prepare('UPDATE workshops SET active = 0 WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

// ---------- maintenance ----------

async function expireHolds(env) {
  await env.DB.prepare(`UPDATE bookings SET status = 'expired' WHERE status = 'held' AND hold_until <= ?`).bind(Date.now()).run();
}

async function cleanup(env) {
  await expireHolds(env);
  const now = Date.now();
  const cutoffDate = addMonths(ilParts(now).date, -RETENTION_MONTHS);
  const cutoffMs = ilTimeToMs(cutoffDate, 0);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE bookings SET name = NULL, phone = NULL, email = NULL, anonymized = 1
       WHERE anonymized = 0 AND ((date IS NOT NULL AND date < ?) OR (date IS NULL AND created_at < ?))`
    ).bind(cutoffDate, cutoffMs),
    env.DB.prepare(`DELETE FROM bookings WHERE status = 'expired' AND created_at < ?`).bind(now - 30 * 86400000),
  ]);
}

// ---------- emails ----------

async function sendMail(env, to, subject, html) {
  if (!env.RESEND_API_KEY || !to) return false;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, html, ...(env.LITAL_EMAIL ? { reply_to: env.LITAL_EMAIL } : {}) }),
  });
  if (!r.ok) console.error('email failed', r.status, await r.text());
  return r.ok;
}

function confirmationSubject(r) {
  if (r.kind === 'workshop') return `יאחתי, את בפנים! הלינק ל${r.cohort}`;
  if (r.kind === 'question') return 'קיבלתי את התשלום, מחכה לשאלה שלך';
  return 'לחיי התחלות חדשות! ההזמנה שלך אושרה';
}

function confirmationHtml(r, env) {
  const hi = `<p style="font-size:20px">היי ${esc(r.name)} 💛</p>`;
  const sign = '<p>נתראה,<br>ליטל</p>';
  if (r.kind === 'workshop') {
    return mailLayout(`${hi}<p>איזה כיף שבחרת לשים את השגרה בצד! המקום שלך ב${esc(r.cohort)} שמור.</p>
      <p><b>${esc(r.w_title)}</b><br>📅 ${esc(heDate(r.date))} · ${esc(r.w_start)}–${esc(r.w_end)}<br>📍 ${esc(r.w_place)}</p>
      ${r.wa_link ? `<p>הצעד הבא: להצטרף לקבוצת הוואטסאפ של הקבוצה. שם נמשיך הכל.</p><p><a href="${esc(r.wa_link)}" style="background:#55C4C0;color:#3A3341;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:bold">להצטרפות לקבוצת הוואטסאפ</a></p>` : '<p>הלינק לקבוצת הוואטסאפ יישלח אלייך בקרוב.</p>'}
      <p>מקסימום, תהני. לא ככה? 😉</p>${sign}`);
  }
  if (r.kind === 'question') {
    return mailLayout(`${hi}<p>התשלום התקבל, תודה! עכשיו נשאר רק לשלוח לי את השאלה.</p>
      <p>שלחי מייל ${env.LITAL_EMAIL ? `ל-<a href="mailto:${esc(env.LITAL_EMAIL)}">${esc(env.LITAL_EMAIL)}</a> ` : ''}עם:<br>שם מלא<br>תאריך לידה<br>השאלה שלך</p>${sign}`);
  }
  const when = r.date != null && r.hour != null
    ? `📅 ${esc(heDate(r.date))} בשעה ${r.hour}:00<br>📍 ${r.place === 'zoom' ? 'בזום (הקישור יישלח לפני המפגש)' : 'בקליניקה בכפר חיטים'}`
    : 'אשלח לך בקרוב קישור אישי ליומן, לקביעת המפגשים.';
  return mailLayout(`${hi}<p>התשלום התקבל, וההזמנה שלך אושרה.</p><p><b>${esc(describe(r))}</b><br>${when}</p>
    <p>צריכה לשנות או לבטל? אפשר עד 24 שעות לפני המפגש, בהודעה בוואטסאפ: 052-915-4321.</p>${sign}`);
}

function mailLayout(inner) {
  return `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:16px;line-height:1.6;color:#3A3341;background:#F3EADD;padding:24px">
    <div style="max-width:520px;margin:auto;background:#FCF8F2;border-radius:16px;padding:24px">${inner}</div></div>`;
}

function describe(r) {
  if (r.kind === 'workshop') return `סדנה · ${r.cohort || ''}`.trim();
  if (r.kind === 'question') return 'שאלה בנומרולוגיה';
  const svc = SERVICES[r.service]?.name || r.service;
  const what = r.service.startsWith('numerology') ? 'אבחון וייעוץ, 60 דקות' : PRODUCT_NAMES[r.product] || '';
  return `${svc} · ${what}`;
}

async function bookingWithWorkshop(env, id) {
  return env.DB.prepare(
    `SELECT b.*, w.cohort, w.title AS w_title, w.start AS w_start, w.end AS w_end, w.place AS w_place, w.wa_link
     FROM bookings b LEFT JOIN workshops w ON w.id = b.workshop_id WHERE b.id = ?`
  ).bind(id).first();
}

// ---------- time (all business rules use Israel time) ----------

function ilParts(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

function ilOffsetMs(ms) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' })
    .formatToParts(new Date(ms)).find(x => x.type === 'timeZoneName').value; // e.g. "GMT+2"
  const m = name.match(/GMT([+-])(\d+)(?::(\d+))?/);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) * 60000 : 0;
}

function ilTimeToMs(date, hour, minute = 0) {
  const asUtc = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), hour, minute);
  return asUtc - ilOffsetMs(asUtc - ilOffsetMs(asUtc));
}

// 15 minutes between 9:00 and 23:00; a booking made at night is held until 10:00 the next morning.
function holdUntil(now) {
  const { date, hour } = ilParts(now);
  if (hour >= 9 && hour < 23) return now + HOLD_MINUTES * 60000;
  return ilTimeToMs(hour >= 23 ? addDays(date, 1) : date, 10);
}

function slotBookable(date, hour, now) {
  if (!date || !HOURS.includes(hour)) return false;
  if (!WORK_DAYS.includes(new Date(date + 'T00:00:00Z').getUTCDay())) return false;
  const today = ilParts(now).date;
  return date > today && date <= addDays(today, BOOK_AHEAD_DAYS);
}

function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
function addMonths(date, n) {
  const d = new Date(date + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10);
}
function heDate(date) {
  return new Date(date + 'T12:00:00Z').toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}

// ---------- helpers ----------

function validDate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v + 'T00:00:00Z')) ? v : null;
}
function text(v, min, max, field) {
  const s = String(v ?? '').trim();
  return s.length >= min && s.length <= max ? s : bad(field);
}
async function body(req) {
  try { return await req.json(); } catch { bad('json'); }
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return allowed.includes(origin)
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', Vary: 'Origin' }
    : { Vary: 'Origin' };
}
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function safeEqual(a, b, secret) {
  return (await hmac(secret, a)) === (await hmac(secret, b));
}
