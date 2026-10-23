'use strict';

const express = require('express');
const { createLoginLimiter } = require('./middleware/rate-limit');
const { createAdminAuthRouter } = require('./routes/admin-auth');
const { ValidationError } = require('./middleware/validation');

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
