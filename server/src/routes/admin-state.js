'use strict';

const express = require('express');
const { getRevision } = require('../services/revision');
const { buildAdminState } = require('../services/state');

function createAdminStateRouter({ db, competitionId }) {
  const router = express.Router();

  // GET /api/v1/admin/state?since=<revision>
  // Полное состояние конкурса; при совпадении ревизии — { changed: false }.
  // Объём данных небольшой (10 судей, десятки участников), поэтому при
  // изменении отдаётся снимок целиком, а не дельта.
  router.get('/', (req, res) => {
    const revision = getRevision(db);
    const since = Number(req.query.since);
    if (Number.isInteger(since) && since === revision) {
      return res.json({ revision, changed: false });
    }
    return res.json({
      revision,
      changed: true,
      state: buildAdminState(db, competitionId),
    });
  });

  return router;
}

module.exports = { createAdminStateRouter };
