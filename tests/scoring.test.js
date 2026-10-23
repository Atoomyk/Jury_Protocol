'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const S = require('../shared/scoring.js');
const F = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'scoring-cases.json'), 'utf8')
);

function assertClose(actual, expected, msg) {
  if (expected === null || actual === null) {
    assert.equal(actual, expected, msg);
    return;
  }
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg}: ${actual} != ${expected}`);
}

test('round2 округляет до сотых как в app.js', () => {
  F.round2.forEach(c => assert.equal(S.round2(c.in), c.expected, `round2(${c.in})`));
});

test('fmt2 форматирует с запятой и «—» для пустых значений', () => {
  F.fmt2.forEach(c => assert.equal(S.fmt2(c.in), c.expected, `fmt2(${c.in})`));
});

test('grandPrixCount совпадает с таблицей организатора', () => {
  F.grandPrixCount.forEach(c => assert.equal(S.grandPrixCount(c.n), c.expected, `n=${c.n}`));
});

test('prizeFor применяет пороги призов', () => {
  F.prizeFor.forEach(c => assert.equal(S.prizeFor(c.avg), c.expected, `avg=${c.avg}`));
});

test('подписи критериев зависят от состава', () => {
  F.criteriaLabels.forEach(c => {
    const list = S.getCriteria({ genre: c.genre, groupSize: c.groupSize });
    const found = list.find(x => x.key === c.key);
    assert.ok(found, `нет критерия ${c.key} в жанре ${c.genre}`);
    assert.equal(found.label, c.expected);
  });
});

test('judgeScore: сумма / число критериев, пропуск = 0', () => {
  F.judgeScore.forEach(c => {
    const p = { genre: c.genre, groupSize: c.groupSize };
    assertClose(S.judgeScore(p, { criteria: c.criteria }), c.expected, c.name);
  });
});

test('computeBlockResults: порядок, средние, призы, Гран-при, форматирование', () => {
  F.blockResults.forEach(c => {
    const r = S.computeBlockResults(c.genre, c.judges, c.participants, c.scores);
    const e = c.expected;

    assert.equal(r.n, e.n, `${c.name}: n`);
    assert.equal(r.gpTable, e.gpTable, `${c.name}: gpTable`);
    assert.equal(r.gpActual, e.gpActual, `${c.name}: gpActual`);
    assert.deepEqual(r.rows.map(x => x.p.number), e.order, `${c.name}: порядок`);

    e.rows.forEach((er, i) => {
      const row = r.rows[i];
      const label = `${c.name}, №${er.number}`;
      assert.equal(row.p.number, er.number, label);
      assert.equal(row.count, er.count, `${label}: count`);
      assert.equal(S.prizeFor(row.avg), er.prize, `${label}: приз`);
      assert.equal(S.fmt2(row.avg), er.fmtAvg, `${label}: средний`);
      assertClose(row.avg, er.avg, `${label}: avg`);
      row.perJudge.forEach((v, k) => {
        assertClose(v, er.perJudge[k], `${label}: судья ${k + 1}`);
        assert.equal(S.fmt2(v === null ? null : S.round2(v)), er.fmtPerJudge[k], `${label}: fmt судья ${k + 1}`);
      });
    });
  });
});
