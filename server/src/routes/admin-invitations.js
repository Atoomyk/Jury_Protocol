'use strict';

const express = require('express');
const judgesDb = require('../db/judges');
const invitations = require('../db/invitations');
const devices = require('../db/devices');
const { bumpRevision } = require('../services/revision');
const { HttpError } = require('../utils/http-error');
const { requireObjectBody, ValidationError } = require('../middleware/validation');
const { readIdList, parseId } = require('../utils/parse');

// QR-картинка — необязательная возможность. Если пакет qrcode не установлен,
// API возвращает только token и url, а клиент показывает ссылку/ручной ввод.
let QRCode = null;
try { QRCode = require('qrcode'); } catch { QRCode = null; }

async function renderQrSvg(url) {
  if (!QRCode) return null;
  try {
    return await QRCode.toString(url, {
      type: 'svg',
      margin: 1,
      width: 256,
      errorCorrectionLevel: 'M',
    });
  } catch {
    return null;
  }
}

function buildJoinUrl(publicOrigin, token) {
  return `${publicOrigin}/?judge_token=${encodeURIComponent(token)}`;
}

function createInvitationsRouter({ db, config, competitionId }) {
  const router = express.Router();

  // GET /api/v1/admin/invitations — статус приглашений и устройств по судьям.
  router.get('/', (req, res) => {
    const activeInv = new Map(
      db.prepare(`
        SELECT judge_id, created_at, expires_at FROM judge_invitations
        WHERE revoked_at IS NULL AND used_at IS NULL
      `).all().map(r => [r.judge_id, r])
    );
    const activeDev = new Map(
      db.prepare("SELECT judge_id, activated_at FROM judge_devices WHERE status = 'active'")
        .all().map(r => [r.judge_id, r])
    );

    res.json({
      expiresAt: config.invitationExpiresAt,
      judges: judgesDb.listJudges(db, competitionId).map(j => {
        const inv = activeInv.get(j.id);
        const dev = activeDev.get(j.id);
        return {
          ...j,
          deviceBound: Boolean(dev),
          deviceActivatedAt: dev ? dev.activated_at : null,
          invitationIssuedAt: inv ? inv.created_at : null,
          invitationExpiresAt: inv ? inv.expires_at : null,
        };
      }),
    });
  });

  // POST /api/v1/admin/invitations { judgeIds: [...] }
  // Выпуск или перевыпуск QR: активные приглашения и активное устройство отзываются.
  router.post('/', async (req, res, next) => {
    try {
      const body = requireObjectBody(req);
      const judgeIds = readIdList(body, 'judgeIds', { min: 1, max: 50 });
      const found = judgesDb.findExistingJudgeIds(db, competitionId, judgeIds);
      if (found.size !== judgeIds.length) {
        throw new ValidationError('Один из судей не найден в конкурсе');
      }

      const issued = [];
      db.transaction(() => {
        for (const judgeId of judgeIds) {
          invitations.revokeActiveInvitations(db, judgeId);
          devices.revokeActiveDevice(db, judgeId);
          issued.push({ judgeId, ...invitations.createInvitation(db, judgeId, config.invitationExpiresAt) });
        }
        bumpRevision(db);
      })();

      const judges = judgesDb.listJudges(db, competitionId);
      const byId = new Map(judges.map(j => [j.id, j]));
      const invitationsOut = await Promise.all(issued.map(async inv => {
        const url = buildJoinUrl(config.publicOrigin, inv.token);
        return {
          judgeId: inv.judgeId,
          fullName: byId.get(inv.judgeId).fullName,
          token: inv.token,
          url,
          expiresAt: inv.expiresAt,
          qrSvg: await renderQrSvg(url),
        };
      }));
      res.status(201).json({ invitations: invitationsOut });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/admin/invitations/:judgeId/revoke — отзыв без выпуска нового.
  router.post('/:judgeId/revoke', (req, res) => {
    const judgeId = parseId(req.params.judgeId);
    const judge = judgesDb.getJudge(db, competitionId, judgeId);
    if (!judge) throw new HttpError(404, 'not_found', 'Судья не найден');
    db.transaction(() => {
      invitations.revokeActiveInvitations(db, judgeId);
      devices.revokeActiveDevice(db, judgeId);
      bumpRevision(db);
    })();
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createInvitationsRouter, buildJoinUrl };
