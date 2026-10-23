'use strict';

const path = require('node:path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const SERVER_ROOT = path.resolve(__dirname, '..');

function readRequired(env, name) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') {
    throw new Error(`Не задана обязательная переменная окружения ${name}`);
  }
  return String(raw).trim();
}

function readInt(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name}: ожидается целое число от ${min} до ${max}`);
  }
  return n;
}

// Значения не печатаются в ошибках: только имя переменной.
function loadConfig(env = process.env) {
  const publicOriginRaw = readRequired(env, 'PUBLIC_ORIGIN');
  let publicOrigin;
  try {
    publicOrigin = new URL(publicOriginRaw).origin;
  } catch {
    throw new Error('PUBLIC_ORIGIN: некорректный URL');
  }

  const databasePath = path.resolve(SERVER_ROOT, readRequired(env, 'DATABASE_PATH'));

  // Срок должен содержать явный часовой пояс (например, +03:00 или Z).
  const invitationRaw = readRequired(env, 'INVITATION_EXPIRES_AT');
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(invitationRaw)) {
    throw new Error('INVITATION_EXPIRES_AT: нужен явный часовой пояс, например +03:00');
  }
  const invitationExpiresAt = new Date(invitationRaw);
  if (Number.isNaN(invitationExpiresAt.getTime())) {
    throw new Error('INVITATION_EXPIRES_AT: некорректная дата');
  }

  return Object.freeze({
    nodeEnv: (env.NODE_ENV || 'development').trim(),
    port: readInt(env, 'PORT', 3000, 1, 65535),
    publicOrigin,
    databasePath,
    invitationExpiresAt: invitationExpiresAt.toISOString(),
    sessionTtlHours: readInt(env, 'SESSION_TTL_HOURS', 12, 1, 720),
    loginMaxAttempts: readInt(env, 'LOGIN_MAX_ATTEMPTS', 5, 1, 100),
    loginWindowMinutes: readInt(env, 'LOGIN_WINDOW_MINUTES', 15, 1, 1440),
    trustProxy: readInt(env, 'TRUST_PROXY', 0, 0, 5),
  });
}

module.exports = { loadConfig, SERVER_ROOT };
