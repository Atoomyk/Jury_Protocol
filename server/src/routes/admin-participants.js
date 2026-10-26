'use strict';

const express = require('express');
const blocks = require('../db/blocks');
const participants = require('../db/participants');
const { bumpRevision } = require('../services/revision');
const { HttpError } = require('../utils/http-error');
const { requireObjectBody, readString, ValidationError } = require('../middleware/validation');
const { parseId, readInt } = require('../utils/parse');

const NUMBER_MAX = 100000;
const GROUP_SIZE_MAX = 50;

function readParticipantFields(body) {
  const number = readInt(body, 'number', { min: 1, max: NUMBER_MAX });
  const name = readString(body, 'name', { max: 200 });
  const title = readString(body, 'title', { max: 200, required: false });
  // Для солиста поле можно не передавать: readInt вернёт null.
  const groupSize = readInt(body, 'groupSize', { min: 1, max: GROUP_SIZE_MAX, required: false });
  const nomination = readString(body, 'nomination', { max: 200, required: false });
  const category = readString(body, 'category', { max: 100, required: false });
  const city = readString(body, 'city', { max: 100, required: false });
  const leader = readString(body, 'leader', { max: 200, required: false });
  return { number, name, title, groupSize, nomination, category, city, leader };
}

function createParticipantsRouter({ db, competitionId }) {
  const router = express.Router();

  function requireActive(id) {
    const p = participants.getParticipant(db, competitionId, id);
    if (!p || p.deleted) throw new HttpError(404, 'not_found', 'Участник не найден');
    return p;
  }

  function ensureNumberFree(number, exceptId) {
    if (participants.findActiveByNumber(db, competitionId, number, exceptId)) {
      throw new HttpError(409, 'number_taken', 'Участник с таким номером уже есть');
    }
  }

  // GET /api/v1/admin/participants — все неудалённые участники конкурса.
  router.get('/', (req, res) => {
    res.json({ participants: participants.listCompetitionParticipants(db, competitionId) });
  });

  // POST /api/v1/admin/participants { blockId, number, name, title?, groupSize, ... }
  router.post('/', (req, res) => {
    const body = requireObjectBody(req);
    const blockId = readInt(body, 'blockId', { min: 1, max: Number.MAX_SAFE_INTEGER });
    const fields = readParticipantFields(body);
    if (!blocks.getBlock(db, competitionId, blockId)) {
      throw new ValidationError('Блок не найден');
    }
    ensureNumberFree(fields.number, 0);
    const id = db.transaction(() => {
      const newId = participants.insertParticipant(db, competitionId, { blockId, ...fields });
      bumpRevision(db);
      return newId;
    })();
    res.status(201).json({ participant: requireActive(id) });
  });

  // PATCH /api/v1/admin/participants/:id { number, name, title?, groupSize, ... }
  // Блок участника не меняется (перенос между блоками — отдельная операция).
  router.patch('/:id', (req, res) => {
    const id = parseId(req.params.id);
    requireActive(id);
    const body = requireObjectBody(req);
    const fields = readParticipantFields(body);
    ensureNumberFree(fields.number, id);
    db.transaction(() => {
      participants.updateParticipant(db, id, fields);
      bumpRevision(db);
    })();
    res.json({ participant: requireActive(id) });
  });

  // DELETE /api/v1/admin/participants/:id — soft-delete, оценки не трогаем.
  router.delete('/:id', (req, res) => {
    const id = parseId(req.params.id);
    requireActive(id);
    db.transaction(() => {
      participants.softDeleteParticipant(db, id);
      bumpRevision(db);
    })();
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createParticipantsRouter };
