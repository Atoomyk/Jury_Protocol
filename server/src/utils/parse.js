'use strict';

const { ValidationError } = require('../middleware/validation');

function parseId(raw) {
  const s = String(raw);
  if (!/^[1-9]\d{0,15}$/.test(s)) {
    throw new ValidationError('Некорректный идентификатор');
  }
  return Number(s);
}

// Целое число в диапазоне. required=false: пустое значение возвращает null.
function readInt(body, field, { min, max, required = true }) {
  const v = body[field];
  if (v === undefined || v === null || v === '') {
    if (required) throw new ValidationError(`Поле ${field} обязательно`);
    return null;
  }
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
    throw new ValidationError(`Поле ${field} должно быть целым числом`);
  }
  if (v < min || v > max) {
    throw new ValidationError(`Поле ${field}: от ${min} до ${max}`);
  }
  return v;
}

// Список уникальных положительных целых (например, судьи блока).
function readIdList(body, field, { min, max }) {
  const v = body[field];
  if (!Array.isArray(v)) {
    throw new ValidationError(`Поле ${field} должно быть списком`);
  }
  if (v.length < min || v.length > max) {
    throw new ValidationError(`Судей в блоке должно быть от ${min} до ${max}`);
  }
  const ids = v.map(x => {
    if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < 1) {
      throw new ValidationError('Некорректный идентификатор судьи');
    }
    return x;
  });
  if (new Set(ids).size !== ids.length) {
    throw new ValidationError('Судьи не должны повторяться');
  }
  return ids;
}

module.exports = { parseId, readInt, readIdList };
