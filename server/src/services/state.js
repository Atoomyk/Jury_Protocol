'use strict';

const { listBlocks } = require('../db/blocks');
const { listJudges } = require('../db/judges');
const { listCompetitionParticipants, toParticipant } = require('../db/participants');
const { listCompetitionScores, listJudgeScores } = require('../db/scores');
const { getRevision } = require('../services/revision');

// Активные назначения: { [blockId]: [judgeId, ...] } в порядке создания.
function activeAssignmentsByBlock(db) {
  const rows = db.prepare(`
    SELECT a.block_id, a.judge_id FROM assignments a WHERE a.active = 1 ORDER BY a.id
  `).all();
  const map = {};
  for (const r of rows) {
    if (!map[r.block_id]) map[r.block_id] = [];
    map[r.block_id].push(r.judge_id);
  }
  return map;
}

// Активные приглашения и устройства по судьям (без токенов и хешей).
function judgeAccessMap(db) {
  const invitations = new Map(
    db.prepare(`
      SELECT judge_id, created_at, expires_at FROM judge_invitations
      WHERE revoked_at IS NULL AND used_at IS NULL
    `).all().map(r => [r.judge_id, r])
  );
  const devices = new Map(
    db.prepare("SELECT judge_id, activated_at FROM judge_devices WHERE status = 'active'")
      .all().map(r => [r.judge_id, r])
  );
  return { invitations, devices };
}

// Состояние для администратора: всё, что нужно вкладкам и таблицам.
function buildAdminState(db, competitionId) {
  const state = db.prepare('SELECT revision, updated_at FROM app_state WHERE id = 1').get();
  const competition = db.prepare('SELECT id, name FROM competitions WHERE id = ?').get(competitionId);
  const { invitations, devices } = judgeAccessMap(db);

  return {
    competition: { id: competition.id, name: competition.name },
    revision: state.revision,
    updatedAt: state.updated_at,
    blocks: listBlocks(db, competitionId),
    judges: listJudges(db, competitionId).map(j => {
      const dev = devices.get(j.id);
      const inv = invitations.get(j.id);
      return {
        ...j,
        deviceBound: Boolean(dev),
        deviceActivatedAt: dev ? dev.activated_at : null,
        invitationIssuedAt: inv ? inv.created_at : null,
        invitationExpiresAt: inv ? inv.expires_at : null,
      };
    }),
    assignments: activeAssignmentsByBlock(db),
    participants: listCompetitionParticipants(db, competitionId),
    scores: listCompetitionScores(db, competitionId),
  };
}

// Состояние для судьи: только свои блоки, участники и свои оценки.
function buildJudgeState(db, judgeId, competitionId) {
  const blocks = db.prepare(`
    SELECT b.id, b.title, b.genre, b.sort_order
    FROM assignments a
    JOIN blocks b ON b.id = a.block_id
    WHERE a.judge_id = ? AND a.active = 1
    ORDER BY b.sort_order, b.id
  `).all(judgeId).map(r => ({
    id: r.id, title: r.title, genre: r.genre, sortOrder: r.sort_order,
  }));

  const blockIds = blocks.map(b => b.id);
  let participants = [];
  const judgesByBlock = {};

  if (blockIds.length > 0) {
    const placeholders = blockIds.map(() => '?').join(', ');
    participants = db.prepare(`
      SELECT p.id, p.competition_id, p.block_id, p.number, p.name, p.title, p.group_size,
        p.nomination, p.category, p.city, p.leader, p.deleted_at, b.genre
      FROM participants p
      JOIN blocks b ON b.id = p.block_id
      WHERE p.block_id IN (${placeholders}) AND p.deleted_at IS NULL
      ORDER BY p.block_id, p.number, p.id
    `).all(...blockIds).map(toParticipant);

    const rows = db.prepare(`
      SELECT a.block_id, j.id, j.full_name
      FROM assignments a
      JOIN judges j ON j.id = a.judge_id
      WHERE a.active = 1 AND a.block_id IN (${placeholders})
      ORDER BY j.full_name, j.id
    `).all(...blockIds);
    for (const r of rows) {
      if (!judgesByBlock[r.block_id]) judgesByBlock[r.block_id] = [];
      judgesByBlock[r.block_id].push({ id: r.id, fullName: r.full_name });
    }
  }

  return {
    competitionId,
    revision: getRevision(db),
    blocks,
    participants,
    judgesByBlock,
    scores: listJudgeScores(db, judgeId),
  };
}

module.exports = { buildAdminState, buildJudgeState, activeAssignmentsByBlock, judgeAccessMap };
