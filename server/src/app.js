'use strict';

const path = require('path');
const express = require('express');
const { createLoginLimiter, createJudgeAuthLimiter } = require('./middleware/rate-limit');
const { createAdminAuthRouter } = require('./routes/admin-auth');
const { ValidationError } = require('./middleware/validation');
const { HttpError } = require('./utils/http-error');
const { requireAdmin, requireCsrf } = require('./middleware/auth');
const { requireJudge } = require('./middleware/judge-auth');
const { ensureCompetition } = require('./db/competitions');
const { createBlocksRouter } = require('./routes/admin-blocks');
const { createJudgesRouter } = require('./routes/admin-judges');
const { createParticipantsRouter } = require('./routes/admin-participants');
const { createInvitationsRouter } = require('./routes/admin-invitations');
const { createJudgeAuthRouter } = require('./routes/judge-auth');
const { createJudgeSyncRouter } = require('./routes/judge-sync');
const { createAdminStateRouter } = require('./routes/admin-state');

// Заголовки безопасности вручную (без helmet).
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  );
  if (req.secure || req.get('x-forwarded-proto') === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  // API не кэшируем.
  res.setHeader('Cache-Control', 'no-store');
  next();
}

function createApp({ db, config }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(securityHeaders);
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/v1/health', (req, res) => {
    res.status(200).json({ ok: true });
  });

  const loginLimiter = createLoginLimiter(config);
  app.use('/api/v1/admin/auth', createAdminAuthRouter({ db, config, loginLimiter }));

  // Данные конкурса: только с сессией администратора; изменяющие методы — с CSRF.
  const competitionId = ensureCompetition(db);
  const adminAuth = requireAdmin(db, config);
  const guard = [adminAuth, requireCsrf];
  app.use('/api/v1/admin/blocks', ...guard, createBlocksRouter({ db, competitionId }));
  app.use('/api/v1/admin/judges', ...guard, createJudgesRouter({ db, competitionId }));
  app.use('/api/v1/admin/participants', ...guard, createParticipantsRouter({ db, competitionId }));
  app.use('/api/v1/admin/invitations', ...guard, createInvitationsRouter({ db, config, competitionId }));
  app.use('/api/v1/admin/state', ...guard, createAdminStateRouter({ db, competitionId }));

  // Клиент судьи: вход по одноразовому токену и синхронизация по токену устройства.
  app.use('/api/v1/judge/auth', createJudgeAuthLimiter(config), createJudgeAuthRouter({ db, competitionId }));
  app.use('/api/v1/judge', requireJudge(db), createJudgeSyncRouter({ db, competitionId }));

  // Клиентские файлы раздаёт сам Express: cookie и CSRF требуют одного origin.
  // Наружу попадают только файлы оболочки; каталог server/ и база данных закрыты.
  const clientRoot = path.join(__dirname, '..', '..');
  const clientFiles = {
    '/index.html': 'text/html; charset=utf-8',
    '/app.js': 'text/javascript; charset=utf-8',
    '/style.css': 'text/css; charset=utf-8',
    '/manifest.json': 'application/manifest+json; charset=utf-8',
    '/service-worker.js': 'text/javascript; charset=utf-8',
  };
  app.get('/', (req, res) => res.sendFile(path.join(clientRoot, 'index.html')));
  for (const [route, type] of Object.entries(clientFiles)) {
    app.get(route, (req, res) => {
      res.setHeader('Content-Type', type);
      res.sendFile(path.join(clientRoot, route.slice(1)));
    });
  }
  app.use('/client', express.static(path.join(clientRoot, 'client'), { index: false }));
  app.use('/shared', express.static(path.join(clientRoot, 'shared'), { index: false }));
  app.use('/assets', express.static(path.join(clientRoot, 'assets'), { index: false }));

  // Неизвестный API-маршрут — JSON 404.
  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'not_found', message: 'Маршрут не найден' });
  });

  // Ошибки: без стека и деталей наружу.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: 'validation', message: err.message });
    }
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.code, message: err.message });
    }
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'bad_json', message: 'Некорректный JSON' });
    }
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'too_large', message: 'Слишком большой запрос' });
    }
    console.error('[server] unhandled error:', err && err.name ? err.name : 'Error');
    return res.status(500).json({ error: 'internal', message: 'Внутренняя ошибка сервера' });
  });

  return app;
}

module.exports = { createApp };
