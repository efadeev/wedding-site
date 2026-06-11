import express from 'express';
import Database from 'better-sqlite3';
import nodemailer from 'nodemailer';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
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

// Доверять заголовку X-Forwarded-For только за известным прокси.
// Без этого клиент мог бы подделать X-Forwarded-For и обойти rate-limit.
// TRUST_PROXY: число хопов прокси (напр. 1 за nginx) или 'false' если нет прокси.
const trustProxy = process.env.TRUST_PROXY ?? 'false';
app.set('trust proxy', trustProxy === 'false' ? false : (/^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy));

// Базовые заголовки безопасности
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; script-src 'self'; " +
      "connect-src 'self'; img-src 'self' data:; base-uri 'self'; form-action 'self'; " +
      "object-src 'none'; frame-ancestors 'none'",
  );
  next();
});

app.use(express.json({ limit: '32kb' }));
app.use(express.static(__dirname)); // отдаёт index.html и статику

// простая защита от спама: максимум 5 ответов с одного IP за 10 минут
const rate = new Map();
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 5;
function rateLimited(ip) {
  const now = Date.now();
  const hits = (rate.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  rate.set(ip, hits);
  // Уже достигнут лимит — блокируем и не засчитываем новую попытку,
  // чтобы повторные запросы не продлевали окно блокировки бесконечно.
  if (hits.length >= RATE_MAX) return true;
  hits.push(now);
  return false;
}
// периодическая очистка устаревших записей, чтобы Map не рос бесконечно
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of rate) {
    const fresh = hits.filter((t) => now - t < RATE_WINDOW_MS);
    if (fresh.length) rate.set(ip, fresh);
    else rate.delete(ip);
  }
}, RATE_WINDOW_MS).unref();

function clean(v, max = 500) {
  return String(v ?? '').trim().slice(0, max);
}

app.post('/api/rsvp', (req, res) => {
  const ip = (req.ip || req.socket.remoteAddress || '').trim();
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
    plusone_name: attending === 'yes' && b.plusone === 'yes' ? clean(b.plusone_name, 120) : '',
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

// Постоянное по времени сравнение строк (защита от timing-атак).
// Хэшируем оба значения до фиксированной длины, чтобы не раскрывать
// длину секрета через раннюю проверку длины буферов.
function safeEqual(a, b) {
  const bufA = createHash('sha256').update(String(a)).digest();
  const bufB = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(bufA, bufB);
}

// Просмотр всех ответов (защищён токеном).
// Токен принимается только через заголовок Authorization: Bearer <token>.
// Передача через ?token=... убрана: query-параметры утекают в логи прокси,
// историю браузера и Referer.
app.get('/api/admin/rsvp', (req, res) => {
  const header = req.headers.authorization || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!ADMIN_TOKEN || !safeEqual(provided, ADMIN_TOKEN)) {
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

// Обработчик ошибок: невалидный JSON и прочие сбои middleware
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: 'Некорректный формат запроса.' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: 'Слишком большой запрос.' });
  }
  console.error('Необработанная ошибка:', err.message);
  return res.status(500).json({ ok: false, error: 'Внутренняя ошибка сервера.' });
});

if (!ADMIN_TOKEN) {
  console.warn('ADMIN_TOKEN не задан — эндпоинт /api/admin/rsvp недоступен (всегда 401).');
}

app.listen(PORT, () => {
  console.log(`Сайт-приглашение запущен: http://localhost:${PORT}`);
});
