'use strict';

const devices = require('../db/devices');

// Токен устройства передаётся в заголовке Authorization: Bearer <token>.
// В БД хранится только хеш; сам токен — у клиента в IndexedDB.
function readBearer(req) {
  const header = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  return m ? m[1].trim() : '';
}

function requireJudge(db) {
  return function judgeAuth(req, res, next) {
    const token = readBearer(req);
    if (!token) return unauthorized(res);
    const device = devices.findDeviceByToken(db, token);
    if (!device || device.status !== 'active') return unauthorized(res);
    req.judge = { deviceId: device.id, judgeId: device.judge_id };
    next();
  };
}

function unauthorized(res) {
  return res.status(401).json({
    error: 'unauthorized',
    message: 'Требуется действующий токен устройства судьи',
  });
}

module.exports = { requireJudge, readBearer };
