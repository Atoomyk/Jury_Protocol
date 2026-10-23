-- 0002: номер участника уникален только среди неудалённых участников.
-- migrate:foreign_keys=off
-- Таблица пересобирается; на время миграции внешние ключи выключены,
-- иначе DROP TABLE participants каскадно удалил бы оценки. См. db/database.js.

CREATE TABLE participants_new (
  id              INTEGER PRIMARY KEY,
  competition_id  INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  block_id        INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  number          INTEGER NOT NULL,
  name            TEXT    NOT NULL,
  title           TEXT,
  group_size      INTEGER,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  deleted_at      TEXT
);

INSERT INTO participants_new
  (id, competition_id, block_id, number, name, title, group_size, created_at, updated_at, deleted_at)
SELECT
  id, competition_id, block_id, number, name, title, group_size, created_at, updated_at, deleted_at
FROM participants;

DROP TABLE participants;
ALTER TABLE participants_new RENAME TO participants;

CREATE INDEX idx_participants_block ON participants(block_id);
CREATE UNIQUE INDEX uq_participants_number_active
  ON participants(competition_id, number) WHERE deleted_at IS NULL;
