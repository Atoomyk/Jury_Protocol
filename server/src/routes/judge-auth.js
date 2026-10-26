'use strict';

const express = require('express');
const invitations = require('../db/invitations');
const devices = require('../db/devices');
const judgesDb = require('../db/judges');
const { bumpRevision } = require('../services/revision');
const { requireObjectBody, ValidationError } = require('../middleware/validation');
const { HttpError } = require('../utils/http-error');

function createJudgeAuthRouter({ db, competitionId }) {
  const router = express.Router();

  // POST /api/v1/judge/auth { token } — одноразовый вход по QR.
  // Возвращает постоянный токен устройства; он хранится только на клиенте.
  router.post('/', (req, res) => {
    const body = requireObjectBody(req);
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) throw new ValidationError('Поле token обязательно');

    const invitation = invitations.findInvitationByToken(db, token);
    if (!invitation) {
      throw new HttpError(401, 'invalid_token', 'Приглашение недействительно');
    }
    if (invitation.revoked_at) {
      throw new HttpError(401, 'token_revoked', 'Приглашение отозвано. Попросите администратора перевыпустить QR');
    }
    if (invitation.used_at) {
      throw new HttpError(409, 'token_used', 'Приглашение уже использовано на другом устройстве');
    }
    if (Date.parse(invitation.expires_at) <= Date.now()) {
      throw new HttpError(401, 'token_expired', 'Срок действия приглашения истёк');
    }

    const judge = judgesDb.getJudge(db, competitionId, invitation.judge_id);
    if (!judge) throw new HttpError(404, 'not_found', 'Судья не найден');

    if (devices.findActiveDevice(db, judge.id)) {
      throw new HttpError(
        409,
        'device_already_bound',
        'К судье уже привязано устройство. Администратор должен перевыпустить QR'
      );
    }

    let deviceToken;
    db.transaction(() => {
      // Защита от гонки: приглашение помечается использованным атомарно.
      if (!invitations.markInvitationUsed(db, invitation.id)) {
        throw new HttpError(409, 'token_used', 'Приглашение уже использовано на другом устройстве');
      }
      deviceToken = devices.createDevice(db, judge.id).token;
      bumpRevision(db);
    })();

    res.status(201).json({
      deviceToken,
      judge: { id: judge.id, fullName: judge.fullName },
      expiresAt: invitation.expires_at,
    });
  });

  return router;
}

module.exports = { createJudgeAuthRouter };
