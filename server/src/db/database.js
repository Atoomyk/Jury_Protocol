'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const MIGRATION_FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;
// Миграция, которая пересобирает таблицы с внешними ключами, помечается строкой:
// -- migrate:foreign_keys=off
const FK_OFF_RE = /^\s*--\s*migrate:foreign_keys=off\s*$/m;

function listMigrations(dir = MIGRATIONS_DIR) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql'));
  const list = files.map(file => {
    const m = MIGRATION_FILE_RE.exec(file);
    if (!m) throw new Error(`Некорректное имя миграции: ${file}`);
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    return { version: Number(m[1]), file, sql, fkOff: FK_OFF_RE.test(sql) };
  });
  list.sort((a, b) => a.version - b.version);
  const seen = new Set();
  for (const m of list) {
    if (seen.has(m.version)) throw new Error(`Повторный номер миграции ${m.version}`);
    seen.add(m.version);
  }
  return list;
}

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      file        TEXT    NOT NULL,
      applied_at  TEXT    NOT NULL
    );
  `);
}

function applyMigrations(db, migrations = listMigrations()) {
  ensureMigrationsTable(db);
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version)
  );
  const insert = db.prepare(
    'INSERT INTO schema_migrations (version, file, applied_at) VALUES (?, ?, ?)'
  );
  const applyOne = db.transaction(m => {
    db.exec(m.sql);
    if (m.fkOff) {
      const violations = db.pragma('foreign_key_check');
      if (violations.length > 0) {
        throw new Error(`Миграция ${m.file}: нарушены внешние ключи`);
      }
    }
    insert.run(m.version, m.file, new Date().toISOString());
  });
  const done = [];
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    if (m.fkOff) {
      // PRAGMA foreign_keys нельзя менять внутри транзакции, поэтому переключаем снаружи.
      db.pragma('foreign_keys = OFF');
      try {
        applyOne(m);
      } finally {
        db.pragma('foreign_keys = ON');
      }
    } else {
      applyOne(m);
    }
    done.push(m.version);
  }
  return done;
}

// Открывает БД и приводит её к актуальной схеме.
// filename: путь к файлу или ':memory:' (для тестов).
function openDatabase(filename) {
  if (filename !== ':memory:') {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  }
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  if (filename !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('busy_timeout = 5000');
  applyMigrations(db);
  return db;
}

module.exports = { openDatabase, applyMigrations, listMigrations, MIGRATIONS_DIR };
