'use strict';

/* ==================== КОНСТАНТЫ ==================== */
const THEME_KEY = 'lazurny_jury_theme_v1';
const ADMIN_POLL_MS = 4000;
const JUDGE_POLL_MS = 4000;
const JUDGES_MIN = 2;        // сервер: от 2 до 8; на клиенте ограничиваем 4
const JUDGES_MAX = 4;
const MAX_SCORE = 10;
const OUTBOX_BATCH = 50;

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

const TABS = ['participants', 'results', 'print', 'settings', 'access'];

/* ==================== СОСТОЯНИЕ ==================== */
let adminState = null;       // снимок /admin/state как есть
let judgeState = null;       // снимок /judge/state как есть
let state = emptyCompat();   // совместимая модель для рендера, печати и CSV
let session = null;          // { role: 'admin' } | { role: 'judge', judgeId }
let adminTab = 'participants';

let adminRevision = 0;
let judgeRevision = 0;
let adminPollTimer = null;
let judgePollTimer = null;
let adminRefreshing = false;
let judgeRefreshing = false;
let flushInFlight = false;
let flushTimer = null;

let judgeProfile = null;      // { id, fullName }
let judgeBlockId = null;
let judgeOpenPid = null;
let draft = null;             // { pid, criteria, comment }
let judgeOutbox = [];         // элементы outbox текущего судьи
let pendingScores = {};       // { [participantId]: { criteria, comment, version } }
let pendingAssignments = {};  // { [blockId]: [judgeId, ...] } — несохранённые правки админа
let issuedInvitations = {};   // { [judgeId]: { token, url, expiresAt, qrSvg } }
let judgeOnline = navigator.onLine;

const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

function emptyCompat() {
  return { judges: [], assignments: {}, participants: [], scores: {}, blocks: [] };
}

function buildCompatFromAdmin(s) {
  const judges = (s.judges || []).map(j => ({
    id: j.id, name: j.fullName, fullName: j.fullName,
    deviceBound: Boolean(j.deviceBound),
    deviceActivatedAt: j.deviceActivatedAt || null,
    invitationIssuedAt: j.invitationIssuedAt || null,
    invitationExpiresAt: j.invitationExpiresAt || null,
  }));
  const assignments = {};
  for (const b of s.blocks || []) {
    const ids = s.assignments?.[b.id] || [];
    if (!assignments[b.genre]) assignments[b.genre] = [];
    for (const id of ids) {
      const num = Number(id);
      if (!assignments[b.genre].includes(num)) assignments[b.genre].push(num);
    }
  }
  const participants = (s.participants || []).map(p => ({ ...p, act: p.title }));
  const scores = {};
  for (const rec of s.scores || []) {
    if (!scores[rec.participantId]) scores[rec.participantId] = {};
    scores[rec.participantId][rec.judgeId] = {
      criteria: rec.criteria,
      comment: rec.comment,
      savedAt: rec.createdAt || rec.receivedAt,
      version: rec.version,
    };
  }
  return { judges, assignments, participants, scores, blocks: s.blocks || [] };
}

function buildCompatFromJudge(s) {
  const judges = [];
  const assignments = {};
  for (const b of s.blocks || []) {
    const list = (s.judgesByBlock?.[b.id] || []).map(j => ({ id: j.id, name: j.fullName, fullName: j.fullName }));
    assignments[b.genre] = list.map(j => Number(j.id));
    for (const j of list) {
      if (!judges.some(x => Number(x.id) === Number(j.id))) judges.push(j);
    }
  }
  const participants = (s.participants || []).map(p => ({ ...p, act: p.title }));
  const scores = {};
  for (const rec of s.scores || []) {
    if (!scores[rec.participantId]) scores[rec.participantId] = {};
    scores[rec.participantId][rec.judgeId] = {
      criteria: rec.criteria,
      comment: rec.comment,
      savedAt: rec.createdAt || rec.receivedAt,
      version: rec.version,
    };
  }
  return { judges, assignments, participants, scores, blocks: s.blocks || [] };
}

/* ==================== ВСПОМОГАТЕЛЬНЫЕ ==================== */
function show(id, on) { $(id).classList.toggle('hidden', !on); }

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
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
  return state.judges.find(j => Number(j.id) === Number(id))?.name || 'Член жюри';
}

/* Судьи блока в порядке назначения. Номер «Судьи №N» — это позиция в этом списке. */
function judgesFor(genre) {
  return (state.assignments[genre] || [])
    .map(id => state.judges.find(j => Number(j.id) === Number(id)))
    .filter(Boolean);
}

