/* 公共能力：配置、登录态、HTTP 调用、日志、右侧检查器、JSON 请求体。 */
(function () {
  'use strict';

  const STORE_SETTINGS = 'tmc.settings.v1';
  const STORE_TOKEN = 'tmc.token.v1';
  const STORE_USER = 'tmc.userinfo.v1';

  const $ = (id) => document.getElementById(id);
  const qa = (selector, root) => Array.from((root || document).querySelectorAll(selector));

  const esc = (value) => String(value === undefined || value === null ? '' : value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

  const pad = (n) => String(n).padStart(2, '0');
  const dateOffset = (days) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const nowText = () => {
    const d = new Date();
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  const money = (cents) => {
    if (cents === undefined || cents === null || Number.isNaN(Number(cents))) return '-';
    return `¥${(Number(cents) / 100).toFixed(2)}`;
  };
  const parseMaybeJson = (text) => {
    if (typeof text !== 'string') return text;
    try { return JSON.parse(text); } catch { return text; }
  };

  const environments = Object.freeze({
    uat: 'https://tmc-api-uat.movatrip.cn',
    production: 'https://tmc-api.movatrip.cn',
  });
  const defaultTenant = 'E001';
  const saved = JSON.parse(localStorage.getItem(STORE_SETTINGS) || '{}') || {};
  const knownEnvironment = Object.hasOwn(environments, saved.environment);
  if (!knownEnvironment && localStorage.getItem(STORE_TOKEN)) {
    localStorage.removeItem(STORE_TOKEN);
    localStorage.removeItem(STORE_USER);
  }
  const settings = {
    environment: knownEnvironment ? saved.environment : 'uat',
    tenantCode: saved.tenantCode || defaultTenant,
    get javaBase() { return environments[this.environment]; },
    get goBase() { return this.javaBase; },
    get javaPrefix() { return '/api/tmc'; },
    get goPrefix() { return '/goco'; },
  };

  const session = {
    token: localStorage.getItem(STORE_TOKEN) || '',
    userInfo: JSON.parse(localStorage.getItem(STORE_USER) || 'null'),
  };

  const state = {
    logs: [],
    lastRequest: null,
    lastResponse: null,
    inspectorTab: 'response',
    inspectorText: '',
    findQuery: '',
    findIndex: 0,
    findMatches: [],
  };

  function saveSettings() {
    localStorage.setItem(STORE_SETTINGS, JSON.stringify({ environment: settings.environment, tenantCode: settings.tenantCode }));
    refreshBadges();
  }

  function setToken(token, userInfo) {
    session.token = (token || '').trim();
    if (session.token) localStorage.setItem(STORE_TOKEN, session.token);
    else localStorage.removeItem(STORE_TOKEN);
    if (userInfo !== undefined) {
      session.userInfo = userInfo;
      if (userInfo) localStorage.setItem(STORE_USER, JSON.stringify(userInfo));
      else localStorage.removeItem(STORE_USER);
    }
    refreshBadges();
  }

  function refreshBadges() {
    const envBadge = $('env-badge');
    const tokenBadge = $('token-badge');
    if (!envBadge || !tokenBadge) return;

    envBadge.textContent = settings.environment === 'production' ? '线上环境' : 'UAT 环境';
    envBadge.className = `badge ${settings.environment === 'production' ? 'warn' : 'ok'}`;

    if (session.token) {
      const name = session.userInfo && (session.userInfo.name || session.userInfo.employeeName);
      tokenBadge.textContent = name ? `已登录 · ${name}` : 'Token 已设置';
      tokenBadge.className = 'badge ok';
      tokenBadge.title = `${session.token.slice(0, 12)}…${session.token.slice(-6)}`;
    } else {
      tokenBadge.textContent = '未登录';
      tokenBadge.className = 'badge warn';
      tokenBadge.title = '';
    }
  }

  let toastTimer;
  function toast(message, type) {
    const box = $('toast');
    if (!box) return;
    box.textContent = message;
    box.className = `toast ${type || 'info'}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.classList.add('hidden'), 3200);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    document.body.removeChild(ta);
  }

  function buildUrl(service, path, query, environment = settings.environment) {
    const base = environments[environment];
    const prefix = (service === 'go' ? settings.goPrefix : settings.javaPrefix).replace(/\/+$/, '');
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${base}${prefix}${normalizedPath}`);
    if (query) {
      Object.entries(query).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
      });
    }
    return url.toString();
  }

  async function api(service, path, options) {
    const opts = options || {};

    let url;
    try {
      url = buildUrl(service, path, opts.query);
    } catch (error) {
      toast(`URL 拼接失败：${error.message}`, 'error');
      return { ok: false, status: 0, error: error.message };
    }

    const method = (opts.method || 'POST').toUpperCase();
    const headers = Object.assign({ Accept: 'application/json' }, opts.headers || {});
    const useAuth = opts.auth !== false && Boolean(session.token);
    if (useAuth) headers.Authorization = `Bearer ${session.token}`;

    let bodyText = opts.body;
    if (bodyText !== undefined && bodyText !== null && typeof bodyText !== 'string') {
      headers['Content-Type'] = 'application/json';
      bodyText = JSON.stringify(bodyText);
    } else if (typeof bodyText === 'string' && bodyText.trim()) {
      headers['Content-Type'] = 'application/json';
    }

    const requestSnapshot = { service, method, url, headers: { ...headers }, body: bodyText };
    const result = await window.tmcBridge.request({
      method,
      url,
      headers,
      body: bodyText,
      timeoutMs: opts.timeoutMs || 30000,
    });

    const entry = {
      id: uid(),
      time: nowText(),
      service,
      method,
      url,
      request: requestSnapshot,
      status: result.status,
      durationMs: result.durationMs,
      ok: result.ok,
      error: result.error,
      responseText: result.text,
      responseJson: result.json,
    };
    state.logs.unshift(entry);
    if (state.logs.length > 100) state.logs.length = 100;
    state.lastRequest = requestSnapshot;
    state.lastResponse = result;
    renderInspector('response');
    updateLogBadge();
    document.dispatchEvent(new CustomEvent('tmc:log', { detail: entry }));

    if (result.error) toast(result.error, 'error');
    else if (!result.ok) toast(`HTTP ${result.status}`, 'error');
    return result;
  }

  function updateLogBadge() {
    const badge = $('log-count');
    if (!badge) return;
    badge.textContent = String(state.logs.length);
    badge.classList.toggle('hidden', state.logs.length === 0);
  }

  function renderInspector(tab) {
    const meta = $('insp-meta');
    const body = $('insp-body');
    if (!meta || !body) return;
    state.inspectorTab = tab || state.inspectorTab || 'response';

    const urlEl = $('insp-url');
    if (urlEl) urlEl.textContent = state.lastRequest && state.lastRequest.url ? state.lastRequest.url : '-';

    qa('.seg[data-insp]').forEach((btn) => btn.classList.toggle('active', btn.dataset.insp === state.inspectorTab));

    if (state.inspectorTab === 'request') {
      if (!state.lastRequest) {
        meta.textContent = '还没有请求';
        showInspectorText('执行任一步骤后，这里显示最近一次请求。');
        return;
      }
      const req = state.lastRequest;
      meta.textContent = `${req.method} ${req.url}`;
      showInspectorText(req.body ? prettyBody(req.body) : '（无请求体）');
      return;
    }

    if (!state.lastResponse) {
      meta.textContent = '等待请求…';
      showInspectorText('执行任一步骤后，这里显示最近一次响应。');
      return;
    }
    const res = state.lastResponse;
    meta.textContent = res.error
      ? `网络错误 · ${res.durationMs}ms`
      : `HTTP ${res.status} · ${res.durationMs}ms`;
    meta.className = `inspector-meta ${res.ok ? 'ok' : 'error'}`;
    showInspectorText(res.error ? res.error : prettyBody(res.text));
  }

  function showInspectorText(text) {
    state.inspectorText = text || '';
    paintInspectorFind();
  }

  function updateFindCount(current, total) {
    const el = $('insp-find-count');
    if (!el) return;
    el.textContent = `${current}/${total}`;
    el.classList.toggle('empty', total === 0 && Boolean(state.findQuery));
  }

  function paintInspectorFind() {
    const body = $('insp-body');
    if (!body) return;
    const text = state.inspectorText || '';
    const query = state.findQuery || '';
    if (!query) {
      body.textContent = text;
      state.findMatches = [];
      updateFindCount(0, 0);
      return;
    }
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const matches = [];
    let from = 0;
    let index = lowerText.indexOf(lowerQuery, from);
    while (index !== -1) {
      matches.push(index);
      from = index + lowerQuery.length;
      index = lowerText.indexOf(lowerQuery, from);
    }
    state.findMatches = matches;
    if (!matches.length) {
      body.textContent = text;
      updateFindCount(0, 0);
      return;
    }
    if (state.findIndex >= matches.length) state.findIndex = 0;
    if (state.findIndex < 0) state.findIndex = matches.length - 1;

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    matches.forEach((start, hitIndex) => {
      if (start > cursor) fragment.appendChild(document.createTextNode(text.slice(cursor, start)));
      const mark = document.createElement('mark');
      mark.className = hitIndex === state.findIndex ? 'insp-hit active' : 'insp-hit';
      mark.textContent = text.slice(start, start + query.length);
      fragment.appendChild(mark);
      cursor = start + query.length;
    });
    if (cursor < text.length) fragment.appendChild(document.createTextNode(text.slice(cursor)));
    body.textContent = '';
    body.appendChild(fragment);
    updateFindCount(state.findIndex + 1, matches.length);
    const active = body.querySelector('mark.active');
    if (active) {
      const bodyRect = body.getBoundingClientRect();
      const markRect = active.getBoundingClientRect();
      if (markRect.top < bodyRect.top || markRect.bottom > bodyRect.bottom) {
        body.scrollTop += markRect.top - bodyRect.top - (body.clientHeight - markRect.height) / 2;
      }
    }
  }

  function stepInspectorFind(delta) {
    if (!state.findMatches.length) return;
    state.findIndex += delta;
    paintInspectorFind();
  }

  function openInspectorFind() {
    const bar = $('insp-find');
    const input = $('insp-find-input');
    const body = $('insp-body');
    if (!bar || !input) return;
    bar.hidden = false;
    const selection = window.getSelection();
    const selected = selection && !selection.isCollapsed ? selection.toString().trim() : '';
    if (selected && selected.length <= 100 && body && selection.anchorNode && body.contains(selection.anchorNode)) {
      input.value = selected;
      state.findQuery = selected;
      state.findIndex = 0;
      paintInspectorFind();
    }
    input.focus();
    input.select();
  }

  function closeInspectorFind() {
    const bar = $('insp-find');
    const input = $('insp-find-input');
    if (bar) bar.hidden = true;
    if (input) input.value = '';
    state.findQuery = '';
    state.findIndex = 0;
    state.findMatches = [];
    paintInspectorFind();
  }

  function prettyBody(text) {
    if (typeof text !== 'string') return JSON.stringify(text, null, 2);
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
  }

  function currentInspectorText() {
    if (state.inspectorTab === 'request') {
      return state.lastRequest ? (state.lastRequest.body || '') : '';
    }
    return state.lastResponse
      ? (state.lastResponse.error || state.lastResponse.text || '')
      : '';
  }

  /** 可编辑 JSON 请求体：返回 { set(obj), get(), textarea }。 */
  function jsonBox(container, initial) {
    container.innerHTML = `
      <details class="jsonbox">
        <summary>请求体 JSON（可编辑，执行时以此为准）</summary>
        <textarea spellcheck="false"></textarea>
      </details>`;
    const textarea = container.querySelector('textarea');
    const set = (obj) => { textarea.value = JSON.stringify(obj, null, 2); };
    if (initial !== undefined) set(initial);
    const get = () => {
      const raw = textarea.value.trim();
      if (!raw) return {};
      try {
        return JSON.parse(raw);
      } catch (error) {
        throw new Error(`请求体 JSON 解析失败：${error.message}`);
      }
    };
    return { set, get, textarea };
  }

  function renderJson(target, value) {
    if (!target) return;
    target.innerHTML = `<pre class="code">${esc(prettyBody(value))}</pre>`;
  }

  function showError(target, error) {
    if (!target) return;
    target.innerHTML = `<div class="out-error">${esc(error && error.message ? error.message : String(error))}</div>`;
  }

  function okResponse(result) {
    return result && !result.error && result.status >= 200 && result.status < 300;
  }

  /**
   * 兼容两种后端外壳：
   * 1. BaseResponse<T>：{ success, code, message, data: {...} }，取 data；
   * 2. 老 DTO：字段直接平铺在响应体上，原样返回。
   * 业务失败（success=false 或非 0 code）直接抛错，避免把失败响应当成功数据。
   */
  function unwrap(result) {
    const json = result && result.json;
    if (!json || typeof json !== 'object') {
      throw new Error((result && result.error) || '响应不是 JSON');
    }
    if (json.success === false) {
      throw new Error(json.message || json.msg || '接口返回失败');
    }
    const code = json.code;
    const codeOk = code === undefined || code === null || code === 0 || code === '0';
    if (!codeOk && json.success !== true) {
      throw new Error(json.message || json.msg || `业务失败 code=${code}`);
    }
    if (json.data !== undefined && (json.success === true || code === 0 || code === '0')) {
      return json.data;
    }
    return json;
  }

  function goData(result) {
    const json = result && result.json;
    if (!json) throw new Error(result && result.error ? result.error : '响应不是 JSON');
    if (json.code !== 0) throw new Error(json.msg || `业务失败 code=${json.code}`);
    return json.data;
  }

  const CARD_TYPES = [
    { code: 'NI', label: '身份证' },
    { code: 'P', label: '护照' },
    { code: 'GG', label: '港澳通行证' },
    { code: 'PP', label: '台湾通行证' },
    { code: 'TW', label: '台湾居民来往大陆通行证' },
    { code: 'GP', label: '外国人永久居留身份证' },
    { code: 'OB', label: '其他证件' },
  ];
  const CARD_TYPE_ALIASES = {
    1003401: 'NI', 1003402: 'P', 1003403: 'GG', 1003404: 'PP',
    1003405: 'TW', 1003406: 'GP', 1003407: 'OB',
    ID: 'NI',
  };

  function normalizeCardType(value) {
    const raw = String(value || '').trim();
    if (!raw) return 'NI';
    const hit = CARD_TYPES.find((item) => item.code.toLowerCase() === raw.toLowerCase());
    return hit ? hit.code : (CARD_TYPE_ALIASES[raw.toUpperCase()] || 'NI');
  }


  function buildPayUrl(payForm) {
    if (typeof payForm !== 'string' || !payForm.trim()) return '';
    try {
      const doc = new DOMParser().parseFromString(payForm, 'text/html');
      const form = doc.querySelector('form');
      if (!form) return '';
      const action = form.getAttribute('action') || '';
      if (!/^https?:\/\//i.test(action)) return '';
      const url = new URL(action);
      for (const input of Array.from(form.querySelectorAll('input[name]'))) {
        if (!url.searchParams.has(input.name)) {
          url.searchParams.set(input.name, input.value || '');
        }
      }
      return url.toString();
    } catch {
      return '';
    }
  }

  function openExternal(url) {
    if (window.tmcBridge && window.tmcBridge.openExternal) {
      window.tmcBridge.openExternal(url);
      return;
    }
    window.open(url, '_blank', 'noopener');
  }

  let payModalUrl = '';
  function closePayModal() {
    const overlay = $('pay-qr-modal');
    if (overlay) overlay.classList.add('hidden');
  }
  function ensurePayModal() {
    let overlay = $('pay-qr-modal');
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'pay-qr-modal';
    overlay.className = 'modal-overlay hidden';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-head">
          <strong>支付宝扫码支付</strong>
          <button class="icon-btn" id="pay-qr-close" title="关闭">×</button>
        </div>
        <div class="qr-body" id="pay-qr-body"></div>
        <div class="muted-text qr-tip">用手机支付宝扫一扫完成支付。二维码等同于支付凭证，请勿转发给他人。</div>
        <div class="modal-actions">
          <button class="ghost small" id="pay-qr-copy">复制链接</button>
          <button class="ghost small" id="pay-qr-open">浏览器打开</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closePayModal();
    });
    $('pay-qr-close').addEventListener('click', closePayModal);
    $('pay-qr-copy').addEventListener('click', () => {
      copyText(payModalUrl).then(() => toast('已复制支付链接', 'ok'));
    });
    $('pay-qr-open').addEventListener('click', () => openExternal(payModalUrl));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !overlay.classList.contains('hidden')) closePayModal();
    });
    return overlay;
  }
  function showPayModal(url) {
    const overlay = ensurePayModal();
    payModalUrl = url;
    const body = $('pay-qr-body');
    body.innerHTML = '';
    try {
      if (typeof qrcode !== 'function') throw new Error('二维码组件未加载');
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      body.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2 });
    } catch (error) {
      body.innerHTML = `<div class="empty">${esc(error.message || '二维码生成失败')}</div>`;
    }
    overlay.classList.remove('hidden');
  }

  function showPay(container, data, title) {
    if (!container || !data) return;
    const url = data.paymentUrl || buildPayUrl(data.payForm || '');
    if (!url) return;
    container.querySelectorAll('.pay-card').forEach((node) => node.remove());
    const card = document.createElement('div');
    card.className = 'card pay-card';
    const parts = [];
    if (data.orderNo) parts.push(`订单 ${esc(data.orderNo)}`);
    if (data.payOrderId) parts.push(`支付单 ${esc(data.payOrderId)}`);
    parts.push(`金额 ${money(data.payAmount)}`);
    card.innerHTML = `
      <div class="card-head">
        <strong>${esc(title || '支付宝支付')}</strong>
        <span class="badge ok">payForm 已生成</span>
      </div>
      <div class="muted-text">${parts.join(' · ')}</div>
      <div class="actions">
        <button class="primary small" data-pay-act="qr">手机扫码支付</button>
        <button class="ghost small" data-pay-act="open">浏览器打开</button>
        <button class="ghost small" data-pay-act="copy">复制支付链接</button>
      </div>
      <div class="pay-url" title="${esc(url)}">${esc(url)}</div>`;
    card.querySelector('[data-pay-act="qr"]').addEventListener('click', () => showPayModal(url));
    card.querySelector('[data-pay-act="open"]').addEventListener('click', () => openExternal(url));
    card.querySelector('[data-pay-act="copy"]').addEventListener('click', () => {
      copyText(url).then(() => toast('已复制支付链接', 'ok'));
    });
    container.appendChild(card);
  }

  window.TMC = {
    environments,
    defaultTenant,
    settings,
    session,
    state,
    $,
    qa,
    esc,
    dateOffset,
    nowText,
    uid,
    money,
    parseMaybeJson,
    saveSettings,
    setToken,
    refreshBadges,
    toast,
    copyText,
    api,
    updateLogBadge,
    renderInspector,
    currentInspectorText,
    jsonBox,
    renderJson,
    showError,
    okResponse,
    goData,
    unwrap,
    buildUrl,
    CARD_TYPES,
    normalizeCardType,
    buildPayUrl,
    showPay,
  };

  document.addEventListener('DOMContentLoaded', () => {
    refreshBadges();
    renderInspector('response');
    qa('.seg[data-insp]').forEach((btn) => {
      btn.addEventListener('click', () => renderInspector(btn.dataset.insp));
    });
    const copyReq = $('btn-copy-req');
    if (copyReq) copyReq.addEventListener('click', () => {
      const body = state.lastRequest && state.lastRequest.body;
      if (!body) { toast('当前请求没有请求体', 'info'); return; }
      copyText(body).then(() => toast('已复制请求体', 'ok'));
    });
    const copyRes = $('btn-copy-res');
    if (copyRes) copyRes.addEventListener('click', () => {
      const text = state.lastResponse
        ? (state.lastResponse.error || state.lastResponse.text || '')
        : '';
      if (!text) { toast('当前没有可复制的响应', 'info'); return; }
      copyText(text).then(() => toast('已复制响应', 'ok'));
    });
    const copyUrl = $('btn-copy-url');
    if (copyUrl) copyUrl.addEventListener('click', () => {
      const url = state.lastRequest && state.lastRequest.url;
      if (!url) { toast('当前没有可复制的 URL', 'info'); return; }
      copyText(url).then(() => toast('已复制 URL', 'ok'));
    });
    const clearBtn = $('btn-clear-insp');
    if (clearBtn) clearBtn.addEventListener('click', () => {
      state.lastRequest = null;
      state.lastResponse = null;
      renderInspector(state.inspectorTab);
    });

    const findInput = $('insp-find-input');
    if (findInput) {
      findInput.addEventListener('input', () => {
        state.findQuery = findInput.value;
        state.findIndex = 0;
        paintInspectorFind();
      });
      findInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          stepInspectorFind(event.shiftKey ? -1 : 1);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          closeInspectorFind();
        }
      });
    }
    const findPrev = $('btn-find-prev');
    if (findPrev) findPrev.addEventListener('click', () => stepInspectorFind(-1));
    const findNext = $('btn-find-next');
    if (findNext) findNext.addEventListener('click', () => stepInspectorFind(1));
    const findClose = $('btn-find-close');
    if (findClose) findClose.addEventListener('click', closeInspectorFind);

    document.addEventListener('keydown', (event) => {
      const key = (event.key || '').toLowerCase();
      if (key === 'f' && (event.ctrlKey || event.metaKey) && !event.altKey) {
        event.preventDefault();
        window.BookingPreview?.showRaw();
        openInspectorFind();
      } else if (key === 'escape' && !$('insp-find').hidden) {
        closeInspectorFind();
      }
    });
  });
})();
