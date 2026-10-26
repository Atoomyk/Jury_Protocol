'use strict';
/*
 * API-клиент конкурса «Лазурный берег».
 * Администратор: cookie lz_admin (HttpOnly) + CSRF в памяти вкладки.
 * Судья: Bearer deviceToken в заголовке Authorization.
 * При сетевой ошибке выбрасывается Error с флагом offline = true.
 */
(function (global) {
  const BASE = '/api/v1';
  let adminCsrf = null;
  let judgeToken = null;

  function setAdminCsrf(token) { adminCsrf = token || null; }
  function getAdminCsrf() { return adminCsrf; }
  function setJudgeToken(token) { judgeToken = token || null; }
  function getJudgeToken() { return judgeToken; }

  async function request(path, { method = 'GET', body, admin = false, judge = false } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (admin && adminCsrf && !['GET', 'HEAD'].includes(method)) {
      headers['X-CSRF-Token'] = adminCsrf;
    }
    if (judge && judgeToken) headers.Authorization = `Bearer ${judgeToken}`;

    let response;
    try {
      response = await fetch(BASE + path, {
        method,
        headers,
        credentials: 'same-origin',
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      const e = new Error('Нет связи с сервером');
      e.offline = true;
      throw e;
    }

    let data = null;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok) {
      const e = new Error((data && data.message) || `HTTP ${response.status}`);
      e.status = response.status;
      e.code = data && data.error;
      throw e;
    }
    return data;
  }

  const admin = {
    login: (login, password) => request('/admin/auth/login', { method: 'POST', body: { login, password } }),
    session: () => request('/admin/auth/session'),
    logout: () => request('/admin/auth/logout', { method: 'POST', admin: true }),
    changePassword: (currentPassword, newPassword) => request('/admin/auth/password', {
      method: 'POST', body: { currentPassword, newPassword }, admin: true,
    }),
    state: since => request('/admin/state' + (since ? `?since=${encodeURIComponent(since)}` : ''), { admin: true }),

    blocks: {
      list: () => request('/admin/blocks', { admin: true }),
      create: data => request('/admin/blocks', { method: 'POST', body: data, admin: true }),
      update: (id, data) => request(`/admin/blocks/${id}`, { method: 'PATCH', body: data, admin: true }),
      remove: id => request(`/admin/blocks/${id}`, { method: 'DELETE', admin: true }),
      setJudges: (id, judgeIds) => request(`/admin/blocks/${id}/judges`, {
        method: 'PUT', body: { judgeIds }, admin: true,
      }),
      participants: id => request(`/admin/blocks/${id}/participants`, { admin: true }),
    },

    judges: {
      list: () => request('/admin/judges', { admin: true }),
      create: fullName => request('/admin/judges', { method: 'POST', body: { fullName }, admin: true }),
      update: (id, fullName) => request(`/admin/judges/${id}`, { method: 'PATCH', body: { fullName }, admin: true }),
      remove: id => request(`/admin/judges/${id}`, { method: 'DELETE', admin: true }),
    },

    participants: {
      list: () => request('/admin/participants', { admin: true }),
      create: data => request('/admin/participants', { method: 'POST', body: data, admin: true }),
      update: (id, data) => request(`/admin/participants/${id}`, { method: 'PATCH', body: data, admin: true }),
      remove: id => request(`/admin/participants/${id}`, { method: 'DELETE', admin: true }),
    },

    invitations: {
      list: () => request('/admin/invitations', { admin: true }),
      issue: judgeIds => request('/admin/invitations', { method: 'POST', body: { judgeIds }, admin: true }),
      revoke: judgeId => request(`/admin/invitations/${judgeId}/revoke`, { method: 'POST', admin: true }),
    },
  };

  const judge = {
    auth: token => request('/judge/auth', { method: 'POST', body: { token } }),
    state: since => request('/judge/state' + (since ? `?since=${encodeURIComponent(since)}` : ''), { judge: true }),
    me: () => request('/judge/me', { judge: true }),
    sendScores: changes => request('/judge/scores', { method: 'POST', body: { changes }, judge: true }),
  };

  global.LazurnyApi = {
    request,
    setAdminCsrf,
    getAdminCsrf,
    setJudgeToken,
    getJudgeToken,
    admin,
    judge,
  };
})(window);
