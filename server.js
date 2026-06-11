import express from 'express';
import Database from 'better-sqlite3';
import nodemailer from 'nodemailer';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || join(__dirname, 'rsvp.db');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

/* ----------------------------- Database ----------------------------- */
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS rsvp (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL,
    attending    TEXT    NOT NULL,           -- 'yes' | 'no'
    plusone      TEXT    NOT NULL DEFAULT 'no',
    plusone_name TEXT    DEFAULT '',
    food         TEXT    DEFAULT '',         -- comma-separated
    drink        TEXT    DEFAULT '',         -- comma-separated
    allergies    TEXT    DEFAULT '',
    message      TEXT    DEFAULT '',
    ip           TEXT    DEFAULT '',
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

const insertStmt = db.prepare(`
  INSERT INTO rsvp (name, attending, plusone, plusone_name, food, drink, allergies, message, ip)
  VALUES (@name, @attending, @plusone, @plusone_name, @food, @drink, @allergies, @message, @ip)
`);

/* ------------------------------ Mailer ------------------------------ */
let transporter = null;
if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  transporter.verify().then(
    () => console.log('SMTP: подключение к почтовому серверу установлено'),
    (err) => console.warn('SMTP: не удалось проверить подключение —', err.message),
  );
} else {
  console.warn('SMTP не настроен (нет SMTP_HOST в .env) — письма отправляться не будут, ответы пишутся только в базу.');
}

function sendNotification(row) {
  if (!transporter || !process.env.MAIL_TO) return;

  const yesNo = row.attending === 'yes' ? 'ПРИДЁТ' : 'НЕ придёт';
  const lines = [
    `Новый ответ на приглашение`,
    `Имя: ${row.name}`,
    `Статус: ${yesNo}`,
  ];
  if (row.attending === 'yes') {
    lines.push(`+1: ${row.plusone === 'yes' ? 'да' + (row.plusone_name ? ` (${row.plusone_name})` : '') : 'нет'}`);
    if (row.food) lines.push(`Еда: ${row.food}`);
    if (row.drink) lines.push(`Напитки: ${row.drink}`);
    if (row.allergies) lines.push(`Аллергии/пожелания: ${row.allergies}`);
  }
  if (row.message) lines.push(`Пожелание: ${row.message}`);
  lines.push(`Время: ${new Date().toLocaleString('ru-RU')}`);

  transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: process.env.MAIL_TO,
    subject: `RSVP: ${row.name} — ${yesNo}`,
    text: lines.join('\n'),
  }).catch((err) => console.error('Ошибка отправки письма:', err.message));
}

/* ------------------------------ Server ------------------------------ */
const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(express.static(__dirname)); // отдаёт index.html и статику

// простая защита от спама: максимум 5 ответов с одного IP за 10 минут
const rate = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const hits = (rate.get(ip) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  rate.set(ip, hits);
  return hits.length > 5;
}

function clean(v, max = 500) {
  return String(v ?? '').trim().slice(0, max);
}

app.post('/api/rsvp', (req, res) => {
  const ip = (req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '').trim();
  if (rateLimited(ip)) {
    return res.status(429).json({ ok: false, error: 'Слишком много запросов. Попробуйте позже.' });
  }

  const b = req.body || {};
  const name = clean(b.name, 120);
  const attending = b.attending === 'yes' ? 'yes' : b.attending === 'no' ? 'no' : '';

  if (!name) return res.status(400).json({ ok: false, error: 'Укажите имя.' });
  if (!attending) return res.status(400).json({ ok: false, error: 'Укажите, придёте ли вы.' });

  const toCsv = (arr) => Array.isArray(arr) ? arr.map((x) => clean(x, 60)).filter(Boolean).join(', ') : clean(arr, 300);

  const row = {
    name,
    attending,
    plusone: attending === 'yes' && b.plusone === 'yes' ? 'yes' : 'no',
    plusone_name: clean(b.plusone_name, 120),
    food: attending === 'yes' ? toCsv(b.food) : '',
    drink: attending === 'yes' ? toCsv(b.drink) : '',
    allergies: attending === 'yes' ? clean(b.allergies, 500) : '',
    message: clean(b.message, 1000),
    ip,
  };

  try {
    const info = insertStmt.run(row);
    sendNotification(row);
    return res.json({ ok: true, id: info.lastInsertRowid });
  } catch (err) {
    console.error('DB error:', err.message);
    return res.status(500).json({ ok: false, error: 'Не удалось сохранить ответ.' });
  }
});

// Просмотр всех ответов (защищён токеном): GET /api/admin/rsvp?token=...
app.get('/api/admin/rsvp', (req, res) => {
  if (!ADMIN_TOKEN || req.query.token !== ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const rows = db.prepare('SELECT * FROM rsvp ORDER BY created_at DESC').all();
  const summary = {
    total: rows.length,
    coming: rows.filter((r) => r.attending === 'yes').length,
    declined: rows.filter((r) => r.attending === 'no').length,
    guests: rows.reduce((n, r) => n + (r.attending === 'yes' ? 1 + (r.plusone === 'yes' ? 1 : 0) : 0), 0),
  };
  res.json({ ok: true, summary, rows });
});

app.listen(PORT, () => {
  console.log(`Сайт-приглашение запущен: http://localhost:${PORT}`);
});
