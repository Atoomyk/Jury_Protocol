/*
 * Общие расчёты конкурса «Лазурный берег». Без DOM и без состояния.
 * Загрузка: в браузере — <script src="shared/scoring.js"> (появится window.LazurnyScoring),
 * в Node — require('../shared/scoring.js').
 * Формулы должны совпадать с серверными; эталон — tests/fixtures/scoring-cases.json.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LazurnyScoring = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* Критерии по жанрам (формулировки из положения).
     label — фиксированный критерий.
     solo / group — подпись зависит от состава (солист или коллектив/дуэт). */
  const CRITERIA = {
    'Хореография': [
      { key: 'impression', solo: 'Общее художественное впечатление (для солистов)', group: 'Синхронность (для дуэтов и коллективов)' },
      { key: 'composition', label: 'Композиционная выстроенность' },
      { key: 'stageImage', label: 'Сценический образ' },
      { key: 'school', label: 'Школа (владение техникой)' },
      { key: 'costumes', label: 'Костюмы' },
    ],
    'Вокал': [
      { key: 'impression', solo: 'Общее художественное впечатление (для солистов)', group: 'Слаженность и спетость (для дуэтов и ансамблей)' },
      { key: 'stageImage', label: 'Сценический образ' },
      { key: 'repertoire', label: 'Соответствие выбранного репертуара исполнительским возможностям и возрасту' },
      { key: 'school', label: 'Школа (владение техникой)' },
      { key: 'delivery', label: 'Подача на сцене' },
    ],
    'Инструментал': [
      { key: 'impression', solo: 'Общее художественно-музыкальное впечатление (для солистов)', group: 'Слаженность и сыгранность (для дуэтов и ансамблей)' },
      { key: 'musicality', label: 'Музыкальность и эмоциональность исполнения музыкального произведения' },
      { key: 'repertoire', label: 'Соответствие выбранного репертуара исполнительским возможностям и возрасту' },
      { key: 'mastery', label: 'Уровень исполнительского мастерства' },
      { key: 'complexity', label: 'Сложность репертуара' },
    ],
    'Театр': [
      { key: 'theme', label: 'Полнота и выразительность раскрытия темы произведения: режиссерская постановка (драматический театр); выразительность и четкость речи (чтецы, актерское мастерство)' },
      { key: 'impression', solo: 'Общее художественное впечатление (для солистов)', group: 'Слаженность, сыгранность, синхронность (для дуэтов и коллективов)' },
      { key: 'repertoireComplexity', label: 'Сложность репертуара/художественного решения' },
      { key: 'artistry', label: 'Артистичность исполнения' },
      { key: 'repertoire', label: 'Соответствие выбранного репертуара исполнительским возможностям и возрасту' },
    ],
  };

  /* Округление до сотых (как в исходном app.js). */
  function round2(v) {
    return Math.round((v + Number.EPSILON) * 100) / 100;
  }

  /* Форматирование: два знака, запятая; null → «—». */
  function fmt2(v) {
    return v === null || v === undefined ? '—' : v.toFixed(2).replace('.', ',');
  }

  /* Коллектив/дуэт: groupSize ≥ 2; иначе солист. */
  function isGroup(p) {
    return Number(p.groupSize) >= 2;
  }

  function getCriteria(p) {
    return (CRITERIA[p.genre] || []).map(c => ({
      key: c.key,
      label: c.label || (isGroup(p) ? c.group : c.solo),
    }));
  }

  /* Сумма по критериям жанра; отсутствующий критерий считается нулём. */
  function sumCriteria(p, rec) {
    return getCriteria(p).reduce((s, c) => s + (Number(rec.criteria[c.key]) || 0), 0);
  }

  /* Балл судьи по участнику: сумма по критериям / число критериев жанра. */
  function judgeScore(p, rec) {
    return sumCriteria(p, rec) / getCriteria(p).length;
  }

  /* Гран-при по размеру блока (таблица подтверждена организатором).
     1–19 — 2; 20–35 — 3; 36–45 — 4; 46–55 — 5; 56–65 — 6; далее +1 за каждые 10 номеров. */
  function grandPrixCount(n) {
    if (n < 20) return 2;
    if (n <= 35) return 3;
    if (n <= 45) return 4;
    if (n <= 55) return 5;
    return 6 + Math.floor((n - 56) / 10);
  }

  /* Приз по округлённому до сотых среднему баллу. */
  function prizeFor(avg) {
    if (avg === null) return '';
    if (avg >= 10) return 'Гран-при';
    if (avg >= 9) return '1 место';
    if (avg >= 8) return '2 место';
    if (avg >= 7) return '3 место';
    return '';
  }

  /* Результаты блока.
     judges — [{ id, name }] в порядке назначения;
     participants — все участники конкурса (фильтруются по genre);
     scores — { [participantId]: { [judgeId]: { criteria, comment } } }. */
  function computeBlockResults(genre, judges, participants, scores) {
    const rows = participants
      .filter(p => p.genre === genre)
      .map(p => {
        const perJudge = judges.map(j => {
          const rec = (scores[p.id] && scores[p.id][j.id]) || null;
          return rec ? judgeScore(p, rec) : null;
        });
        const vals = perJudge.filter(v => v !== null);
        const avg = vals.length
          ? round2(vals.reduce((a, b) => a + b, 0) / vals.length)
          : null;
        return { p, perJudge, avg, count: vals.length };
      })
      .sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1) || a.p.number - b.p.number);

    const n = rows.length;
    return {
      genre,
      judges,
      rows,
      n,
      gpTable: grandPrixCount(n),
      gpActual: rows.filter(r => r.avg === 10).length,
    };
  }

  return {
    CRITERIA,
    round2,
    fmt2,
    isGroup,
    getCriteria,
    sumCriteria,
    judgeScore,
    grandPrixCount,
    prizeFor,
    computeBlockResults,
  };
});
