# Сайт-приглашение — Евгений & Юлия

Статичная страница приглашения (`index.html`) + Node.js-бэкенд на Express с базой SQLite.
Ответы гостей (RSVP) сохраняются в базу и дублируются на email.

## Запуск

```bash
npm install
cp .env.example .env   # заполните настройки почты и ADMIN_TOKEN
npm start
```

Откройте http://localhost:3000

Для разработки с авто-перезапуском:

```bash
npm run dev
```

## Как это работает

- `index.html` — приглашение и форма RSVP. Форма шлёт `POST /api/rsvp` (JSON).
- `server.js` — Express:
  - отдаёт `index.html` как статику;
  - `POST /api/rsvp` — валидирует и пишет ответ в SQLite (`rsvp.db`), затем шлёт письмо;
  - `GET /api/admin/rsvp?token=ВАШ_ТОКЕН` — все ответы + сводка (приду/не приду, число гостей).

## Настройка почты (.env)

Письмо приходит при каждом новом ответе. Если `SMTP_HOST` не задан — письма не шлются,
ответы всё равно сохраняются в базу.

Пример для Яндекс.Почты:

```
SMTP_HOST=smtp.yandex.ru
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your@yandex.ru
SMTP_PASS=пароль-приложения
MAIL_FROM=your@yandex.ru
MAIL_TO=куда-слать@example.com
```

Для Gmail используйте `smtp.gmail.com`, порт `465`, и пароль приложения
(обычный пароль не подойдёт при включённой 2FA).

## Просмотр ответов

```bash
curl "http://localhost:3000/api/admin/rsvp?token=ВАШ_ADMIN_TOKEN"
```

База — обычный файл `rsvp.db`, его можно открыть любым SQLite-клиентом.

## Структура данных (таблица `rsvp`)

| поле          | описание                          |
|---------------|-----------------------------------|
| name          | имя гостя                         |
| attending     | `yes` / `no`                      |
| plusone       | `yes` / `no`                      |
| plusone_name  | имя спутника                      |
| food          | предпочтения по еде (через запятую)|
| drink         | предпочтения по напиткам          |
| allergies     | аллергии / пожелания              |
| message       | пожелание молодожёнам             |
| created_at    | дата/время ответа                 |
