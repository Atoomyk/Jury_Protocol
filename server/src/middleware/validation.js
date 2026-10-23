'use strict';

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

function requireObjectBody(req) {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Ожидается JSON-объект в теле запроса');
  }
  return body;
}

// Строка без пробелов по краям, длина в пределах [min, max].
function readString(body, field, { min = 1, max = 200, required = true } = {}) {
  const value = body[field];
  if (value === undefined || value === null || value === '') {
    if (required) throw new ValidationError(`Поле ${field} обязательно`);
    return null;
  }
  if (typeof value !== 'string') throw new ValidationError(`Поле ${field} должно быть строкой`);
  const trimmed = value.trim();
  if (trimmed.length < min) throw new ValidationError(`Поле ${field}: минимум ${min} символов`);
  if (trimmed.length > max) throw new ValidationError(`Поле ${field}: максимум ${max} символов`);
  return trimmed;
}

// Пароль не трим: пробелы — часть пароля. Только проверка типа и длины.
function readPassword(body, field, { min = 1, max = 1024 } = {}) {
  const value = body[field];
  if (typeof value !== 'string') throw new ValidationError(`Поле ${field} должно быть строкой`);
  if (value.length < min) throw new ValidationError(`Поле ${field}: минимум ${min} символов`);
  if (value.length > max) throw new ValidationError(`Поле ${field}: слишком длинное`);
  return value;
}

module.exports = { ValidationError, requireObjectBody, readString, readPassword };
