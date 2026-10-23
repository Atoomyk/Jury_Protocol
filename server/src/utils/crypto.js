'use strict';

const crypto = require('node:crypto');
const argon2 = require('argon2');

// Параметры Argon2id. Не понижать без обсуждения.
const ARGON2_OPTIONS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
});

const MIN_PASSWORD_LENGTH = 12;

async function hashPassword(password) {
  return argon2.hash(password, ARGON2_OPTIONS);
}

async function verifyPassword(hash, password) {
  if (typeof hash !== 'string' || typeof password !== 'string') return false;
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

// Случайный токен в base64url, 256 бит по умолчанию.
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

// Хеш токена для хранения в БД (сам токен в БД не пишется).
function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

// Сравнение строк без утечки по времени.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

module.exports = {
  ARGON2_OPTIONS,
  MIN_PASSWORD_LENGTH,
  hashPassword,
  verifyPassword,
  randomToken,
  sha256Hex,
  safeEqual,
};
