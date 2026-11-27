/* 应用外壳：视图切换、登录、设置、日志。 */
(function () {
  'use strict';

  const {
    $, qa, esc, toast, settings, saveSettings, session, setToken, refreshBadges,
    api, goData, state, uid, renderInspector, copyText,
    environments, defaultTenant, buildUrl,
  } = window.TMC;

  /* ---------------- 视图切换 ---------------- */

  function showView(name) {
    window.BookingPreview.view(name);
    qa('.tab[data-view]').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === name));
    qa('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${name}`));
    if (name === 'logs') renderLogs();
  }

  qa('.tab[data-view]').forEach((tab) => {
    tab.addEventListener('click', () => showView(tab.dataset.view));
  });

  qa('.subtab[data-login-mode]').forEach((tab) => {
    tab.addEventListener('click', () => {
      qa('.subtab[data-login-mode]').forEach((item) => item.classList.toggle('active', item === tab));
      qa('[data-login-panel]').forEach((panel) => {
        panel.classList.toggle('hidden', panel.dataset.loginPanel !== tab.dataset.loginMode);
      });
    });
  });

  /* ---------------- 设置 ---------------- */

  let environmentRevision = 0;

  function fillSettingsForm() {
    $('s-environment').value = settings.environment;
    $('s-tenant').value = settings.tenantCode;
    $('login-tenant').value = settings.tenantCode;
    $('login-sms-tenant').value = settings.tenantCode;
    renderSettingsPreview();
  }

  function renderSettingsPreview() {
    const environment = $('s-environment').value;
    const url = (service, path) => buildUrl(service, path, undefined, environment);
    $('settings-preview').textContent = [
      `机票搜索  POST ${url('java', '/flight/search')}`,
      `机票验价  POST ${url('java', '/air/order/price')}`,
      `酒店搜索  POST ${url('java', '/hotel/search')}`,
      `酒店验价  POST ${url('java', '/hotel/orders/price')}`,
      `账号登录  POST ${url('go', '/v1/co/front/login')}`,
    ].join('\n');
  }

  $('btn-save-settings').addEventListener('click', () => {
    const environment = $('s-environment').value;
    if (!Object.hasOwn(environments, environment)) return;
    if (environment !== settings.environment) {
      environmentRevision += 1;
      setToken('', null);
      for (const id of ['login-tenants', 'login-userinfo', 'login-account-hint', 'login-sms-hint', 'login-smsCode', 'login-captchaId', 'login-captchaCode']) {
        const field = $(id);
        if (field.tagName === 'INPUT') field.value = '';
        else field.textContent = '';
      }
    }
    settings.environment = environment;
    settings.tenantCode = $('s-tenant').value.trim() || defaultTenant;
    saveSettings();
    fillSettingsForm();
    $('settings-hint').textContent = '已保存到本机 localStorage';
    toast('接口配置已保存', 'ok');
  });

  $('s-environment').addEventListener('change', renderSettingsPreview);

  /* ---------------- 登录 ---------------- */

  function browserId() {
    const key = 'tmc.browserId';
    let value = localStorage.getItem(key);
    if (!value) {
      value = uid();
      localStorage.setItem(key, value);
    }
    return value;
  }

  function tenantCodeFrom(...values) {
    for (const value of values) {
      const text = String(value || '').trim();
      if (text) return /^\d+$/.test(text) ? Number(text) : text;
    }
    return undefined;
  }

  function loginBody(base) {
    const body = Object.assign({}, base, { browserId: browserId() });
    Object.keys(body).forEach((key) => { if (body[key] === undefined) body[key] = undefined; });
    return body;
  }

  function applyLoginData(data) {
    if (!data) throw new Error('登录响应缺少 data');
    if (data.needSelect) return { needSelect: true, preAuthToken: data.preAuthToken, tenants: data.tenants || [] };
    const token = data.token || data.preAuthToken;
    if (!token) throw new Error('登录响应缺少 token');
    setToken(token, data.userInfo || null);
    return { needSelect: false, token };
  }

  function renderTenantPicker(preAuthToken, tenants, hintTarget) {
    const container = $('login-tenants');
    if (!Array.isArray(tenants) || tenants.length === 0) {
      hintTarget.textContent = '需要选择租户，但响应里没有 tenants';
      return;
    }
    container.innerHTML = `
      <div class="card">
        <div class="card-head"><strong>选择租户</strong><span class="muted-text">preAuthToken 已获取</span></div>
        <div class="tenant-list">
          ${tenants.map((tenant, index) => `
            <button class="ghost tenant" data-tenant-pick="${index}">
              <b>${esc(tenant.tenantName || tenant.tenantCode || '租户')}</b>
              <span>${esc(tenant.employeeName || '')} ${tenant.phone ? '· ' + esc(String(tenant.phone).replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2')) : ''}</span>
            </button>`).join('')}
        </div>
      </div>`;
    container.querySelectorAll('[data-tenant-pick]').forEach((button) => {
      button.addEventListener('click', async () => {
        const tenant = tenants[Number(button.dataset.tenantPick)];
        const revision = environmentRevision;
        const result = await api('go', '/v1/co/front/login/confirm', {
          body: { preAuthToken, tenantCode: tenant.tenantCode },
          auth: false,
        });
        if (revision !== environmentRevision) return;
        try {
          const data = goData(result);
          const token = data && (data.token || data.preAuthToken);
          if (!token) throw new Error('确认登录响应缺少 token');
          setToken(token, data.userInfo || null);
          container.innerHTML = '<div class="out-ok">登录成功</div>';
          hintTarget.textContent = '登录成功';
          if (tenant.tenantCode) settings.tenantCode = String(tenant.tenantCode);
          await loadUserInfo();
          toast('登录成功', 'ok');
        } catch (error) {
          hintTarget.textContent = error.message;
          toast(error.message, 'error');
        }
      });
    });
  }

  async function loadUserInfo() {
    if (!session.token) return null;
    const revision = environmentRevision;
    const result = await api('go', '/v1/co/front/user/info', { method: 'GET' });
    if (revision !== environmentRevision) return;
    try {
      const data = goData(result);
      session.userInfo = data;
      localStorage.setItem('tmc.userinfo.v1', JSON.stringify(data));
      if (data && data.tenantCode && !settings.tenantCode) {
        settings.tenantCode = String(data.tenantCode);
        saveSettings();
      }
      refreshBadges();
      const box = $('login-userinfo');
      if (box) box.innerHTML = `<pre class="code">${esc(JSON.stringify(data, null, 2))}</pre>`;
      return data;
    } catch (error) {
      const box = $('login-userinfo');
      if (box) box.innerHTML = `<div class="out-error">${esc(error.message)}</div>`;
      return null;
    }
  }

  async function loginWithAccount() {
    const account = $('login-account').value.trim();
    const password = $('login-password').value;
    if (!account || !password) return toast('请填写账号和密码', 'error');
    $('login-account-hint').textContent = '登录中…';
    $('login-tenants').innerHTML = '';

    const body = {
      loginAccount: account,
      password,
      tenantCode: tenantCodeFrom($('login-tenant').value, settings.tenantCode),
      browserId: browserId(),
    };
    const captchaId = $('login-captchaId').value.trim();
    const captchaCode = $('login-captchaCode').value.trim();
    if (captchaId) body.captchaId = captchaId;
    if (captchaCode) body.captchaCode = captchaCode;

    const revision = environmentRevision;
    const result = await api('go', '/v1/co/front/login', { body, auth: false });
    if (revision !== environmentRevision) return;
    try {
      const data = goData(result);
      const applied = applyLoginData(data);
      if (applied.needSelect) {
        $('login-account-hint').textContent = '请选择要登录的租户';
        renderTenantPicker(applied.preAuthToken, applied.tenants, $('login-account-hint'));
        return;
      }
      $('login-account-hint').textContent = '登录成功';
      await loadUserInfo();
      toast('登录成功', 'ok');
    } catch (error) {
      $('login-account-hint').textContent = error.message;
      toast(error.message, 'error');
    }
  }

  async function loginWithSms() {
    const mobile = $('login-mobile').value.trim();
    const smsCode = $('login-smsCode').value.trim();
    if (!mobile || !smsCode) return toast('请填写手机号和验证码', 'error');
    $('login-sms-hint').textContent = '登录中…';
    const body = {
      mobile,
      smsCode,
      browserId: browserId(),
      tenantCode: tenantCodeFrom($('login-sms-tenant').value, settings.tenantCode),
    };
    const revision = environmentRevision;
    const result = await api('go', '/v1/co/front/login/sms', { body, auth: false });
    if (revision !== environmentRevision) return;
    try {
      const applied = applyLoginData(goData(result));
      if (applied.needSelect) {
        $('login-sms-hint').textContent = '请选择要登录的租户';
        renderTenantPicker(applied.preAuthToken, applied.tenants, $('login-sms-hint'));
        return;
      }
      $('login-sms-hint').textContent = '登录成功';
      await loadUserInfo();
      toast('登录成功', 'ok');
    } catch (error) {
      $('login-sms-hint').textContent = error.message;
      toast(error.message, 'error');
    }
  }

  async function sendSmsCode() {
    const mobile = $('login-mobile').value.trim();
    if (!mobile) return toast('请填写手机号', 'error');
    const button = $('btn-send-sms');
    button.disabled = true;
    try {
      const result = await api('go', '/v1/co/front/login/sms/send', {
        body: { mobile, browserId: browserId(), tenantCode: tenantCodeFrom($('login-sms-tenant').value, settings.tenantCode) },
        auth: false,
      });
      goData(result);
      $('login-sms-hint').textContent = '验证码已发送';
      toast('验证码已发送', 'ok');
    } catch (error) {
      $('login-sms-hint').textContent = error.message;
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function loginWithToken() {
    const token = $('login-token-input').value.trim();
    if (!token) return toast('请粘贴 token', 'error');
    setToken(token);
    $('login-token-hint').textContent = '已保存 token，正在校验…';
    const info = await loadUserInfo();
    $('login-token-hint').textContent = info ? 'Token 有效' : 'Token 已保存，但用户信息校验失败';
  }

  $('btn-login-account').addEventListener('click', loginWithAccount);
  $('btn-send-sms').addEventListener('click', sendSmsCode);
  $('btn-login-sms').addEventListener('click', loginWithSms);
  $('btn-login-token').addEventListener('click', loginWithToken);
  $('btn-logout').addEventListener('click', () => {
    setToken('', null);
    $('login-token-hint').textContent = '已清除登录态';
    $('login-userinfo').innerHTML = '';
    toast('已退出登录', 'ok');
  });

  /* ---------------- 日志 ---------------- */

  function statusClass(entry) {
    if (entry.error) return 'error';
    if (entry.status >= 200 && entry.status < 300) return 'ok';
    return 'warn';
  }

  function renderLogs() {
    const list = $('log-list');
    if (!list) return;
    if (!state.logs.length) {
      list.innerHTML = '<div class="empty">还没有请求。执行任一步骤后会出现在这里。</div>';
      return;
    }
    list.innerHTML = state.logs.map((entry) => {
      const url = entry.url.replace(/^https?:\/\/[^/]+/, '');
      return `
        <button class="log-row" data-log-id="${entry.id}">
          <span class="log-time">${esc(entry.time)}</span>
          <span class="log-method">${esc(entry.method)}</span>
          <span class="log-url" title="${esc(entry.url)}">${esc(url)}</span>
          <span class="badge ${statusClass(entry)}">${entry.error ? 'ERR' : entry.status}</span>
          <span class="log-duration">${entry.durationMs || 0}ms</span>
        </button>`;
    }).join('');

    list.querySelectorAll('[data-log-id]').forEach((button) => {
      button.addEventListener('click', () => {
        const entry = state.logs.find((item) => item.id === button.dataset.logId);
        if (!entry) return;
        state.lastRequest = entry.request;
        state.lastResponse = {
          ok: entry.ok,
          status: entry.status,
          error: entry.error,
          text: entry.responseText,
          json: entry.responseJson,
          durationMs: entry.durationMs,
        };
        renderInspector('response');
        showView('flight');
      });
    });
  }

  $('btn-clear-logs').addEventListener('click', () => {
    state.logs.length = 0;
    window.TMC.updateLogBadge();
    renderLogs();
    toast('日志已清空', 'ok');
  });

  document.addEventListener('tmc:log', () => {
    if ($('view-logs').classList.contains('active')) renderLogs();
  });

  /* ---------------- 启动 ---------------- */

  document.addEventListener('DOMContentLoaded', () => {
    fillSettingsForm();
    refreshBadges();
    if (window.FlightFlow) window.FlightFlow.init();
    if (window.HotelFlow) window.HotelFlow.init();

    if (session.token) {
      $('login-token-input').value = session.token;
      loadUserInfo();
    }
    renderLogs();
    const updateStatus = $('update-status');
    window.tmcBridge?.onUpdateStatus?.((phase, percent) => {
      const message = phase === 'checking' ? '正在检查更新…' :
        phase === 'downloading' ? `正在下载更新… ${percent}%` : '';
      updateStatus.textContent = message;
      updateStatus.hidden = !message;
    });
    document.documentElement.dataset.tmcReady = '1';
  });
})();
