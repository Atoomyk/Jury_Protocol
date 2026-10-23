'use strict';

function nowIso() {
  return new Date().toISOString();
}

function getAdminByLogin(db, login) {
  return db.prepare('SELECT id, login, password_hash FROM admin_users WHERE login = ?').get(login) || null;
}

function getAdminById(db, id) {
  return db.prepare('SELECT id, login, password_hash FROM admin_users WHERE id = ?').get(id) || null;
}

function countAdmins(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM admin_users').get().n;
}

function createAdmin(db, login, passwordHash) {
  const ts = nowIso();
  const info = db.prepare(`
    INSERT INTO admin_users (login, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(login, passwordHash, ts, ts);
  return Number(info.lastInsertRowid);
}

function updatePasswordHash(db, id, passwordHash) {
  db.prepare('UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .run(passwordHash, nowIso(), id);
}

module.exports = {
  getAdminByLogin,
  getAdminById,
  countAdmins,
  createAdmin,
  updatePasswordHash,
};
