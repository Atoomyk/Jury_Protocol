'use strict';

/* ==================== КОНСТАНТЫ ==================== */
const STORAGE_KEY = 'lazurny_jury_data_v2';
const SESSION_KEY = 'lazurny_jury_session_v2';
const DEFAULT_PASSWORD = '123';     // стартовый пароль администратора и судей (меняется в «Настройках»)
const ADMIN_PASS_MIN = 5;
const ADMIN_PASS_MAX = 10;
const JUDGE_PASS_LEN = 5;
const JUDGES_MIN = 2;               // судей в блоке: от 2 до 4
const JUDGES_MAX = 4;
const MAX_SCORE = 10;

const CONTEST_TITLE = 'IV Всероссийский многожанровый конкурс «Лазурный берег» 11 октября 2026г.';

const GENRES = ['Хореография', 'Вокал', 'Инструментал', 'Театр'];

/* Название блока по умолчанию для печати (можно поправить в форме). */
const BLOCK_TITLE_DEFAULT = {
  'Хореография': 'ПЕРВЫЙ БЛОК. ХОРЕОГРАФИЧЕСКОЕ ИСКУССТВО',
  'Вокал': 'БЛОК. ВОКАЛЬНОЕ ИСКУССТВО',
  'Инструментал': 'БЛОК. ИНСТРУМЕНТАЛЬНОЕ ИСПОЛНИТЕЛЬСТВО',
  'Театр': 'БЛОК. ТЕАТРАЛЬНОЕ ТВОРЧЕСТВО',
};

/* Критерии, формулы и расчёты — в shared/scoring.js (общий модуль клиента и сервера). */
const {
  CRITERIA, round2, fmt2, isGroup, getCriteria, sumCriteria, judgeScore,
  grandPrixCount, prizeFor, computeBlockResults,
} = window.LazurnyScoring;

const TABS = ['participants', 'results', 'print', 'settings'];

/* ==================== СОСТОЯНИЕ ==================== */
/*
 {
   version, updatedAt,
   auth: { init, adminHash, judgeHash },     // judgeHash = null → вход судей без пароля
   judges: [{ id, name }],                    // сквозной список судей (ФИО)
   assignments: { [жанр]: [judgeId, ...] },   // назначения судей на блоки (2–4)
   participants: [{ id, number, name, act, genre, nomination, category, city, groupSize, leader }],
   scores: { [participantId]: { [judgeId]: { criteria: {key: n}, comment, savedAt } } }
 }
 groupSize: null — солист, число ≥ 2 — коллектив/дуэт.
*/
let state = loadFromLocal();
let session = loadSession();     // { role: 'admin' } | { role: 'judge', genre, judgeId }
let adminTab = 'participants';
let judgeOpenPid = null;         // участник, которого судья оценивает сейчас
let draft = null;                // черновик оценки: { pid, criteria, comment }

const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

/* ==================== ХРАНЕНИЕ ==================== */
function defaultState() {
  return {
    version: 2,
    updatedAt: 0,
    auth: { init: false, adminHash: null, judgeHash: null },
    judges: [],
    assignments: {},
    participants: [],
    scores: {},
  };
}

function loadFromLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = { ...defaultState(), ...JSON.parse(raw) };
      s.auth = { ...defaultState().auth, ...(s.auth || {}) };
      return s;
    }
  } catch (e) {
    console.error('Ошибка чтения данных', e);
  }
  return defaultState();
}

function saveToLocal() {
  state.updatedAt = Date.now();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    alert('Не удалось сохранить данные (память браузера заполнена).');
    console.error(e);
  }
  syncWithServer(state).catch(err => console.warn('Ошибка синхронизации', err));
}

/**
 * ЗАГЛУШКА синхронизации.
 * Сюда добавить отправку payload на сервер (например, Firebase Firestore).
 */
async function syncWithServer(payload) {
  return { ok: true, stub: true, size: JSON.stringify(payload).length };
}

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY)) || null;
  } catch (e) {
    return null;
  }
}

function setSession(s) {
  session = s;
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
}

/* Пароли: SHA-256 через crypto.subtle (нужен защищённый контекст: HTTPS или localhost/file в WebView). */
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ==================== ТЕМА ОФОРМЛЕНИЯ ==================== */
/* Хранится на устройстве (не в данных конкурса). По умолчанию — тёмная. */
const THEME_KEY = 'lazurny_jury_theme_v1';

