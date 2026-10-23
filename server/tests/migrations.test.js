'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase, listMigrations, applyMigrations } = require('../src/db/database');

test('миграции упорядочены по номеру и без дублей', () => {
  const list = listMigrations();
  assert.ok(list.length >= 1);
  assert.equal(list[0].version, 1);
  for (let i = 1; i < list.length; i++) {
    assert.ok(list[i].version > list[i - 1].version);
  }
});

test('повторное применение миграций ничего не меняет', () => {
  const db = openDatabase(':memory:');
  try {
    const again = applyMigrations(db);
    assert.deepEqual(again, []);
  } finally {
    db.close();
  }
});

test('foreign_keys включены', () => {
  const db = openDatabase(':memory:');
  try {
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  } finally {
    db.close();
  }
});

test('один судья — только одно активное устройство (частичный уникальный индекс)', () => {
  const db = openDatabase(':memory:');
  try {
    const ts = '2025-01-01T00:00:00.000Z';
    db.prepare("INSERT INTO competitions (name, created_at, updated_at) VALUES ('K', ?, ?)").run(ts, ts);
    db.prepare("INSERT INTO judges (competition_id, full_name, created_at, updated_at) VALUES (1, 'J', ?, ?)").run(ts, ts);
    const ins = db.prepare(
      "INSERT INTO judge_devices (judge_id, token_hash, status, created_at) VALUES (1, ?, ?, ?)"
    );
    ins.run('h1', 'active', ts);
    ins.run('h2', 'revoked', ts); // отозванные не мешают
    assert.throws(() => ins.run('h3', 'active', ts), /UNIQUE/);
  } finally {
    db.close();
  }
});

test('номер участника уникален в конкурсе', () => {
  const db = openDatabase(':memory:');
  try {
    const ts = '2025-01-01T00:00:00.000Z';
    db.prepare("INSERT INTO competitions (name, created_at, updated_at) VALUES ('K', ?, ?)").run(ts, ts);
    db.prepare("INSERT INTO blocks (competition_id, title, genre, created_at, updated_at) VALUES (1, 'B', 'g', ?, ?)").run(ts, ts);
    const ins = db.prepare(
      "INSERT INTO participants (competition_id, block_id, number, name, created_at, updated_at) VALUES (1, 1, ?, 'P', ?, ?)"
    );
    ins.run(1, ts, ts);
    assert.throws(() => ins.run(1, ts, ts), /UNIQUE/);
  } finally {
    db.close();
  }
});

test('оценка по паре (участник, судья) уникальна', () => {
  const db = openDatabase(':memory:');
  try {
    const ts = '2025-01-01T00:00:00.000Z';
    db.prepare("INSERT INTO competitions (name, created_at, updated_at) VALUES ('K', ?, ?)").run(ts, ts);
    db.prepare("INSERT INTO judges (competition_id, full_name, created_at, updated_at) VALUES (1, 'J', ?, ?)").run(ts, ts);
    db.prepare("INSERT INTO blocks (competition_id, title, genre, created_at, updated_at) VALUES (1, 'B', 'g', ?, ?)").run(ts, ts);
    db.prepare("INSERT INTO participants (competition_id, block_id, number, name, created_at, updated_at) VALUES (1, 1, 1, 'P', ?, ?)").run(ts, ts);
    const ins = db.prepare(
      `INSERT INTO scores (competition_id, participant_id, judge_id, change_id, version, criteria_json, created_at, received_at)
       VALUES (1, 1, 1, ?, 1, '{}', ?, ?)`
    );
    ins.run('c1', ts, ts);
    assert.throws(() => ins.run('c2', ts, ts), /UNIQUE/);
  } finally {
    db.close();
  }
});
