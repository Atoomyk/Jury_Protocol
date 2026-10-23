'use strict';

const express = require('express');
const judges = require('../db/judges');
const { bumpRevision } = require('../services/revision');
const { HttpError } = require('../utils/http-error');
const { requireObjectBody, readString } = require('../middleware/validation');
const { parseId } = require('../utils/parse');

function createJudgesRouter({ db, competitionId }) {
  const router = express.Router();

  function requireJudge(id) {
    const judge = judges.getJudge(db, competitionId, id);
    if (!judge) throw new HttpError(404, 'not_found', 'Судья не найден');
    return judge;
  }

  // GET /api/v1/admin/judges
  router.get('/', (req, res) => {
    res.json({ judges: judges.listJudges(db, competitionId) });
  });

  // POST /api/v1/admin/judges { fullName }
  router.post('/', (req, res) => {
    const body = requireObjectBody(req);
    const fullName = readString(body, 'fullName', { max: 150 });
    const id = db.transaction(() => {
      const newId = judges.insertJudge(db, competitionId, fullName);
      bumpRevision(db);
      return newId;
    })();
    res.status(201).json({ judge: requireJudge(id) });
  });

  // PATCH /api/v1/admin/judges/:id { fullName }
  router.patch('/:id', (req, res) => {
    const id = parseId(req.params.id);
    requireJudge(id);
    const body = requireObjectBody(req);
    const fullName = readString(body, 'fullName', { max: 150 });
    db.transaction(() => {
      judges.updateJudge(db, id, fullName);
      bumpRevision(db);
    })();
    res.json({ judge: requireJudge(id) });
  });

  // DELETE /api/v1/admin/judges/:id — только если нет оценок, назначений, устройств и приглашений.
  router.delete('/:id', (req, res) => {
    const id = parseId(req.params.id);
    requireJudge(id);
    const refs = judges.judgeReferences(db, id);
    const total = refs.scores + refs.assignments + refs.devices + refs.invitations;
    if (total > 0) {
      throw new HttpError(409, 'judge_in_use', 'У судьи есть оценки, назначения или устройства: удалить нельзя');
    }
    db.transaction(() => {
      judges.deleteJudge(db, id);
      bumpRevision(db);
    })();
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createJudgesRouter };
