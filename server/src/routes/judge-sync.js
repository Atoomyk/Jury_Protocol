'use strict';

const express = require('express');
const participantsDb = require('../db/participants');
const scoresDb = require('../db/scores');
const { bumpRevision, getRevision } = require('../services/revision');
const { buildJudgeState } = require('../services/state');
const { requireObjectBody, ValidationError } = require('../middleware/validation');
const { readInt } = require('../utils/parse');
const { HttpError } = require('../utils/http-error');
const { getCriteria } = require('../../../shared/scoring.js');

const CHANGE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const COMMENT_MAX = 2000;
const BATCH_MAX = 100;

// Проверяет criteria по набору критериев жанра участника.
// Все критерии обязательны, каждый — целое от 1 до 10, лишних ключей быть не должно.
function readCriteria(participant, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('Поле criteria должно быть объектом');
  }
  const expected = getCriteria(participant);
  const keys = new Set(expected.map(c => c.key));
  const result = {};
  for (const key of keys) {
    const value = raw[key];
    if (!Number.isInteger(value) || value < 1 || value > 10) {
      throw new ValidationError(`Критерий ${key}: ожидается целое число от 1 до 10`);
    }
    result[key] = value;
  }
  for (const key of Object.keys(raw)) {
    if (!keys.has(key)) {
      throw new ValidationError(`Неизвестный критерий: ${key}`);
    }
  }
  return result;
}

function readComment(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new ValidationError('Поле comment должно быть строкой');
  const trimmed = raw.trim();
  if (trimmed.length > COMMENT_MAX) {
    throw new ValidationError(`Комментарий: максимум ${COMMENT_MAX} символов`);
  }
  return trimmed === '' ? null : trimmed;
}

function createJudgeSyncRouter({ db, competitionId }) {
  const router = express.Router();

  // GET /api/v1/judge/state?since=<revision>
  // При совпадении ревизии возвращается { changed: false } — экономия трафика.
  router.get('/state', (req, res) => {
    const revision = getRevision(db);
    const since = Number(req.query.since);
    if (Number.isInteger(since) && since === revision) {
      return res.json({ revision, changed: false });
    }
    return res.json({
      revision,
      changed: true,
      state: buildJudgeState(db, req.judge.judgeId, competitionId),
    });
  });

  // GET /api/v1/judge/me — профиль судьи по токену устройства.
  router.get('/me', (req, res) => {
    const row = db.prepare('SELECT id, full_name FROM judges WHERE id = ? AND competition_id = ?')
      .get(req.judge.judgeId, competitionId);
    if (!row) throw new HttpError(404, 'not_found', 'Судья не найден');
    res.json({ judge: { id: row.id, fullName: row.full_name } });
  });

  // POST /api/v1/judge/scores { changes: [ { changeId, participantId, version, criteria, comment } ] }
  // Идемпотентный батч из очереди outbox. Результат по каждому изменению:
  // accepted | duplicate | stale | rejected.
  router.post('/scores', (req, res) => {
    const body = requireObjectBody(req);
    const changes = body.changes;
    if (!Array.isArray(changes) || changes.length === 0) {
      throw new ValidationError('Поле changes должно быть непустым массивом');
    }
    if (changes.length > BATCH_MAX) {
      throw new ValidationError(`Не более ${BATCH_MAX} изменений за запрос`);
    }

    const judgeId = req.judge.judgeId;
    const receivedAt = new Date().toISOString();
    const results = [];
    let accepted = 0;

    db.transaction(() => {
      for (const item of changes) {
        const changeId = typeof item?.changeId === 'string' ? item.changeId.trim() : '';
        if (!CHANGE_ID_RE.test(changeId)) {
          results.push({ changeId: changeId || null, result: 'rejected', error: 'Некорректный changeId' });
          continue;
        }

        // Идемпотентность: повторная отправка того же изменения не создаёт запись.
        const seen = db.prepare('SELECT id FROM score_events WHERE change_id = ?').get(changeId);
        if (seen) {
          results.push({ changeId, result: 'duplicate' });
          continue;
        }

        try {
          const participantId = readInt(item, 'participantId', { min: 1, max: Number.MAX_SAFE_INTEGER });
          const version = readInt(item, 'version', { min: 1, max: 1000000000 });
          const participant = participantsDb.getParticipant(db, competitionId, participantId);
          if (!participant || participant.deleted) {
            throw new ValidationError('Участник не найден');
          }
          const assigned = db.prepare(
            'SELECT 1 AS ok FROM assignments WHERE block_id = ? AND judge_id = ? AND active = 1'
          ).get(participant.blockId, judgeId);
          if (!assigned) {
            throw new HttpError(403, 'not_assigned', 'Судья не назначен на блок этого участника');
          }
          const criteria = readCriteria(participant, item.criteria);
          const comment = readComment(item.comment);

          const { result } = scoresDb.applyChange(db, {
            competitionId, judgeId, participantId, changeId, version, criteria, comment, receivedAt,
          });
          if (result === 'accepted') accepted += 1;
          results.push({ changeId, result });
        } catch (err) {
          if (err instanceof ValidationError) {
            results.push({ changeId, result: 'rejected', error: err.message });
          } else if (err instanceof HttpError) {
            results.push({ changeId, result: 'rejected', error: err.message, code: err.code });
          } else {
            throw err;
          }
        }
      }
      if (accepted > 0) bumpRevision(db);
    })();

    res.json({ receivedAt, results });
  });

  return router;
}

module.exports = { createJudgeSyncRouter, readCriteria, readComment, CHANGE_ID_RE };
