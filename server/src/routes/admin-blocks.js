'use strict';

const express = require('express');
const blocks = require('../db/blocks');
const assignments = require('../db/assignments');
const judges = require('../db/judges');
const participants = require('../db/participants');
const { bumpRevision } = require('../services/revision');
const { HttpError } = require('../utils/http-error');
const { isKnownGenre, GENRES } = require('../utils/genres');
const { requireObjectBody, readString, ValidationError } = require('../middleware/validation');
const { parseId, readIdList } = require('../utils/parse');

const JUDGES_MIN = 2;
const JUDGES_MAX = 8;

function readGenre(body) {
  const genre = readString(body, 'genre', { max: 50 });
  if (!isKnownGenre(genre)) {
    throw new ValidationError(`Жанр должен быть одним из: ${GENRES.join(', ')}`);
  }
  return genre;
}

function createBlocksRouter({ db, competitionId }) {
  const router = express.Router();

  function requireBlock(id) {
    const block = blocks.getBlock(db, competitionId, id);
    if (!block) throw new HttpError(404, 'not_found', 'Блок не найден');
    return block;
  }

  // GET /api/v1/admin/blocks
  router.get('/', (req, res) => {
    res.json({ blocks: blocks.listBlocks(db, competitionId) });
  });

  // POST /api/v1/admin/blocks { title, genre }
  router.post('/', (req, res) => {
    const body = requireObjectBody(req);
    const data = { title: readString(body, 'title', { max: 200 }), genre: readGenre(body) };
    const id = db.transaction(() => {
      const newId = blocks.insertBlock(db, competitionId, data);
      bumpRevision(db);
      return newId;
    })();
    res.status(201).json({ block: requireBlock(id) });
  });

  // PATCH /api/v1/admin/blocks/:id { title, genre }
  // Жанр нельзя менять, пока в блоке есть участники: от жанра зависят критерии.
  router.patch('/:id', (req, res) => {
    const id = parseId(req.params.id);
    const current = requireBlock(id);
    const body = requireObjectBody(req);
    const data = { title: readString(body, 'title', { max: 200 }), genre: readGenre(body) };
    if (data.genre !== current.genre && current.participantsCount > 0) {
      throw new HttpError(409, 'genre_locked', 'Нельзя сменить жанр, пока в блоке есть участники');
    }
    db.transaction(() => {
      blocks.updateBlock(db, id, data);
      bumpRevision(db);
    })();
    res.json({ block: requireBlock(id) });
  });

  // DELETE /api/v1/admin/blocks/:id — только пустой блок
  router.delete('/:id', (req, res) => {
    const id = parseId(req.params.id);
    requireBlock(id);
    const refs = blocks.blockReferences(db, id);
    if (refs.participants > 0 || refs.assignments > 0) {
      throw new HttpError(409, 'block_not_empty', 'В блоке есть участники или судьи: сначала уберите их');
    }
    db.transaction(() => {
      blocks.deleteBlock(db, id);
      bumpRevision(db);
    })();
    res.json({ ok: true });
  });

  // GET /api/v1/admin/blocks/:id/judges
  router.get('/:id/judges', (req, res) => {
    const id = parseId(req.params.id);
    requireBlock(id);
    res.json({ judges: assignments.listBlockJudges(db, id) });
  });

  // PUT /api/v1/admin/blocks/:id/judges { judgeIds: [...] } — от 2 до 8 судей.
  // Судьи, которых нет в списке, снимаются с блока (active=0), их оценки сохраняются.
  router.put('/:id/judges', (req, res) => {
    const id = parseId(req.params.id);
    requireBlock(id);
    const body = requireObjectBody(req);
    const judgeIds = readIdList(body, 'judgeIds', { min: JUDGES_MIN, max: JUDGES_MAX });
    const found = judges.findExistingJudgeIds(db, competitionId, judgeIds);
    if (found.size !== judgeIds.length) {
      throw new ValidationError('Один из судей не найден в конкурсе');
    }
    db.transaction(() => {
      assignments.setBlockJudges(db, id, judgeIds);
      bumpRevision(db);
    })();
    res.json({ judges: assignments.listBlockJudges(db, id) });
  });

  // GET /api/v1/admin/blocks/:id/participants (без удалённых)
  router.get('/:id/participants', (req, res) => {
    const id = parseId(req.params.id);
    requireBlock(id);
    res.json({ participants: participants.listBlockParticipants(db, id) });
  });

  return router;
}

module.exports = { createBlocksRouter, JUDGES_MIN, JUDGES_MAX };
