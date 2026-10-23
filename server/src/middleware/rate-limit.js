'use strict';

const rateLimit = require('express-rate-limit');

// Лимит только на неудачные попытки: успешный вход не расходует окно.
// Ключ — IP клиента (req.ip с учётом trust proxy).
function createLoginLimiter(config) {
  return rateLimit({
    windowMs: config.loginWindowMinutes * 60 * 1000,
    limit: config.loginMaxAttempts,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: 'too_many_attempts', message: 'Слишком много попыток входа. Попробуйте позже.' },
  });
}

module.exports = { createLoginLimiter };
