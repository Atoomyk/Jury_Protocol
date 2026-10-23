'use strict';

// Вызывать внутри той же транзакции, что и изменение данных.
function bumpRevision(db) {
  db.prepare('UPDATE app_state SET revision = revision + 1, updated_at = ? WHERE id = 1')
    .run(new Date().toISOString());
}

function getRevision(db) {
  return db.prepare('SELECT revision FROM app_state WHERE id = 1').get().revision;
}

module.exports = { bumpRevision, getRevision };
