'use strict';

const express = require('express');
const { getAdminByLogin, getAdminById, updatePasswordHash } = require('../db/admins');
const {
  setSessionCookie,
  clearSessionCookie,
  createAdminSession,
  rotateCsrf,
  deleteSession,
  deleteAdminSessionsExcept,
  requireAdmin,
  requireCsrf,
} = require('../middleware/auth');
const { requireObjectBody, readString, readPassword } = require('../middleware/validation');
const { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } = require('../utils/crypto');

// Хеш-заглушка для выравнивания времени ответа, если логина нет.
// Вычисляется лениво, один раз на процесс.
let dummyHashPromise = null;
function dummyHash() {
  if (!dummyHashPromise) dummyHashPromise = hashPassword('dummy-password-for-timing-only');
  return dummyHashPromise;
}

function createAdminAuthRouter({ db, config, loginLimiter }) {
  const router = express.Router();

  // POST /api/v1/admin/auth/login
  router.post('/login', loginLimiter, async (req, res, next) => {
    try {
      const body = requireObjectBody(req);
      const login = readString(body, 'login', { min: 1, max: 100 });
      const password = readPassword(body, 'password', { min: 1, max: 1024 });

      const admin = getAdminByLogin(db, login);
      const hash = admin ? admin.password_hash : await dummyHash();
      const ok = await verifyPassword(hash, password);
      if (!admin || !ok) {
        return res.status(401).json({ error: 'invalid_credentials', message: 'Неверный логин или пароль' });
      }

      const session = createAdminSession(db, admin.id, config);
      setSessionCookie(res, session.token, config);
      return res.status(200).json({
        ok: true,
        login: admin.login,
        csrfToken: session.csrf,
        expiresAt: session.expiresAt,
      });
    } catch (err) {
      return next(err);
    }
  });

  const adminAuth = requireAdmin(db, config);

  // POST /api/v1/admin/auth/logout
  router.post('/logout', adminAuth, requireCsrf, (req, res) => {
    deleteSession(db, req.admin.sessionId);
    clearSessionCookie(res);
    return res.status(200).json({ ok: true });
  });

  // GET /api/v1/admin/auth/session
  // Каждый запрос ротирует CSRF-токен; клиент должен брать новый из ответа.
  router.get('/session', adminAuth, (req, res) => {
    const csrf = rotateCsrf(db, req.admin.sessionId);
    return res.status(200).json({
      ok: true,
      login: req.admin.login,
      csrfToken: csrf,
      expiresAt: req.admin.expiresAt,
    });
  });

  // POST /api/v1/admin/auth/password { currentPassword, newPassword }
  router.post('/password', adminAuth, requireCsrf, async (req, res, next) => {
    try {
      const body = requireObjectBody(req);
      const currentPassword = readPassword(body, 'currentPassword', { min: 1, max: 1024 });
      const newPassword = readPassword(body, 'newPassword', { min: MIN_PASSWORD_LENGTH, max: 1024 });

      const admin = getAdminById(db, req.admin.id);
      if (!admin) {
        return res.status(401).json({ error: 'unauthorized', message: 'Требуется вход администратора' });
      }
      const ok = await verifyPassword(admin.password_hash, currentPassword);
      if (!ok) {
        return res.status(403).json({ error: 'invalid_password', message: 'Текущий пароль неверен' });
      }
      if (currentPassword === newPassword) {
        return res.status(400).json({ error: 'same_password', message: 'Новый пароль совпадает с текущим' });
      }

      const newHash = await hashPassword(newPassword);
      updatePasswordHash(db, admin.id, newHash);
      // Остальные сессии этого администратора закрываем; текущая остаётся.
      deleteAdminSessionsExcept(db, admin.id, req.admin.sessionId);
      const csrf = rotateCsrf(db, req.admin.sessionId);
      return res.status(200).json({ ok: true, csrfToken: csrf });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

module.exports = { createAdminAuthRouter };
