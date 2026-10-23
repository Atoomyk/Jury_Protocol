'use strict';

const { randomToken, sha256Hex, safeEqual } = require('../utils/crypto');

const ADMIN_COOKIE = 'lz_admin';
const CSRF_HEADER = 'x-csrf-token';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function nowIso() {
  return new Date().toISOString();
}

// Разбор заголовка Cookie без внешних зависимостей.
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function setSessionCookie(res, token, config) {
  const maxAgeSec = config.sessionTtlHours * 3600;
  res.append(
    'Set-Cookie',
    `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/api; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Strict`
  );
}

function clearSessionCookie(res) {
  res.append(
    'Set-Cookie',
    `${ADMIN_COOKIE}=; Path=/api; Max-Age=0; HttpOnly; Secure; SameSite=Strict`
  );
}

// Создаёт сессию. Возвращает токен для cookie и CSRF-токен для тела ответа.
function createAdminSession(db, adminId, config) {
  const token = randomToken(32);
  const csrf = randomToken(32);
  const created = new Date();
  const expires = new Date(created.getTime() + config.sessionTtlHours * 3600 * 1000);
  db.prepare(`
    INSERT INTO admin_sessions (id, admin_id, csrf_hash, created_at, last_seen_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    sha256Hex(token),
    adminId,
    sha256Hex(csrf),
    created.toISOString(),
    created.toISOString(),
    expires.toISOString()
  );
  return { token, csrf, expiresAt: expires.toISOString() };
}

// Заменяет CSRF-токен текущей сессии (вызывается при GET session).
function rotateCsrf(db, sessionId) {
  const csrf = randomToken(32);
  db.prepare('UPDATE admin_sessions SET csrf_hash = ?, last_seen_at = ? WHERE id = ?')
    .run(sha256Hex(csrf), nowIso(), sessionId);
  return csrf;
}

function deleteSession(db, sessionId) {
  db.prepare('DELETE FROM admin_sessions WHERE id = ?').run(sessionId);
}

function deleteAdminSessionsExcept(db, adminId, exceptSessionId) {
  db.prepare('DELETE FROM admin_sessions WHERE admin_id = ? AND id <> ?')
    .run(adminId, exceptSessionId);
}

// Загружает сессию по cookie. Требует действующую сессию, иначе 401.
function requireAdmin(db, config) {
  return function adminAuth(req, res, next) {
    const token = readCookie(req, ADMIN_COOKIE);
    if (!token) return unauthorized(res);

    const sessionId = sha256Hex(token);
    const row = db.prepare(`
      SELECT s.id AS session_id, s.csrf_hash, s.expires_at,
             a.id AS admin_id, a.login
      FROM admin_sessions s
      JOIN admin_users a ON a.id = s.admin_id
      WHERE s.id = ?
    `).get(sessionId);

    if (!row) return unauthorized(res);
    if (Date.parse(row.expires_at) <= Date.now()) {
      deleteSession(db, row.session_id);
      clearSessionCookie(res);
      return unauthorized(res);
    }

    db.prepare('UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?')
      .run(nowIso(), row.session_id);

    req.admin = {
      id: row.admin_id,
      login: row.login,
      sessionId: row.session_id,
      csrfHash: row.csrf_hash,
      expiresAt: row.expires_at,
    };
    next();
  };
}

// Для POST/PUT/PATCH/DELETE требует заголовок X-CSRF-Token, совпадающий с сессией.
function requireCsrf(req, res, next) {
  if (!UNSAFE_METHODS.has(req.method)) return next();
  if (!req.admin) return unauthorized(res);
  const sent = req.get(CSRF_HEADER);
  if (!sent || !safeEqual(sha256Hex(sent), req.admin.csrfHash)) {
    return res.status(403).json({ error: 'csrf_failed', message: 'Неверный CSRF-токен' });
  }
  next();
}

function unauthorized(res) {
  return res.status(401).json({ error: 'unauthorized', message: 'Требуется вход администратора' });
}

module.exports = {
  ADMIN_COOKIE,
  CSRF_HEADER,
  readCookie,
  setSessionCookie,
  clearSessionCookie,
  createAdminSession,
  rotateCsrf,
  deleteSession,
  deleteAdminSessionsExcept,
  requireAdmin,
  requireCsrf,
};
