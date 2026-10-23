'use strict';

const { CRITERIA } = require('../../../shared/scoring.js');

const GENRES = Object.freeze(Object.keys(CRITERIA));

function isKnownGenre(genre) {
  return GENRES.includes(genre);
}

module.exports = { GENRES, isKnownGenre };