function currentTheme() {
  return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
}

function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  localStorage.setItem(THEME_KEY, t);
  $$('[data-theme-set]').forEach(b => {
    const on = b.dataset.themeSet === t;
    b.classList.toggle('btn-tab-on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

/* ==================== ВСПОМОГАТЕЛЬНЫЕ ==================== */
function show(id, on) { $(id).classList.toggle('hidden', !on); }

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function metaLine(p) {
  return [
    p.nomination,
    isGroup(p) ? `коллектив/дуэт, ${p.groupSize} чел.` : 'солист',
    p.category,
    p.city,
  ].filter(Boolean).join(' · ');
}

function judgeName(id) {
  return state.judges.find(j => j.id === id)?.name || 'Член жюри';
}

/* Судьи блока в порядке назначения. Номер «Судьи №N» — это позиция в этом списке. */
function judgesFor(genre) {
  return (state.assignments[genre] || [])
    .map(id => state.judges.find(j => j.id === id))
    .filter(Boolean);
}

function getScore(pid, jid) {
  return state.scores[pid]?.[jid] || null;
}

function stamp() {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
}

function downloadFile(name, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ==================== ВХОД / РОЛИ ==================== */
function login(s) {
  setSession(s);
  judgeOpenPid = null;
  draft = null;
  render();
}

// Экран входа в исходное состояние: видны две кнопки, формы скрыты
function resetLoginView() {
  $('cardAdmin').classList.remove('hidden');
  $('cardJudge').classList.remove('hidden');
  $('btnAdminToggle').classList.remove('hidden');
  $('btnJudgeToggle').classList.remove('hidden');
  $('adminPanel').classList.add('hidden');
  $('judgePanel').classList.add('hidden');
  $('pinError').classList.add('hidden');
}

function render() {
  // Если судью сняли с блока, сессия становится недействительной
  if (session?.role === 'judge' && !judgesFor(session.genre).some(j => j.id === session.judgeId)) {
    setSession(null);
  }
  const role = session?.role;
  if (!role) resetLoginView();
  show('screen-login', !role);
  show('screen-admin', role === 'admin');
  show('screen-judge', role === 'judge');
  $('btnLogout').classList.toggle('hidden', !role);
  $('whoami').textContent =
    role === 'admin' ? 'Администратор'
      : role === 'judge' ? `${judgeName(session.judgeId)} · ${session.genre}`
        : '';

  if (role === 'admin') renderAdmin();
  if (role === 'judge') renderJudge();
}

async function onAdminLogin() {
  const h = await sha256($('adminPin').value);
  if (h !== state.auth.adminHash) {
    $('pinError').classList.remove('hidden');
    return;
  }
  $('adminPin').value = '';
  $('pinError').classList.add('hidden');
  adminTab = 'participants';
  login({ role: 'admin' });
}

function fillJudgeLoginSelect() {
  const js = judgesFor($('judgeGenre').value);
  $('judgeSelect').innerHTML = js.length
    ? js.map(j => `<option value="${j.id}">${esc(j.name)}</option>`).join('')
    : '<option value="">Нет назначенных членов жюри</option>';
}

async function onJudgeLogin() {
  const genre = $('judgeGenre').value;
  const jid = $('judgeSelect').value;
  if (!jid) return alert('В этом блоке нет назначенных членов жюри. Обратитесь к администратору.');

  if (state.auth.judgeHash) {
    const h = await sha256($('judgePass').value);
    if (h !== state.auth.judgeHash) {
      $('judgeError').classList.remove('hidden');
      return;
    }
  }
  $('judgePass').value = '';
  $('judgeError').classList.add('hidden');
  login({ role: 'judge', genre, judgeId: jid });
}

/* ==================== АДМИНИСТРАТОР ==================== */
function renderAdmin() {
  $$('[data-tab]').forEach(b => b.classList.toggle('btn-tab-on', b.dataset.tab === adminTab));
  TABS.forEach(t => show('tab-' + t, t === adminTab));

  if (adminTab === 'participants') renderParticipants();
  if (adminTab === 'results') $('resultsBox').innerHTML = GENRES.map(resultsBlockHtml).join('');
  if (adminTab === 'print') fillPrintMode();
  if (adminTab === 'settings') renderSettings();
}

function renderParticipants() {
  const list = [...state.participants].sort((a, b) => a.number - b.number);
  $('participantsBody').innerHTML = list.length
    ? list.map(rowHtml).join('')
    : `<tr><td colspan="5" class="empty">Участников пока нет</td></tr>`;
}

function rowHtml(p) {
  const judges = judgesFor(p.genre);
  const scored = judges.filter(j => getScore(p.id, j.id)).length;
  return `
    <tr>
      <td class="num-cell">${esc(p.number)}</td>
      <td><strong>${esc(p.name)}</strong><div class="sub">${esc(p.act)}</div><div class="sub">${esc(metaLine(p))}</div></td>
      <td>${esc(p.genre)}</td>
      <td class="center">${scored}/${judges.length}</td>
      <td class="actions">
        <button class="btn btn-ghost btn-sm" data-act="del" data-id="${p.id}">Удалить</button>
      </td>
    </tr>`;
}

function onAddParticipant(e) {
  e.preventDefault();
  const f = e.target;
  const fd = new FormData(f);
  const number = Number(fd.get('number'));
  const name = String(fd.get('name') || '').trim();
  const act = String(fd.get('act') || '').trim();
  const genre = String(fd.get('genre') || '');
  const gsRaw = String(fd.get('groupSize') || '').trim();
  const groupSize = gsRaw === '' ? null : Number(gsRaw);

  if (!Number.isInteger(number) || number < 1) return alert('Номер должен быть целым числом от 1');
  if (state.participants.some(p => p.number === number)) return alert(`Номер ${number} уже занят`);
  if (!name || !act) return alert('Заполните название коллектива/ФИО и название номера');
  if (!GENRES.includes(genre)) return alert('Выберите жанр (блок)');
  if (groupSize !== null && (!Number.isInteger(groupSize) || groupSize < 1)) {
    return alert('Количество участников — целое число от 1. Для солиста оставьте пусто.');
  }

  state.participants.push({
    id: uid(),
    number,
    name,
    act,
    genre,
    nomination: String(fd.get('nomination') || '').trim(),
    category: String(fd.get('category') || '').trim(),
    city: String(fd.get('city') || '').trim(),
    groupSize: groupSize !== null && groupSize >= 2 ? groupSize : null,
    leader: String(fd.get('leader') || '').trim(),
  });

  saveToLocal();
  f.reset();
  render();
  f.querySelector('[name="number"]').focus();
}

function onTableClick(e) {
  const btn = e.target.closest('button[data-act="del"]');
  if (btn) deleteParticipant(btn.dataset.id);
}

function deleteParticipant(id) {
  const p = state.participants.find(x => x.id === id);
  if (!p || !confirm(`Удалить участника №${p.number} «${p.name}»?`)) return;
  state.participants = state.participants.filter(x => x.id !== id);
  delete state.scores[id];
  saveToLocal();
  render();
}

/* ---------- Подсчёт результатов по блоку (формулы в shared/scoring.js) ---------- */
function blockResults(genre) {
  return computeBlockResults(genre, judgesFor(genre), state.participants, state.scores);
}

function resultsBlockHtml(genre) {
  const b = blockResults(genre);
  const head = `<h3 class="block-h">${esc(genre)}</h3>`;
  if (!b.n) return head + '<p class="sub">Участников нет</p>';

  const info = `<p class="sub">Участников: ${b.n}. Жюри блока: ${b.judges.map(j => esc(j.name)).join(', ') || '—'}.
    Гран-при по таблице: ${b.gpTable}. Набрали 10,00: ${b.gpActual}.</p>`;
  const warn = b.gpActual > b.gpTable
    ? `<p class="warn">Баллов 10,00 больше, чем положено по таблице. Члены жюри могут исправить свои оценки, пока идёт конкурс.</p>`
    : '';

  return head + info + warn + `
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Место</th><th>№</th><th>Коллектив / ФИО</th><th>Номинация</th>
            ${b.judges.map(j => `<th>${esc(j.name)}</th>`).join('')}
            <th>Средний</th>
          </tr>
        </thead>
        <tbody>
          ${b.rows.map(r => `
            <tr>
              <td>${esc(prizeFor(r.avg) || '—')}</td>
              <td>${esc(r.p.number)}</td>
              <td>${esc(r.p.name)}</td>
              <td>${esc(r.p.nomination || '')}</td>
              ${r.perJudge.map(v => `<td>${fmt2(v === null ? null : round2(v))}</td>`).join('')}
              <td class="avg">${fmt2(r.avg)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

/* ---------- Экспорт CSV (разделитель «;») ---------- */
function exportCSV() {
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const row = arr => arr.map(q).join(';');
  const num = v => (v === null || v === undefined ? '' : v.toFixed(2).replace('.', ','));
  const lines = [];

  GENRES.forEach(g => {
    const b = blockResults(g);
    lines.push(row([`Блок: ${g}`]));
    lines.push(row([
      'Место', 'Номер', 'Коллектив / ФИО', 'Название номера', 'Номинация', 'Количество участников',
      'Возрастная категория', 'Город', 'Руководитель',
      ...b.judges.map(j => j.name), 'Средний балл', 'Оценка',
    ]));
    b.rows.forEach(r => {
      lines.push(row([
        prizeFor(r.avg), r.p.number, r.p.name, r.p.act, r.p.nomination || '',
        isGroup(r.p) ? r.p.groupSize : '',
        r.p.category || '', r.p.city || '', r.p.leader || '',
        ...r.perJudge.map(v => num(v === null ? null : round2(v))),
        num(r.avg), r.count,
      ]));
    });
    lines.push('');
  });

  lines.push(row(['Блок', 'Член жюри', 'Номер', 'Коллектив / ФИО', 'Критерий', 'Балл', 'Комментарий']));
  GENRES.forEach(g => {
    const list = state.participants.filter(p => p.genre === g).sort((a, b) => a.number - b.number);
    judgesFor(g).forEach(j => {
      list.forEach(p => {
        const rec = getScore(p.id, j.id);
        if (!rec) return;
        getCriteria(p).forEach(c => {
          lines.push(row([g, j.name, p.number, p.name, c.label, rec.criteria[c.key] ?? '', '']));
        });
        lines.push(row([g, j.name, p.number, p.name, 'ИТОГО (сумма)', sumCriteria(p, rec), rec.comment || '']));
      });
    });
  });

  downloadFile(`jury_results_${stamp()}.csv`, '\uFEFF' + lines.join('\r\n'), 'text/csv;charset=utf-8');
}

/* ---------- Настройки: судьи, назначения, пароли ---------- */
function renderSettings() {
  $('judgesList').innerHTML = state.judges.length
    ? state.judges.map(j => `
        <div class="judge-row">
          <span>${esc(j.name)}</span>
          <button class="btn btn-ghost btn-sm" data-act="deljudge" data-id="${j.id}">Удалить</button>
        </div>`).join('')
    : '<p class="sub">Членов жюри пока нет. Добавьте ФИО.</p>';

  $('assignBox').innerHTML = GENRES.map(g => {
    const ids = state.assignments[g] || [];
    const n = ids.length;
    const ok = n >= JUDGES_MIN && n <= JUDGES_MAX;
    const boxes = state.judges.map(j => `
        <label class="check">
          <input type="checkbox" data-genre="${esc(g)}" data-jid="${j.id}" ${ids.includes(j.id) ? 'checked' : ''}>
          ${esc(j.name)}
        </label>`).join('') || '<p class="sub">Сначала добавьте членов жюри</p>';
    return `
      <div class="assign-block">
        <h3>${esc(g)}</h3>
        <div class="check-list">${boxes}</div>
        <p class="${ok ? 'ok' : 'warn'}">Назначено: ${n} (нужно от ${JUDGES_MIN} до ${JUDGES_MAX})</p>
      </div>`;
  }).join('');

  $('judgePassStatus').textContent = state.auth.judgeHash
    ? 'Пароль жюри установлен.'
    : 'Пароль жюри удалён: вход без пароля.';
  $('btnDelJudgePass').disabled = !state.auth.judgeHash;
}

async function onAddJudge(e) {
  e.preventDefault();
  const name = $('judgeName').value.trim();
  if (!name) return;
  state.judges.push({ id: uid(), name });
  saveToLocal();
  e.target.reset();
  render();
}

function onJudgesListClick(e) {
  const btn = e.target.closest('button[data-act="deljudge"]');
  if (btn) deleteJudge(btn.dataset.id);
}

function deleteJudge(id) {
  const j = state.judges.find(x => x.id === id);
  if (!j) return;
  if (!confirm(`Удалить члена жюри «${j.name}»? Он будет снят со всех блоков, его оценки перестанут учитываться в итогах.`)) return;
  state.judges = state.judges.filter(x => x.id !== id);
  Object.keys(state.assignments).forEach(g => {
    state.assignments[g] = state.assignments[g].filter(x => x !== id);
  });
  saveToLocal();
  render();
}

function onAssignChange(e) {
  const cb = e.target.closest('input[type="checkbox"][data-genre]');
  if (!cb) return;
  const g = cb.dataset.genre;
  const jid = cb.dataset.jid;
  const ids = state.assignments[g] || [];

  if (cb.checked) {
    if (ids.length >= JUDGES_MAX) {
      cb.checked = false;
      return alert(`В блоке не больше ${JUDGES_MAX} членов жюри. Снимите лишнего.`);
    }
    state.assignments[g] = [...ids, jid];
  } else {
    state.assignments[g] = ids.filter(x => x !== jid);
  }
  saveToLocal();
  render();
}

async function setAdminPass() {
  const v = $('newAdminPass').value;
  if (v.length < ADMIN_PASS_MIN || v.length > ADMIN_PASS_MAX) {
    return alert(`Пароль администратора: от ${ADMIN_PASS_MIN} до ${ADMIN_PASS_MAX} символов`);
  }
  state.auth.adminHash = await sha256(v);
  saveToLocal();
  $('newAdminPass').value = '';
  alert('Пароль администратора изменён');
}

async function setJudgePass() {
  const v = $('newJudgePass').value;
  if (v.length !== JUDGE_PASS_LEN) {
    return alert(`Пароль жюри — ровно ${JUDGE_PASS_LEN} символов`);
  }
  state.auth.judgeHash = await sha256(v);
  saveToLocal();
  $('newJudgePass').value = '';
  render();
  alert('Пароль жюри сохранён');
}

function deleteJudgePass() {
  if (!confirm('Удалить пароль жюри? Вход будет без пароля, пока не установите новый.')) return;
  state.auth.judgeHash = null;
  saveToLocal();
  render();
}

/* ==================== ПЕЧАТЬ ==================== */

/* Заголовок колонки критерия — как в бумажном бланке. */
function critHeader(c) {
  return c.label || `${c.group} / ${c.solo}`;
}

/* Баллы по критериям для одного участника.
   mode === 'avg' — среднее по судьям блока, иначе — баллы конкретного судьи. */
function protocolValues(p, mode) {
  const judges = judgesFor(p.genre);
  const recs = mode === 'avg'
    ? judges.map(j => getScore(p.id, j.id)).filter(Boolean)
    : [getScore(p.id, mode)].filter(Boolean);

  const vals = {};
  getCriteria(p).forEach(c => {
    const nums = recs.map(r => Number(r.criteria[c.key])).filter(n => n > 0);
    vals[c.key] = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  });
  return vals;
}

function fmtScore(v, mode) {
  if (v === null || v === undefined) return '—';
  if (mode === 'avg') return (Math.round(v * 100) / 100).toFixed(2).replace('.', ',');
  return String(v);
}

function judgeLabel(genre, jid) {
  const idx = judgesFor(genre).findIndex(j => j.id === jid);
  return idx < 0 ? 'член жюри' : `Член жюри №${idx + 1} (${judgeName(jid)})`;
}

function buildProtocolHtml(genre, title, mode) {
  const list = state.participants
    .filter(p => p.genre === genre)
    .sort((a, b) => a.number - b.number);
  const crit = CRITERIA[genre] || [];

  const orient = crit.length + 4 > 6 ? 'landscape' : 'portrait';
  $('pageStyle').textContent = `@page { size: A4 ${orient}; margin: 12mm; }`;

  const headCells = crit.map(c => `<th class="c-crit">${esc(critHeader(c))}</th>`).join('');

  const rows = list.map(p => {
    const vals = protocolValues(p, mode);
    const keys = getCriteria(p).map(c => c.key);
    const nums = keys.map(k => vals[k]);
    const hasAny = nums.some(v => v !== null);
    const sum = hasAny ? nums.reduce((s, v) => s + (v || 0), 0) : null;
    const who = [p.nomination, p.category, p.city].filter(Boolean).join(', ');
    const sub = `${p.genre}, ${isGroup(p) ? 'коллектив / дуэт' : 'солист'}`;

    return `
      <tr>
        <td class="c-num">${esc(p.number)}</td>
        <td class="c-name"><strong>${esc(p.name)}</strong><br>${esc(p.act)}<br>${esc(who)}<br><em>${esc(sub)}</em></td>
        ${nums.map(v => `<td class="c-val">${fmtScore(v, mode)}</td>`).join('')}
        <td class="c-val c-sum">${sum === null ? '—' : fmtScore(sum, mode)}</td>
        <td class="c-note"></td>
      </tr>`;
  }).join('');

  const modeLabel = mode === 'avg'
    ? 'средний балл по всем членам жюри блока'
    : `оценки ${judgeLabel(genre, mode)}`;

  const judgeNames = judgesFor(genre).map(j => esc(j.name));
  const signLines = judgeNames.length
    ? judgeNames.map(n => `<p>${n} <span class="p-line"></span></p>`).join('')
    : `<p>Члены жюри: <span class="p-line"></span></p>`;

  return `
    <div class="sheet">
      <div class="p-contest">${esc(CONTEST_TITLE)}</div>
      <h2 class="p-block">${esc(title)}</h2>
      <div class="p-mode">Протокол: ${esc(modeLabel)}</div>
      <table class="p-table">
        <thead>
          <tr>
            <th class="c-num">№</th>
            <th class="c-name">Исполнитель / коллектив</th>
            ${headCells}
            <th class="c-sum">Итого</th>
            <th class="c-note">Примечание</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="p-sign">
        <p>Председатель жюри <span class="p-line"></span></p>
        ${signLines}
      </div>
    </div>`;
}

function printProtocol() {
  const genre = $('printGenre').value;
  const mode = $('printMode').value;
  const title = $('printBlockName').value.trim() || BLOCK_TITLE_DEFAULT[genre] || genre.toUpperCase();

  const hasAny = state.participants.some(p => p.genre === genre);
  if (!hasAny) return alert(`В блоке «${genre}» нет участников`);

  $('printRoot').innerHTML = buildProtocolHtml(genre, title, mode);
  window.print();
}

/* Итоговый протокол по всему конкурсу: по блоку на лист, с призами и Гран-при. */
function printAll() {
  const sheets = GENRES.map(g => {
    const b = blockResults(g);
    if (!b.n) return '';
    return `
      <div class="sheet">
        <div class="p-contest">${esc(CONTEST_TITLE)}</div>
        <h2 class="p-block">Итоговый протокол. ${esc(BLOCK_TITLE_DEFAULT[g] || g)}</h2>
        <div class="p-mode">Жюри: ${b.judges.map(j => esc(j.name)).join(', ') || '—'}.
          Участников: ${b.n}. Гран-при по таблице: ${b.gpTable}. Набрали 10,00: ${b.gpActual}.</div>
        <table class="p-table">
          <thead>
            <tr>
              <th class="c-note">Место</th>
              <th class="c-num">№</th>
              <th class="c-name">Коллектив / ФИО, номер</th>
              <th class="c-val">Средний балл</th>
              <th class="c-note">Примечание</th>
            </tr>
          </thead>
          <tbody>
            ${b.rows.map(r => `
              <tr>
                <td class="c-val">${esc(prizeFor(r.avg) || '—')}</td>
                <td class="c-num">${esc(r.p.number)}</td>
                <td class="c-name"><strong>${esc(r.p.name)}</strong><br>${esc(r.p.act)}<br>${esc(metaLine(r.p))}</td>
                <td class="c-val c-sum">${fmt2(r.avg)}</td>
                <td class="c-note"></td>
              </tr>`).join('')}
          </tbody>
        </table>
        <div class="p-sign">
          <p>Председатель жюри <span class="p-line"></span></p>
        </div>
      </div>`;
  }).join('');

  if (!sheets.trim()) return alert('Участников пока нет');
  $('pageStyle').textContent = '@page { size: A4 portrait; margin: 12mm; }';
  $('printRoot').innerHTML = sheets;
  window.print();
}

function fillPrintMode() {
  const g = $('printGenre').value || GENRES[0];
  const prev = $('printMode').value;
  $('printMode').innerHTML = [
    `<option value="avg">Общий протокол (средний балл)</option>`,
    ...judgesFor(g).map((j, i) => `<option value="${j.id}">Протокол члена жюри №${i + 1} (${esc(j.name)})</option>`),
  ].join('');
  if ([...$('printMode').options].some(o => o.value === prev)) $('printMode').value = prev;
}

/* ==================== СУДЬЯ ==================== */
function openP() {
  return state.participants.find(p => p.id === judgeOpenPid) || null;
}

function judgeListHtml(list) {
  if (!list.length) return '<p class="empty">В этом блоке пока нет участников</p>';
  return list.map(p => {
    const saved = !!getScore(p.id, session.judgeId);
    return `
      <div class="list-row">
        <div class="num-cell">${esc(p.number)}</div>
        <div class="info">
          <strong>${esc(p.name)}</strong>
          <div class="sub">${esc(p.act)}</div>
          <div class="sub">${esc(metaLine(p))}</div>
        </div>
        <span class="${saved ? 'ok' : 'sub'}">${saved ? 'Оценено' : 'Не оценено'}</span>
        <button class="btn btn-accent btn-sm" data-pid="${p.id}">${saved ? 'Изменить' : 'Оценить'}</button>
      </div>`;
  }).join('');
}

function renderJudge() {
  const genre = session.genre;
  const list = state.participants
    .filter(p => p.genre === genre)
    .sort((a, b) => a.number - b.number);

  if (judgeOpenPid && !list.some(p => p.id === judgeOpenPid)) {
    judgeOpenPid = null;
    draft = null;
  }

  show('judgeListCard', !judgeOpenPid);
  show('judgeCard', !!judgeOpenPid);

  if (!judgeOpenPid) {
    $('judgeListTitle').textContent = `Блок «${genre}»: участники по порядку номеров`;
    $('judgeListBox').innerHTML = judgeListHtml(list);
    return;
  }

  const p = openP();
  $('jNum').textContent = p.number;
  $('jName').textContent = p.name;
  $('jAct').textContent = p.act;
  $('jMeta').textContent = [metaLine(p), p.leader ? `Руководитель: ${p.leader}` : ''].filter(Boolean).join(' · ');
  updateJudgeUI();
}

function openParticipant(pid) {
  const p = state.participants.find(x => x.id === pid);
  if (!p) return;
  const saved = getScore(pid, session.judgeId);
  judgeOpenPid = pid;
  draft = {
    pid,
    criteria: saved ? { ...saved.criteria } : {},
    comment: saved?.comment || '',
  };
  buildCriteria(p);
  $('jComment').value = draft.comment;
  render();
}

function buildCriteria(p) {
  const nums = Array.from({ length: MAX_SCORE }, (_, i) => i + 1);
  $('jCriteria').innerHTML = getCriteria(p).map(c => `
    <div class="crit">
      <div class="crit-label">${esc(c.label)}</div>
      <div class="scale">
        ${nums.map(n => `<button type="button" class="score-btn" data-key="${c.key}" data-val="${n}">${n}</button>`).join('')}
      </div>
    </div>`).join('');
}

function updateJudgeUI() {
  const p = openP();
  if (!p || !draft) return;
  const saved = getScore(p.id, session.judgeId);

  $$('#jCriteria .score-btn').forEach(b => {
    b.classList.toggle('active', draft.criteria[b.dataset.key] === Number(b.dataset.val));
  });

  const crit = getCriteria(p);
  const total = crit.reduce((s, c) => s + (draft.criteria[c.key] || 0), 0);
  $('jTotal').textContent = total;
  $('jMax').textContent = crit.length * MAX_SCORE;

  $('btnSave').textContent = saved ? 'Сохранить изменения' : 'Сохранить оценку';
  $('jStatus').textContent = saved
    ? 'Оценка сохранена. Её можно изменить, пока идёт конкурс.'
    : 'Оценка ещё не сохранена.';
}

function onScoreClick(e) {
  const b = e.target.closest('.score-btn');
  if (!b || !draft) return;
  draft.criteria[b.dataset.key] = Number(b.dataset.val);
  updateJudgeUI();
}

function onSaveScore() {
  const p = openP();
  if (!p || !draft) return;

  const missing = getCriteria(p).filter(c => !draft.criteria[c.key]);
  if (missing.length) {
    alert(`Поставьте оценку по всем критериям. Не заполнено: ${missing.length}`);
    return;
  }

  state.scores[p.id] = state.scores[p.id] || {};
  state.scores[p.id][session.judgeId] = {
    criteria: { ...draft.criteria },
    comment: $('jComment').value.trim(),
    savedAt: Date.now(),
  };
  saveToLocal();
  renderJudge();
}

function closeJudgeCard() {
  judgeOpenPid = null;
  draft = null;
  render();
}

/* ==================== ИНИЦИАЛИЗАЦИЯ ==================== */
async function init() {
  const genreOptions = GENRES.map(g => `<option>${esc(g)}</option>`).join('');
  $('genreSelect').innerHTML = genreOptions;
  $('judgeGenre').innerHTML = genreOptions;
  $('printGenre').innerHTML = genreOptions;

  // Первый запуск: стартовые пароли
  if (!state.auth.init) {
    state.auth = {
      init: true,
      adminHash: await sha256(DEFAULT_PASSWORD),
      judgeHash: await sha256(DEFAULT_PASSWORD),
    };
    saveToLocal();
  }

  // Тема оформления (переключатели в настройках админа и судьи)
  applyTheme(currentTheme());
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-theme-set]');
    if (b) applyTheme(b.dataset.themeSet);
  });

  // Вход
  $('btnAdminToggle').onclick = () => {
    $('cardJudge').classList.add('hidden');
    $('btnAdminToggle').classList.add('hidden');
    $('adminPanel').classList.remove('hidden');
    $('adminPin').focus();
  };
  $('btnJudgeToggle').onclick = () => {
    $('cardAdmin').classList.add('hidden');
    $('btnJudgeToggle').classList.add('hidden');
    $('judgePanel').classList.remove('hidden');
    fillJudgeLoginSelect();
  };
  $('judgeGenre').onchange = fillJudgeLoginSelect;
  $('btnAdminBack').onclick = resetLoginView;
  $('btnJudgeBack').onclick = resetLoginView;
  $('btnAdmin').onclick = onAdminLogin;
  $('adminPin').addEventListener('keydown', e => { if (e.key === 'Enter') onAdminLogin(); });
  $('btnJudge').onclick = onJudgeLogin;
  $('btnLogout').onclick = () => login(null);

  // Админ: вкладки
  $('adminTabs').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    adminTab = b.dataset.tab;
    render();
  });
  $('formParticipant').addEventListener('submit', onAddParticipant);
  $('participantsBody').addEventListener('click', onTableClick);
  $('btnExportCsv').onclick = exportCSV;

  $('printGenre').onchange = () => {
    $('printBlockName').value = BLOCK_TITLE_DEFAULT[$('printGenre').value] || '';
    fillPrintMode();
  };
  $('printBlockName').value = BLOCK_TITLE_DEFAULT[GENRES[0]];
  $('btnPrint').onclick = printProtocol;
  $('btnPrintAll').onclick = printAll;
  fillPrintMode();

  // Настройки
  $('formJudge').addEventListener('submit', onAddJudge);
  $('judgesList').addEventListener('click', onJudgesListClick);
  $('assignBox').addEventListener('change', onAssignChange);
  $('btnSetJudgePass').onclick = setJudgePass;
  $('btnDelJudgePass').onclick = deleteJudgePass;
  $('btnSetAdminPass').onclick = setAdminPass;

  // Судья
  $('judgeListBox').addEventListener('click', e => {
    const b = e.target.closest('button[data-pid]');
    if (b) openParticipant(b.dataset.pid);
  });
  $('jCriteria').addEventListener('click', onScoreClick);
  $('btnSave').onclick = onSaveScore;
  $('btnBack').onclick = closeJudgeCard;

  // Синхронизация между вкладками одного браузера
  window.addEventListener('storage', e => {
    if (e.key === STORAGE_KEY) {
      state = loadFromLocal();
      render();
    }
  });

  render();
}

document.addEventListener('DOMContentLoaded', init);
