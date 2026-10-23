-- 0001_init: начальная схема.
-- Применяется в транзакции; версия записывается в schema_migrations (см. db/database.js).

CREATE TABLE competitions (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

CREATE TABLE admin_users (
  id             INTEGER PRIMARY KEY,
  login          TEXT    NOT NULL UNIQUE,
  password_hash  TEXT    NOT NULL,            -- только Argon2id
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

-- id = SHA-256 от случайного токена сессии (сам токен в cookie, в БД только хеш)
CREATE TABLE admin_sessions (
  id            TEXT    PRIMARY KEY,
  admin_id      INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  csrf_hash     TEXT    NOT NULL,            -- SHA-256 от CSRF-токена
  created_at    TEXT    NOT NULL,
  last_seen_at  TEXT    NOT NULL,
  expires_at    TEXT    NOT NULL
);
CREATE INDEX idx_admin_sessions_admin ON admin_sessions(admin_id);
CREATE INDEX idx_admin_sessions_expires ON admin_sessions(expires_at);

-- Журнал неудачных попыток входа для блокировки (см. middleware/rate-limit.js).
-- Хранится в памяти процесса, таблицы нет.

CREATE TABLE judges (
  id              INTEGER PRIMARY KEY,
  competition_id  INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  full_name       TEXT    NOT NULL,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);
CREATE INDEX idx_judges_competition ON judges(competition_id);

CREATE TABLE blocks (
  id              INTEGER PRIMARY KEY,
  competition_id  INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  title           TEXT    NOT NULL,
  genre           TEXT    NOT NULL,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);
CREATE INDEX idx_blocks_competition ON blocks(competition_id);

-- Судья может быть в нескольких блоках (вариант «а»).
-- active = 0 означает «снят с блока»: оценки сохраняются, в расчёт не входят.
CREATE TABLE assignments (
  id          INTEGER PRIMARY KEY,
  judge_id    INTEGER NOT NULL REFERENCES judges(id) ON DELETE CASCADE,
  block_id    INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  UNIQUE (judge_id, block_id)
);
CREATE INDEX idx_assignments_block ON assignments(block_id);

-- Удаление участника — soft-delete (deleted_at). Оценки остаются.
CREATE TABLE participants (
  id              INTEGER PRIMARY KEY,
  competition_id  INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  block_id        INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  number          INTEGER NOT NULL,
  name            TEXT    NOT NULL,
  title           TEXT,
  group_size      INTEGER,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  deleted_at      TEXT,
  UNIQUE (competition_id, number)
);
CREATE INDEX idx_participants_block ON participants(block_id);

-- Текущая оценка по паре (участник, судья). version растёт только вверх.
CREATE TABLE scores (
  id              INTEGER PRIMARY KEY,
  competition_id  INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  participant_id  INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  judge_id        INTEGER NOT NULL REFERENCES judges(id) ON DELETE CASCADE,
  change_id       TEXT    NOT NULL UNIQUE,   -- UUID последнего принятого изменения
  version         INTEGER NOT NULL CHECK (version >= 1),
  criteria_json   TEXT    NOT NULL,          -- {"key": value, ...}
  created_at      TEXT    NOT NULL,
  received_at     TEXT    NOT NULL,          -- ставит сервер, по нему победитель НЕ выбирается
  UNIQUE (participant_id, judge_id)
);
CREATE INDEX idx_scores_judge ON scores(judge_id);

-- Одноразовые приглашения (QR). В БД только SHA-256 от токена.
CREATE TABLE judge_invitations (
  id           INTEGER PRIMARY KEY,
  judge_id     INTEGER NOT NULL REFERENCES judges(id) ON DELETE CASCADE,
  token_hash   TEXT    NOT NULL UNIQUE,
  created_at   TEXT    NOT NULL,
  expires_at   TEXT    NOT NULL,
  used_at      TEXT,
  revoked_at   TEXT
);
CREATE INDEX idx_judge_invitations_judge ON judge_invitations(judge_id);

-- Устройство судьи. В БД только SHA-256 от device token.
CREATE TABLE judge_devices (
  id            INTEGER PRIMARY KEY,
  judge_id      INTEGER NOT NULL REFERENCES judges(id) ON DELETE CASCADE,
  token_hash    TEXT    NOT NULL UNIQUE,
  status        TEXT    NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at    TEXT    NOT NULL,
  activated_at  TEXT,
  revoked_at    TEXT
);
-- Один судья — одно активное устройство.
CREATE UNIQUE INDEX uq_judge_devices_one_active
  ON judge_devices(judge_id) WHERE status = 'active';

-- Журнал принятых и отклонённых изменений оценок (для идемпотентности и разбора).
CREATE TABLE score_events (
  id              INTEGER PRIMARY KEY,
  change_id       TEXT    NOT NULL UNIQUE,
  competition_id  INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  judge_id        INTEGER NOT NULL REFERENCES judges(id) ON DELETE CASCADE,
  participant_id  INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL,
  result          TEXT    NOT NULL CHECK (result IN ('accepted', 'duplicate', 'stale', 'rejected')),
  received_at     TEXT    NOT NULL
);
CREATE INDEX idx_score_events_pair ON score_events(participant_id, judge_id);

-- Одна строка: глобальная ревизия для опроса клиентов (?since=).
CREATE TABLE app_state (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  revision    INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT    NOT NULL
);
INSERT INTO app_state (id, revision, updated_at) VALUES (1, 0, '1970-01-01T00:00:00.000Z');