function getScore(pid, jid) {
  const base = state.scores?.[pid]?.[jid] || null;
  if (session?.role === 'judge' && judgeProfile && Number(jid) === Number(judgeProfile.id)) {
    const pend = pendingScores[pid];
    if (pend) {
      return {
        criteria: pend.criteria,
        comment: pend.comment,
        savedAt: pend.createdAt,
        version: pend.version,
        pending: true,
      };
    }
  }
  return base;
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

function setLoginError(id, message) {
  const el = $(id);
  if (!el) return;
  if (message) {
    el.textContent = message;
    el.classList.remove('hidden');
  } else {
    el.textContent = '';
    el.classList.add('hidden');
  }
}

/* ==================== ТЕМА ОФОРМЛЕНИЯ ==================== */
/* Хранится на устройстве (не секрет). По умолчанию — тёмная. */
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

/* ==================== ВХОД / РОЛИ ==================== */
function login(s) {
  session = s;
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
  setLoginError('pinError', null);
  setLoginError('judgeError', null);
}

function render() {
  const role = session?.role;
  if (!role) resetLoginView();
  show('screen-login', !role);
  show('screen-admin', role === 'admin');
  show('screen-judge', role === 'judge');
  $('btnLogout').classList.toggle('hidden', !role);
  $('whoami').textContent =
    role === 'admin' ? 'Администратор'
      : role === 'judge' ? `${judgeProfile?.fullName || 'Член жюри'} · ${currentJudgeBlock()?.genre || ''}`
        : '';

  if (role === 'admin') renderAdmin();
  if (role === 'judge') renderJudge();
}

/* ==================== АДМИНИСТРАТОР: СЕССИЯ И ПОЛЛИНГ ==================== */
async function tryRestoreAdmin() {
  try {
    const res = await LazurnyApi.admin.session();
    LazurnyApi.setAdminCsrf(res.csrfToken);
    adminRevision = 0;
    adminState = null;
    await refreshAdminState(true);
    if (!adminState) return false;
    if ((adminState.blocks || []).length === 0) {
      await ensureBlocks();
      await refreshAdminState(true);
    }
    login({ role: 'admin' });
    startAdminPolling();
    return true;
  } catch (e) {
    LazurnyApi.setAdminCsrf(null);
    return false;
  }
}

async function onAdminLogin() {
  const loginName = ($('adminLogin').value || 'admin').trim() || 'admin';
  const password = $('adminPin').value;
  if (!password) {
    setLoginError('pinError', 'Введите пароль администратора');
    return;
  }
  try {
    const res = await LazurnyApi.admin.login(loginName, password);
    LazurnyApi.setAdminCsrf(res.csrfToken);
    $('adminPin').value = '';
    setLoginError('pinError', null);
    adminRevision = 0;
    adminState = null;
    await refreshAdminState(true);
    await ensureBlocks();
    await refreshAdminState(true);
    adminTab = 'participants';
    login({ role: 'admin' });
    startAdminPolling();
  } catch (e) {
    setLoginError('pinError', e.status === 429
      ? 'Слишком много попыток входа. Попробуйте позже.'
      : (e.message || 'Не удалось войти'));
  }
}

async function ensureBlocks() {
  if (!adminState) return;
  const have = new Set((adminState.blocks || []).map(b => b.genre));
  const missing = GENRES.filter(g => !have.has(g));
  for (const g of missing) {
    try {
      await LazurnyApi.admin.blocks.create({
        title: BLOCK_TITLE_DEFAULT[g] || g,
        genre: g,
      });
    } catch (e) {
      console.warn('Не удалось создать блок', g, e);
    }
  }
}

async function refreshAdminState(force) {
  if (adminRefreshing) return;
  adminRefreshing = true;
  let ok = false;
  try {
    const res = await LazurnyApi.admin.state(force ? 0 : adminRevision);
    if (res.changed) {
      adminState = res.state;
      adminRevision = res.revision;
      state = buildCompatFromAdmin(adminState);
      render();
    } else {
      adminRevision = res.revision;
    }
    ok = true;
  } catch (e) {
    if (e.status === 401) {
      adminAuthLost();
      return;
    }
    if (!e.offline) console.warn('Ошибка состояния администратора', e);
  } finally {
    adminRefreshing = false;
  }
  if (ok) { /* снимок обновлён */ }
}

function startAdminPolling() {
  stopAdminPolling();
  adminPollTimer = setInterval(() => refreshAdminState(false), ADMIN_POLL_MS);
}

function stopAdminPolling() {
  if (adminPollTimer) {
    clearInterval(adminPollTimer);
    adminPollTimer = null;
  }
}

function adminAuthLost() {
  stopAdminPolling();
  LazurnyApi.setAdminCsrf(null);
  adminState = null;
  adminRevision = 0;
  state = emptyCompat();
  session = null;
  render();
  setLoginError('pinError', 'Сессия администратора истекла. Войдите снова.');
}

async function onLogout() {
  if (session?.role === 'admin') {
    try { await LazurnyApi.admin.logout(); } catch (e) { console.warn('Выход администратора', e); }
    stopAdminPolling();
    LazurnyApi.setAdminCsrf(null);
    adminState = null;
    adminRevision = 0;
  } else if (session?.role === 'judge') {
    stopJudgePolling();
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    LazurnyApi.setJudgeToken(null);
    judgeProfile = null;
    judgeState = null;
    judgeRevision = 0;
    judgeOutbox = [];
    pendingScores = {};
    try {
      await LazurnyIdb.deleteMeta('deviceToken');
      await LazurnyIdb.deleteMeta('judgeProfile');
      await LazurnyIdb.deleteCache('judgeState');
    } catch (e) { console.warn('Очистка данных судьи', e); }
  }
  state = emptyCompat();
  session = null;
  login(null);
}

/* ==================== АДМИНИСТРАТОР: РЕНДЕР ==================== */
function renderAdmin() {
  $$('[data-tab]').forEach(b => b.classList.toggle('btn-tab-on', b.dataset.tab === adminTab));
  TABS.forEach(t => show('tab-' + t, t === adminTab));
  if (!adminState) return;

  fillBlockSelects();
  if (adminTab === 'participants') renderParticipants();
  if (adminTab === 'results') $('resultsBox').innerHTML = GENRES.map(resultsBlockHtml).join('');
  if (adminTab === 'print') fillPrintMode();
  if (adminTab === 'settings') renderSettings();
  if (adminTab === 'access') renderAccess();
}

function blockTitleForGenre(genre) {
  const b = (adminState?.blocks || []).find(x => x.genre === genre);
  return b?.title || BLOCK_TITLE_DEFAULT[genre] || genre.toUpperCase();
}

function fillBlockSelects() {
  const sel = $('genreSelect');
  if (!sel) return;
  const prev = sel.value;
  const blocks = adminState?.blocks || [];
  sel.innerHTML = blocks.length
    ? blocks.map(b => `<option value="${b.id}">${esc(b.genre)} — ${esc(b.title)}</option>`).join('')
    : '<option value="">Блоков нет</option>';
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;

  const printSel = $('printGenre');
  if (printSel && !printSel.options.length) {
    printSel.innerHTML = GENRES.map(g => `<option>${esc(g)}</option>`).join('');
  }
  const nameInput = $('printBlockName');
  if (nameInput && !nameInput.value && printSel) {
    nameInput.value = blockTitleForGenre(printSel.value || GENRES[0]);
  }
}

function renderParticipants() {
  if (!adminState) return;
  const list = [...state.participants].sort((a, b) => a.number - b.number);
  $('participantsBody').innerHTML = list.length
    ? list.map(rowHtml).join('')
    : '<tr><td colspan="5" class="empty">Участников пока нет</td></tr>';
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

function onTableClick(e) {
  const btn = e.target.closest('button[data-act="del"]');
  if (btn) deleteParticipant(Number(btn.dataset.id));
}

async function onAddParticipant(e) {
  e.preventDefault();
  const f = e.target;
  const fd = new FormData(f);
  const blockId = Number(fd.get('blockId'));
  const number = Number(fd.get('number'));
  const name = String(fd.get('name') || '').trim();
  const act = String(fd.get('act') || '').trim();
  const gsRaw = String(fd.get('groupSize') || '').trim();
  const groupSize = gsRaw === '' ? null : Number(gsRaw);

  if (!blockId || !(adminState?.blocks || []).some(b => Number(b.id) === blockId)) {
    return alert('Выберите блок');
  }
  if (!Number.isInteger(number) || number < 1) return alert('Номер должен быть целым числом от 1');
  if (!name || !act) return alert('Заполните название коллектива/ФИО и название номера');
  if (groupSize !== null && (!Number.isInteger(groupSize) || groupSize < 1)) {
    return alert('Количество участников — целое число от 1. Для солиста оставьте пусто.');
  }

  try {
    await LazurnyApi.admin.participants.create({
      blockId,
      number,
      name,
      title: act,
      groupSize,
      nomination: String(fd.get('nomination') || '').trim(),
      category: String(fd.get('category') || '').trim(),
      city: String(fd.get('city') || '').trim(),
      leader: String(fd.get('leader') || '').trim(),
    });
    f.reset();
    await refreshAdminState(true);
    f.querySelector('[name="number"]').focus();
  } catch (err) {
    alert(err.message || 'Не удалось добавить участника');
  }
}

async function deleteParticipant(id) {
  const p = (adminState?.participants || []).find(x => Number(x.id) === Number(id));
  if (!p || !confirm(`Удалить участника №${p.number} «${p.name}»?`)) return;
  try {
    await LazurnyApi.admin.participants.remove(Number(id));
    await refreshAdminState(true);
  } catch (err) {
    alert(err.message || 'Не удалось удалить участника');
  }
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
  if (!adminState) return alert('Данные ещё не загружены');
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

/* ==================== АДМИНИСТРАТОР: НАСТРОЙКИ ==================== */
function renderSettings() {
  if (!adminState) return;

  $('judgesList').innerHTML = adminState.judges.length
    ? adminState.judges.map(j => `
        <div class="judge-row">
          <span>${esc(j.fullName)}</span>
          <button class="btn btn-ghost btn-sm" data-act="deljudge" data-id="${j.id}">Удалить</button>
        </div>`).join('')
    : '<p class="sub">Членов жюри пока нет. Добавьте ФИО.</p>';

  const blocks = adminState.blocks || [];
  $('assignBox').innerHTML = blocks.length
    ? blocks.map(b => {
        const savedIds = (adminState.assignments?.[b.id] || []).map(Number);
        const ids = pendingAssignments[b.id] ? pendingAssignments[b.id].map(Number) : savedIds;
        const n = ids.length;
        const ok = n >= JUDGES_MIN && n <= JUDGES_MAX;
        const dirty = pendingAssignments[b.id] !== undefined;
        const boxes = adminState.judges.map(j => `
            <label class="check">
              <input type="checkbox" data-block-id="${b.id}" data-jid="${j.id}" ${ids.includes(Number(j.id)) ? 'checked' : ''}>
              ${esc(j.fullName)}
            </label>`).join('') || '<p class="sub">Сначала добавьте членов жюри</p>';
        return `
          <div class="assign-block">
            <h3>${esc(b.genre)} — ${esc(b.title)}</h3>
            <div class="check-list">${boxes}</div>
            <p class="${ok ? 'ok' : 'warn'}">Назначено: ${n} (клиент допускает от ${JUDGES_MIN} до ${JUDGES_MAX})</p>
            <button class="btn btn-primary btn-sm" data-save-block="${b.id}">Сохранить назначения</button>
            ${dirty ? '<span class="sub"> Есть несохранённые изменения</span>' : ''}
          </div>`;
      }).join('')
    : '<p class="sub">Блоков нет. Они создаются автоматически при входе администратора.</p>';
}

async function onAddJudge(e) {
  e.preventDefault();
  const name = $('judgeName').value.trim();
  if (!name) return;
  try {
    await LazurnyApi.admin.judges.create(name);
    e.target.reset();
    await refreshAdminState(true);
  } catch (err) {
    alert(err.message || 'Не удалось добавить члена жюри');
  }
}

function onJudgesListClick(e) {
  const btn = e.target.closest('button[data-act="deljudge"]');
  if (btn) deleteJudge(Number(btn.dataset.id));
}

async function deleteJudge(id) {
  const j = (adminState?.judges || []).find(x => Number(x.id) === Number(id));
  if (!j) return;
  if (!confirm(`Удалить члена жюри «${j.fullName}»?`)) return;
  try {
    await LazurnyApi.admin.judges.remove(Number(id));
    await refreshAdminState(true);
  } catch (err) {
    alert(err.message || 'Не удалось удалить члена жюри');
  }
}

function onAssignChange(e) {
  const cb = e.target.closest('input[type="checkbox"][data-block-id]');
  if (!cb) return;
  const blockId = Number(cb.dataset.blockId);
  const jid = Number(cb.dataset.jid);
  const current = pendingAssignments[blockId]
    ? [...pendingAssignments[blockId]]
    : (adminState?.assignments?.[blockId] || []).map(Number);

  if (cb.checked) {
    if (current.length >= JUDGES_MAX) {
      cb.checked = false;
      return alert(`В блоке не больше ${JUDGES_MAX} членов жюри на клиенте. Снимите лишнего.`);
    }
    if (!current.includes(jid)) current.push(jid);
  } else {
    const idx = current.indexOf(jid);
    if (idx >= 0) current.splice(idx, 1);
  }
  pendingAssignments[blockId] = current;
  renderSettings();
}

async function onSaveAssignments(blockId) {
  const known = new Set((adminState?.judges || []).map(j => Number(j.id)));
  const ids = (pendingAssignments[blockId] || adminState?.assignments?.[blockId] || [])
    .map(Number).filter(id => known.has(id));
  if (ids.length < JUDGES_MIN || ids.length > JUDGES_MAX) {
    return alert(`В блоке должно быть от ${JUDGES_MIN} до ${JUDGES_MAX} членов жюри`);
  }
  try {
    await LazurnyApi.admin.blocks.setJudges(Number(blockId), ids);
    delete pendingAssignments[blockId];
    await refreshAdminState(true);
  } catch (err) {
    alert(err.message || 'Не удалось сохранить назначения');
  }
}

async function setAdminPass() {
  const currentPassword = $('currentAdminPass').value;
  const newPassword = $('newAdminPass').value;
  if (!currentPassword) return alert('Введите текущий пароль администратора');
  if (newPassword.length < 12) return alert('Новый пароль — не короче 12 символов');
  try {
    const res = await LazurnyApi.admin.changePassword(currentPassword, newPassword);
    LazurnyApi.setAdminCsrf(res.csrfToken);
    $('currentAdminPass').value = '';
    $('newAdminPass').value = '';
    alert('Пароль администратора изменён');
  } catch (err) {
    alert(err.message || 'Не удалось сменить пароль');
  }
}

/* ==================== АДМИНИСТРАТОР: ДОСТУП (QR) ==================== */
function accessStatus(j) {
  if (j.deviceBound) {
    const at = j.deviceActivatedAt ? ` (${new Date(j.deviceActivatedAt).toLocaleString()})` : '';
    return 'Устройство привязано' + at;
  }
  if (j.invitationExpiresAt) {
    return 'Приглашение выдано до ' + new Date(j.invitationExpiresAt).toLocaleString();
  }
  return 'Доступа нет';
}

function qrBlockHtml(inv) {
  const svg = inv.qrSvg && String(inv.qrSvg).trim().startsWith('<svg')
    ? `<div class="qr-svg">${inv.qrSvg}</div>`
    : '';
  return `
    <div class="qr-card">
      ${svg}
      <p class="sub">Ссылка для судьи:</p>
      <input class="input" readonly value="${esc(inv.url)}">
      <p class="sub">Токен (если QR не сработал):</p>
      <input class="input" readonly value="${esc(inv.token)}">
      <p class="sub">Действует до ${esc(new Date(inv.expiresAt).toLocaleString())}.</p>
    </div>`;
}

function renderAccess() {
  if (!adminState) return;
  const judges = adminState.judges || [];
  if (!judges.length) {
    $('accessBox').innerHTML = '<p class="sub">Сначала добавьте членов жюри в «Настройках».</p>';
    return;
  }
  $('accessBox').innerHTML = judges.map(j => {
    const inv = issuedInvitations[j.id];
    const hasAccess = j.deviceBound || j.invitationExpiresAt;
    return `
      <div class="assign-block">
        <h3>${esc(j.fullName)}</h3>
        <p class="sub">${esc(accessStatus(j))}</p>
        <div class="toolbar">
          <button class="btn btn-primary btn-sm" data-act="issue" data-jid="${j.id}">
            ${hasAccess ? 'Перевыпустить QR' : 'Выпустить QR'}
          </button>
          ${hasAccess ? `<button class="btn btn-ghost btn-sm" data-act="revoke" data-jid="${j.id}">Отозвать доступ</button>` : ''}
          ${inv ? `<button class="btn btn-accent btn-sm" data-act="print" data-jid="${j.id}">Печать приглашения</button>` : ''}
        </div>
        ${inv ? qrBlockHtml(inv) : ''}
      </div>`;
  }).join('');
}

async function issueInvitation(judgeId) {
  try {
    const res = await LazurnyApi.admin.invitations.issue([Number(judgeId)]);
    const inv = (res.invitations || [])[0];
    if (inv) issuedInvitations[judgeId] = inv;
    await refreshAdminState(true);
    if (adminTab === 'access') renderAccess();
  } catch (err) {
    alert(err.message || 'Не удалось выпустить приглашение');
  }
}

async function revokeInvitation(judgeId) {
  if (!confirm('Отозвать доступ этого судьи? Активное устройство и приглашение будут закрыты.')) return;
  try {
    await LazurnyApi.admin.invitations.revoke(Number(judgeId));
    delete issuedInvitations[judgeId];
    await refreshAdminState(true);
    if (adminTab === 'access') renderAccess();
  } catch (err) {
    alert(err.message || 'Не удалось отозвать доступ');
  }
}

function printInvitation(judgeId) {
  const inv = issuedInvitations[judgeId];
  if (!inv) return alert('Сначала выпустите приглашение');
  const judge = (adminState?.judges || []).find(j => Number(j.id) === Number(judgeId));
  const qr = inv.qrSvg && String(inv.qrSvg).trim().startsWith('<svg')
    ? `<div class="qr-svg">${inv.qrSvg}</div>`
    : `<div class="qr-fallback">
        <p>Ссылка: ${esc(inv.url)}</p>
        <p>Токен: ${esc(inv.token)}</p>
      </div>`;
  $('pageStyle').textContent = '@page { size: A4 portrait; margin: 12mm; }';
  $('printRoot').innerHTML = `
    <div class="sheet">
      <div class="p-contest">${esc(CONTEST_TITLE)}</div>
      <h2 class="p-block">Приглашение члена жюри</h2>
      <p class="p-judge">${esc(judge?.fullName || '')}</p>
      ${qr}
      <p class="p-mode">Откройте ссылку или отсканируйте QR-код. Приглашение одноразовое.
        Срок действия до ${esc(new Date(inv.expiresAt).toLocaleString())}.</p>
    </div>`;
  window.print();
}

/* ==================== ПЕЧАТЬ ==================== */
function critHeader(c) {
  return c.label || `${c.group} / ${c.solo}`;
}

/* Баллы по критериям для одного участника.
   mode === 'avg' — среднее по судьям блока, иначе — баллы конкретного судьи. */
function protocolValues(p, mode) {
  const judges = judgesFor(p.genre);
  const jid = mode === 'avg' ? null : Number(mode);
  const recs = mode === 'avg'
    ? judges.map(j => getScore(p.id, j.id)).filter(Boolean)
    : [getScore(p.id, jid)].filter(Boolean);

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
  const idx = judgesFor(genre).findIndex(j => Number(j.id) === Number(jid));
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
  const title = $('printBlockName').value.trim() || blockTitleForGenre(genre);

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
        <h2 class="p-block">Итоговый протокол. ${esc(blockTitleForGenre(g))}</h2>
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

/* ==================== СУДЬЯ: ВХОД И СОСТОЯНИЕ ==================== */
function currentJudgeBlock() {
  const blocks = judgeState?.blocks || [];
  return blocks.find(b => Number(b.id) === Number(judgeBlockId)) || blocks[0] || null;
}

function judgeParticipants() {
  const block = currentJudgeBlock();
  if (!block) return [];
  return state.participants
    .filter(p => Number(p.blockId) === Number(block.id))
    .sort((a, b) => a.number - b.number);
}

function syncJudgeBlockSelection() {
  const blocks = judgeState?.blocks || [];
  const sel = $('judgeBlockSelect');
  if (!sel) return;
  if (blocks.length <= 1) {
    judgeBlockId = blocks[0]?.id ?? null;
    $('judgeBlockBar').classList.add('hidden');
    sel.innerHTML = '';
    return;
  }
  $('judgeBlockBar').classList.remove('hidden');
  const prev = judgeBlockId;
  sel.innerHTML = blocks.map(b => `<option value="${b.id}">${esc(b.genre)} — ${esc(b.title)}</option>`).join('');
  if (blocks.some(b => Number(b.id) === Number(prev))) sel.value = String(prev);
  else {
    judgeBlockId = blocks[0].id;
    sel.value = String(judgeBlockId);
  }
}

function setSyncStatus(text) {
  const el = $('judgeSyncStatus');
  if (el) el.textContent = text || '';
}

async function tryJudgeTokenFromUrl() {
  let url;
  try { url = new URL(location.href); } catch (e) { return false; }
  const token = url.searchParams.get('judge_token');
  if (!token) return false;
  url.searchParams.delete('judge_token');
  history.replaceState({}, '', url.pathname + url.search + url.hash);
  try {
    const res = await LazurnyApi.judge.auth(token);
    await acceptJudgeAuth(res);
    return true;
  } catch (e) {
    setLoginError('judgeError', 'Приглашение недействительно или истекло: ' + (e.message || 'ошибка'));
    return false;
  }
}

async function acceptJudgeAuth(res) {
  const oldProfile = await LazurnyIdb.getMeta('judgeProfile');
  if (oldProfile && Number(oldProfile.id) !== Number(res.judge.id)) {
    await LazurnyIdb.outboxClear();
    await LazurnyIdb.deleteCache('judgeState');
  }
  LazurnyApi.setJudgeToken(res.deviceToken);
  judgeProfile = { id: res.judge.id, fullName: res.judge.fullName };
  await LazurnyIdb.setMeta('deviceToken', res.deviceToken);
  await LazurnyIdb.setMeta('judgeProfile', judgeProfile);
  session = { role: 'judge', judgeId: judgeProfile.id };
  judgeRevision = 0;
  judgeState = null;
  await loadJudgeOutbox();
  await refreshJudgeState(true);
  syncJudgeBlockSelection();
  render();
  startJudgePolling();
  flushOutbox();
}

async function tryRestoreJudge() {
  let token = null;
  let profile = null;
  try {
    token = await LazurnyIdb.getMeta('deviceToken');
    profile = await LazurnyIdb.getMeta('judgeProfile');
  } catch (e) { return false; }
  if (!token || !profile) return false;
  LazurnyApi.setJudgeToken(token);
  judgeProfile = profile;
  session = { role: 'judge', judgeId: profile.id };
  judgeRevision = 0;
  judgeState = null;
  try {
    const cached = await LazurnyIdb.getCache('judgeState');
    if (cached && cached.state) {
      judgeState = cached.state;
      judgeRevision = cached.revision || 0;
      state = buildCompatFromJudge(judgeState);
    }
  } catch (e) { /* кэш необязателен */ }
  await loadJudgeOutbox();
  syncJudgeBlockSelection();
  render();
  startJudgePolling();
  refreshJudgeState(false).then(() => flushOutbox());
  return true;
}

async function onJudgeLogin() {
  const token = $('judgeToken').value.trim();
  if (!token) {
    setLoginError('judgeError', 'Вставьте токен из приглашения');
    return;
  }
  try {
    const res = await LazurnyApi.judge.auth(token);
    $('judgeToken').value = '';
    setLoginError('judgeError', null);
    await acceptJudgeAuth(res);
  } catch (e) {
    setLoginError('judgeError', e.status === 429
      ? 'Слишком много попыток. Попробуйте позже.'
      : (e.message || 'Не удалось войти по токену'));
  }
}

async function judgeAuthLost() {
  stopJudgePolling();
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  LazurnyApi.setJudgeToken(null);
  judgeProfile = null;
  judgeState = null;
  judgeRevision = 0;
  judgeOutbox = [];
  pendingScores = {};
  try {
    await LazurnyIdb.deleteMeta('deviceToken');
    await LazurnyIdb.deleteMeta('judgeProfile');
    await LazurnyIdb.deleteCache('judgeState');
  } catch (e) { console.warn('Очистка доступа судьи', e); }
  state = emptyCompat();
  session = null;
  render();
  setLoginError('judgeError', 'Доступ отозван. Попросите администратора выпустить новый QR.');
}

async function refreshJudgeState(force) {
  if (!judgeProfile || judgeRefreshing) return;
  judgeRefreshing = true;
  let ok = false;
  try {
    const res = await LazurnyApi.judge.state(force ? 0 : judgeRevision);
    if (res.changed) {
      judgeState = res.state;
      judgeRevision = res.revision;
      state = buildCompatFromJudge(judgeState);
      try {
        await LazurnyIdb.setCache('judgeState', { revision: judgeRevision, state: judgeState });
      } catch (e) { console.warn('Кэш состояния', e); }
      syncJudgeBlockSelection();
      render();
    } else {
      judgeRevision = res.revision;
    }
    ok = true;
  } catch (e) {
    if (e.status === 401) {
      await judgeAuthLost();
      return;
    }
    if (e.offline) setSyncStatus('Ожидает связи');
    else console.warn('Ошибка состояния судьи', e);
  } finally {
    judgeRefreshing = false;
  }
  if (ok && judgeOutbox.length) flushOutbox();
}

function startJudgePolling() {
  stopJudgePolling();
  judgePollTimer = setInterval(() => refreshJudgeState(false), JUDGE_POLL_MS);
}

function stopJudgePolling() {
  if (judgePollTimer) {
    clearInterval(judgePollTimer);
    judgePollTimer = null;
  }
}

/* ==================== СУДЬЯ: OUTBOX И СИНХРОНИЗАЦИЯ ==================== */
async function loadJudgeOutbox() {
  try {
    const all = await LazurnyIdb.outboxAll();
    judgeOutbox = (all || []).filter(i => !i.judgeId || Number(i.judgeId) === Number(judgeProfile?.id));
  } catch (e) {
    judgeOutbox = [];
  }
  rebuildPendingScores();
}

function rebuildPendingScores() {
  pendingScores = {};
  for (const item of judgeOutbox) {
    const pid = Number(item.participantId);
    const cur = pendingScores[pid];
    if (!cur || Number(item.version) > Number(cur.version)) {
      pendingScores[pid] = {
        criteria: item.criteria,
        comment: item.comment,
        version: item.version,
        changeId: item.changeId,
        createdAt: item.createdAt,
      };
    }
  }
}

function nextVersion(pid) {
  let max = 0;
  for (const rec of judgeState?.scores || []) {
    if (Number(rec.participantId) === Number(pid)) max = Math.max(max, Number(rec.version) || 0);
  }
  for (const item of judgeOutbox) {
    if (Number(item.participantId) === Number(pid)) max = Math.max(max, Number(item.version) || 0);
  }
  return max + 1;
}

function newChangeId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

async function saveScoreLocal(pid, criteria, comment) {
  if (!judgeProfile) return;
  const item = {
    changeId: newChangeId(),
    judgeId: judgeProfile.id,
    participantId: Number(pid),
    version: nextVersion(pid),
    criteria,
    comment: comment || null,
    createdAt: new Date().toISOString(),
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
  };
  await LazurnyIdb.outboxPut(item);
  judgeOutbox.push(item);
  rebuildPendingScores();
  setSyncStatus('Сохранено локально');
  render();
  flushOutbox();
}

async function flushOutbox() {
  if (flushInFlight || !judgeProfile) return;
  if (!judgeOnline) {
    setSyncStatus('Ожидает связи');
    return;
  }
  const now = Date.now();
  const ready = judgeOutbox.filter(i => !i.nextAttemptAt || Number(i.nextAttemptAt) <= now);
  if (!ready.length) {
    setSyncStatus(judgeOutbox.length ? 'Ожидает связи' : 'Отправлено');
    return;
  }
  flushInFlight = true;
  try {
    const batch = ready.slice(0, OUTBOX_BATCH).map(i => ({
      changeId: i.changeId,
      participantId: Number(i.participantId),
      version: Number(i.version),
      criteria: i.criteria,
      comment: i.comment || null,
    }));
    const res = await LazurnyApi.judge.sendScores(batch);
    let needRefresh = false;
    let errorText = '';
    for (const r of res.results || []) {
      const item = judgeOutbox.find(i => i.changeId === r.changeId);
      if (!item) continue;
      if (r.result === 'accepted' || r.result === 'duplicate' || r.result === 'stale') {
        await LazurnyIdb.outboxDelete(r.changeId);
        judgeOutbox = judgeOutbox.filter(i => i.changeId !== r.changeId);
        // accepted: сервер уже записал оценку, нужен свежий снимок с версией.
        needRefresh = true;
      } else if (r.result === 'rejected') {
        await LazurnyIdb.outboxDelete(r.changeId);
        judgeOutbox = judgeOutbox.filter(i => i.changeId !== r.changeId);
        errorText = r.error || 'Оценка отклонена';
        needRefresh = true;
      }
    }
    rebuildPendingScores();
    if (errorText) setSyncStatus('Ошибка: ' + errorText);
    else setSyncStatus(judgeOutbox.length ? 'Ожидает связи' : 'Отправлено');
    if (needRefresh) await refreshJudgeState(true);
    else render();
    if (judgeOutbox.length) scheduleFlush();
  } catch (e) {
    if (e.status === 401) {
      await judgeAuthLost();
      return;
    }
    for (const item of ready) {
      item.attempts = Number(item.attempts || 0) + 1;
      item.lastError = e.message;
      const delay = Math.min(60000, 1000 * Math.pow(2, Math.min(item.attempts, 6)));
      item.nextAttemptAt = Date.now() + delay;
      try { await LazurnyIdb.outboxPut(item); } catch (err) { /* останется в памяти */ }
    }
    setSyncStatus('Ожидает связи');
    render();
    scheduleFlush();
  } finally {
    flushInFlight = false;
  }
}

function scheduleFlush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (!judgeOutbox.length) return;
  const times = judgeOutbox.map(i => Number(i.nextAttemptAt) || (Date.now() + 1000));
  const delay = Math.max(1000, Math.min(60000, Math.min(...times) - Date.now()));
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushOutbox();
  }, delay);
}

/* ==================== СУДЬЯ: РЕНДЕР ==================== */
function openP() {
  return judgeParticipants().find(p => Number(p.id) === Number(judgeOpenPid)) || null;
}

function judgeListHtml(list) {
  if (!list.length) return '<p class="empty">В этом блоке пока нет участников</p>';
  return list.map(p => {
    const rec = getScore(p.id, session.judgeId);
    const saved = Boolean(rec);
    const label = saved ? (rec.pending ? 'Сохранено локально' : 'Оценено') : 'Не оценено';
    return `
      <div class="list-row">
        <div class="num-cell">${esc(p.number)}</div>
        <div class="info">
          <strong>${esc(p.name)}</strong>
          <div class="sub">${esc(p.act)}</div>
          <div class="sub">${esc(metaLine(p))}</div>
        </div>
        <span class="${saved ? 'ok' : 'sub'}">${label}</span>
        <button class="btn btn-accent btn-sm" data-pid="${p.id}">${saved ? 'Изменить' : 'Оценить'}</button>
      </div>`;
  }).join('');
}

function renderJudge() {
  syncJudgeBlockSelection();
  const blocks = judgeState?.blocks || [];
  const hasBlocks = blocks.length > 0;

  show('judgeWait', !hasBlocks);
  show('judgeListCard', hasBlocks && !judgeOpenPid);
  show('judgeCard', hasBlocks && Boolean(judgeOpenPid));

  if (!hasBlocks) {
    judgeOpenPid = null;
    draft = null;
    $('judgeListTitle').textContent = '';
    $('judgeListBox').innerHTML = '';
    return;
  }

  const list = judgeParticipants();
  if (judgeOpenPid && !list.some(p => Number(p.id) === Number(judgeOpenPid))) {
    judgeOpenPid = null;
    draft = null;
  }

  if (!judgeOpenPid) {
    const block = currentJudgeBlock();
    $('judgeListTitle').textContent = `${block.genre} · ${block.title}`;
    $('judgeListBox').innerHTML = judgeListHtml(list);
    return;
  }

  const p = openP();
  if (!p) {
    judgeOpenPid = null;
    draft = null;
    renderJudge();
    return;
  }
  $('jNum').textContent = p.number;
  $('jName').textContent = p.name;
  $('jAct').textContent = p.act;
  $('jMeta').textContent = [metaLine(p), p.leader ? `Руководитель: ${p.leader}` : ''].filter(Boolean).join(' · ');
  updateJudgeUI();
}

function openParticipant(pid) {
  const id = Number(pid);
  const p = judgeParticipants().find(x => Number(x.id) === id);
  if (!p) return;
  const saved = getScore(id, session.judgeId);
  judgeOpenPid = id;
  draft = {
    pid: id,
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
    ? (saved.pending
      ? 'Сохранено на устройстве, ожидает отправки на сервер.'
      : 'Оценка сохранена. Её можно изменить, пока идёт конкурс.')
    : 'Оценка ещё не сохранена.';
}

function onScoreClick(e) {
  const b = e.target.closest('.score-btn');
  if (!b || !draft) return;
  draft.criteria[b.dataset.key] = Number(b.dataset.val);
  updateJudgeUI();
}

async function onSaveScore() {
  const p = openP();
  if (!p || !draft) return;

  const criteriaList = getCriteria(p);
  const missing = criteriaList.filter(c => !draft.criteria[c.key]);
  if (missing.length) {
    alert(`Поставьте оценку по всем критериям. Не заполнено: ${missing.length}`);
    return;
  }

  const criteria = {};
  criteriaList.forEach(c => { criteria[c.key] = Number(draft.criteria[c.key]); });
  const comment = $('jComment').value.trim();
  try {
    await saveScoreLocal(p.id, criteria, comment);
  } catch (e) {
    alert(e.message || 'Не удалось сохранить оценку на устройстве');
  }
}

function closeJudgeCard() {
  judgeOpenPid = null;
  draft = null;
  render();
}

/* ==================== ИНИЦИАЛИЗАЦИЯ ==================== */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const secure = location.protocol === 'https:'
    || ['localhost', '127.0.0.1'].includes(location.hostname);
  if (!secure) {
    console.warn('[pwa] Service Worker требует HTTPS или localhost');
    return;
  }
  navigator.serviceWorker.register('/service-worker.js').catch(err => {
    console.warn('[pwa] Не удалось зарегистрировать Service Worker', err);
  });
}

function bindEvents() {
  // Тема оформления
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
    $('judgeToken').focus();
  };
  $('btnAdminBack').onclick = resetLoginView;
  $('btnJudgeBack').onclick = resetLoginView;
  $('btnAdmin').onclick = onAdminLogin;
  $('adminPin').addEventListener('keydown', e => { if (e.key === 'Enter') onAdminLogin(); });
  $('btnJudge').onclick = onJudgeLogin;
  $('judgeToken').addEventListener('keydown', e => { if (e.key === 'Enter') onJudgeLogin(); });
  $('btnLogout').onclick = onLogout;

  // Админ: вкладки и участники
  $('adminTabs').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    adminTab = b.dataset.tab;
    render();
  });
  $('formParticipant').addEventListener('submit', onAddParticipant);
  $('participantsBody').addEventListener('click', onTableClick);
  $('btnExportCsv').onclick = exportCSV;

  // Печать
  $('printGenre').onchange = () => {
    $('printBlockName').value = blockTitleForGenre($('printGenre').value);
    fillPrintMode();
  };
  $('btnPrint').onclick = printProtocol;
  $('btnPrintAll').onclick = printAll;

  // Настройки
  $('formJudge').addEventListener('submit', onAddJudge);
  $('judgesList').addEventListener('click', onJudgesListClick);
  $('assignBox').addEventListener('change', onAssignChange);
  $('assignBox').addEventListener('click', e => {
    const b = e.target.closest('button[data-save-block]');
    if (b) onSaveAssignments(Number(b.dataset.saveBlock));
  });
  $('btnSetAdminPass').onclick = setAdminPass;

  // Доступ (QR)
  $('accessBox').addEventListener('click', e => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const jid = Number(b.dataset.jid);
    if (b.dataset.act === 'issue') issueInvitation(jid);
    if (b.dataset.act === 'revoke') revokeInvitation(jid);
    if (b.dataset.act === 'print') printInvitation(jid);
  });

  // Судья
  $('judgeBlockSelect').onchange = () => {
    judgeBlockId = Number($('judgeBlockSelect').value);
    judgeOpenPid = null;
    draft = null;
    render();
  };
  $('judgeListBox').addEventListener('click', e => {
    const b = e.target.closest('button[data-pid]');
    if (b) openParticipant(Number(b.dataset.pid));
  });
  $('jCriteria').addEventListener('click', onScoreClick);
  $('btnSave').onclick = onSaveScore;
  $('btnBack').onclick = closeJudgeCard;

  // Связь и видимость вкладки
  window.addEventListener('online', () => {
    judgeOnline = true;
    if (session?.role === 'judge') {
      setSyncStatus('Отправка...');
      refreshJudgeState(false).then(() => flushOutbox());
    }
    if (session?.role === 'admin') refreshAdminState(false);
  });
  window.addEventListener('offline', () => {
    judgeOnline = false;
    if (session?.role === 'judge') setSyncStatus('Ожидает связи');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (session?.role === 'judge') refreshJudgeState(false).then(() => flushOutbox());
    if (session?.role === 'admin') refreshAdminState(false);
  });

  // Синхронизация темы между вкладками одного браузера
  window.addEventListener('storage', e => {
    if (e.key === THEME_KEY) applyTheme(currentTheme());
  });
}

async function init() {
  applyTheme(currentTheme());
  bindEvents();
  fillPrintMode();

  // 1. Ссылка из QR имеет приоритет: она сразу авторизует устройство.
  const fromUrl = await tryJudgeTokenFromUrl();
  if (!fromUrl) {
    // 2. Живая cookie администратора переживает перезагрузку.
    const adminOk = await tryRestoreAdmin();
    // 3. Иначе — ранее привязанное устройство судьи.
    if (!adminOk) await tryRestoreJudge();
  }

  if (!session) {
    resetLoginView();
    show('screen-login', true);
    show('screen-admin', false);
    show('screen-judge', false);
    $('btnLogout').classList.add('hidden');
    $('whoami').textContent = '';
  }
  render();
  registerServiceWorker();
}

document.addEventListener('DOMContentLoaded', init);
