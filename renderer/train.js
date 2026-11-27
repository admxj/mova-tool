(function () {
  'use strict';
  const { $, unwrap, goData, okResponse, renderJson, showError, settings, session, dateOffset } = window.TMC;
  const el = id => $(`tr-${id}`);
  const value = id => el(id).value.trim();
  const context = () => JSON.stringify([settings.environment, settings.tenantCode, session.token, session.userInfo]);
  let previous = context();
  let accountId;
  let busy = false;
  let ready = false;
  let pending = false;
  const lists = {};
  const pickers = {};
  const pick = id => pickers[id] ? pickers[id].selected : lists[id]?.[value(id) === '' ? -1 : Number(value(id))];
  const searchFormKey = 'tmc.train.search.v1';
  function saveSearchForm() {
    try {
      localStorage.setItem(searchFormKey, JSON.stringify({ from: pick('from'), to: pick('to'), date: value('date') }));
    } catch { /* 存储不可用时不影响查询 */ }
  }
  function restoreSearchForm() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(searchFormKey)); } catch { /* 忽略损坏的记录 */ }
    for (const side of ['from', 'to']) {
      const station = saved?.[side];
      pickers[side].reset(typeof station?.stationName === 'string' && station.stationName &&
        typeof station?.stationCode === 'string' && station.stationCode ? station : undefined);
    }
    el('date').value = typeof saved?.date === 'string' ? saved.date : '';
    if (!el('date').value) el('date').value = dateOffset(0);
  }
  const seatSpecs = [
    ['edz', '二等座'], ['ydz', '一等座'], ['yxydz', '优选一等'], ['tdz', '特等座'], ['swz', '商务座'],
    ['yz', '硬座'], ['rz', '软座'], ['yw', '硬卧'], ['rw', '软卧'], ['dw', '动卧'], ['gjrw', '高级软卧'], ['wz', '无座'],
  ];
  const trainTypes = { C: '城际', D: '动车', G: '高铁', K: '快速', T: '特快', Z: '直达' };
  const trainHint = '输入出发站、到达站和日期后点击「查余票」，车次列表会显示在这里。';
  const esc = text => String(text ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  let trains = [];
  let hiddenCount = 0;
  const request = async (service, path, options) => {
    if (!session.token) throw Error('请先登录');
    const response = await window.TMC.api(service, path, options);
    if (!okResponse(response)) throw Error(response?.error || response?.json?.message || response?.json?.msg || `HTTP ${response?.status}`);
    return service === 'go' ? goData(response) : unwrap(response);
  };
  const flow = window.TrainBooking.createBooking({ request, context, key: () => crypto.randomUUID() });
  const java = (path, body) => request('java', path, body === undefined ? { method: 'GET' } : { body });
  function fill(id, items, label) {
    lists[id] = items;
    const select = el(id);
    select.replaceChildren(...(select.multiple ? [] : [new Option('请选择', '')]), ...items.map((item, index) => new Option(label(item), index)));
  }
  function stockText(raw) {
    const text = String(raw).trim();
    if (text === '' || text === '有') return '有票';
    if (text === '无' || text === '0') return '无票';
    if (/^\d+$/.test(text)) return Number(text) > 20 ? '有票' : `${Number(text)}张`;
    return text;
  }
  function trainSeats(trip) {
    if (!trip || trip.canSale === 'N' || trip.canBuyNow === 'N') return [];
    return seatSpecs.flatMap(([id, label]) => {
      const raw = trip[`${id}Num`];
      if (raw === undefined || raw === null) return [];
      const text = String(raw).trim();
      if (text === '--') return [];
      const price = Number(trip[`${id}Price`]);
      const stock = stockText(text);
      return [{ code: id.toUpperCase(), label, stock, price: Number.isFinite(price) && price > 0 ? price : 0, bookable: stock !== '无票' && Number.isFinite(price) && price > 0 }];
    });
  }
  function minPrice(trip) {
    return trainSeats(trip).reduce((min, seat) => seat.price > 0 && (!min || seat.price < min) ? seat.price : min, 0);
  }
  function onSale(trip) {
    const matched = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(trip.sellTicketDate ?? '').trim());
    if (!matched) return true;
    const at = new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]), Number(matched[4] || 0), Number(matched[5] || 0), Number(matched[6] || 0)).getTime();
    return !Number.isFinite(at) || Date.now() >= at;
  }
  const selectedIndex = () => el('trip').value === '' ? -1 : Number(el('trip').value);
  function highlightTrain() {
    const index = selectedIndex();
    for (const card of el('trains').querySelectorAll('.train-card')) {
      const active = Number(card.dataset.index) === index;
      card.classList.toggle('is-selected', active);
      card.querySelector('.train-pick')?.setAttribute('aria-pressed', String(active));
    }
  }
  function resetTrains() {
    trains = [];
    hiddenCount = 0;
    el('trains').replaceChildren();
    el('summary').textContent = trainHint;
  }
  function trainTags(trip) {
    return [
      trainTypes[trip.trainType] || trip.trainType,
      trip.fromStationName && trip.startStationName ? (trip.fromStationName === trip.startStationName ? '始发' : '过路') : '',
      trip.toStationName && trip.endStationName && trip.toStationName !== trip.endStationName ? '过' : '',
      trip.isQuietCoach === true ? '静音' : '',
    ].filter(Boolean).map(tag => `<span class="train-tag">${esc(tag)}</span>`).join('');
  }
  function trainCard(trip, index) {
    const chips = trainSeats(trip).map(seat => `<button type="button" class="seat-chip${seat.bookable ? '' : ' is-out'}" data-train-pick="${index}" data-seat-code="${seat.code}"${seat.bookable ? '' : ' disabled'}>${esc(seat.label)} <b>${esc(seat.stock)}</b>${seat.price ? ` <span class="price">¥${seat.price}</span>` : ''}</button>`).join('');
    const days = Number(trip.arriveDays) > 0 ? `<span class="train-tag train-tag--days">+${Number(trip.arriveDays)}天</span>` : '';
    const price = minPrice(trip);
    return `<article class="card train-card${selectedIndex() === index ? ' is-selected' : ''}" data-index="${index}">
      <button type="button" class="train-pick" data-train-pick="${index}" aria-pressed="${selectedIndex() === index}">
        <span class="train-id"><b>${esc(trip.trainCode || trip.trainNo)}</b>${trainTags(trip)}</span>
        <span class="train-route"><span class="train-end"><b>${esc(trip.startTime || '--')}</b><small>${esc(trip.fromStationName || '--')}</small></span><span class="train-arrow">→<small>${esc(trip.runTime || '')}</small></span><span class="train-end"><b>${esc(trip.arriveTime || '--')}${days}</b><small>${esc(trip.toStationName || '--')}</small></span></span>
        <span class="train-price">${price ? `¥${price} 起` : '暂无报价'}</span>
      </button>
      <div class="train-seats">${chips || '<span class="hint">暂无可售席别</span>'}</div>
    </article>`;
  }
  function renderTrains() {
    const box = el('trains');
    if (!trains.length) {
      box.innerHTML = `<div class="empty">${hiddenCount ? `筛选后没有可预订车次，${hiddenCount} 个车次未开售` : '没有查到车次，请调整车站或日期后重试'}</div>`;
      el('summary').textContent = hiddenCount ? `没有可预订车次，已隐藏 ${hiddenCount} 个未开售车次` : '没有查到车次';
      return;
    }
    box.innerHTML = trains.map(trainCard).join('');
    const price = trains.reduce((min, trip) => { const value = minPrice(trip); return value > 0 && (!min || value < min) ? value : min; }, 0);
    el('summary').textContent = `共 ${trains.length} 个车次${price ? `，最低 ¥${price} 起` : ''}${hiddenCount ? `；已隐藏 ${hiddenCount} 个未开售车次` : ''}`;
    highlightTrain();
  }
  function showSeats(trip) {
    const available = trainSeats(trip).filter(seat => seat.bookable);
    fill('seat', available, seat => `${seat.label} · 余票 ${seat.stock}${seat.price ? ` · ¥${seat.price}` : ''}`);
    return available;
  }
  function selectTrain(index, seatCode) {
    if (busy || !Number.isInteger(index) || !trains[index]) return;
    invalidate();
    el('trip').value = String(index);
    const available = showSeats(trains[index]);
    if (seatCode) {
      const at = available.findIndex(seat => seat.code === seatCode);
      if (at >= 0) el('seat').value = String(at);
    }
    highlightTrain();
    controls();
  }
  function refreshSelection() {
    const trip = pick('trip'), seat = pick('seat');
    el('book').disabled = busy || !trip || !seat;
    const text = trip ? `已选 ${trip.trainCode || trip.trainNo} · ${trip.fromStationName || ''} ${trip.startTime || ''} → ${trip.toStationName || ''} ${trip.arriveTime || ''}${seat ? ` · ${seat.label}` : ' · 待选席别'}` : '';
    el('selection').textContent = text;
    el('selection').hidden = !text;
  }
  const passengerIds = new Set();
  function masked(value) {
    const text = String(value ?? '').trim();
    if (!text || /[*＊]/.test(text)) return text;
    return text.length > 7 ? `${text.slice(0, 3)}****${text.slice(-4)}` : '****';
  }
  function updatePassengers() {
    const buttons = [...el('passengers').querySelectorAll('.pax-item')];
    for (const button of buttons) {
      const selected = passengerIds.has(Number(button.dataset.id));
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', selected);
      button.querySelector('.pax-choice').textContent = selected ? '✓ 已选' : '未选';
    }
    el('pax-hint').textContent = buttons.length ? `共 ${buttons.length} 位企业乘车人 · 已选 ${passengerIds.size} 人（可多选）` : '没有查到企业乘车人';
  }
  function renderPassengers(items, hint) {
    passengerIds.clear();
    if (items.length === 1) passengerIds.add(Number(items[0].id));
    el('passengers').innerHTML = items.map(person => `<button type="button" class="pax-item" data-id="${Number(person.id)}">
      <b>${esc(person.name || person.realName || `乘车人 ${person.id}`)}</b>
      <span class="muted-text">${esc([person.cardTypeDesc || person.cardType, masked(person.cardNoMask || person.cardNo)].filter(Boolean).join(' '))}</span>
      <span class="muted-text">${esc(masked(person.mobileMask || person.mobile))}</span>
      <span class="pax-choice"></span></button>`).join('');
    updatePassengers();
    if (hint) el('pax-hint').textContent = hint;
  }
  function controls() {
    el('load').disabled = busy;
    for (const button of el('passengers').querySelectorAll('.pax-item')) button.disabled = busy;
    el('confirm').disabled = busy || !pending;
    el('submit').disabled = busy || !ready;
    refreshSelection();
  }
  function invalidate() {
    flow.reset();
    pending = ready = false;
    controls();
  }
  function syncContext() {
    const current = context();
    if (previous === current) return;
    previous = current;
    invalidate();
    accountId = undefined;
    restoreSearchForm();
    for (const id of ['trip', 'seat']) fill(id, [], () => '');
    renderPassengers([], '请先加载企业乘车人');
    for (const id of ['contact', 'phone', 'apply', 'reason', 'order-no']) el(id).value = '';
    el('output').replaceChildren();
    resetTrains();
    controls();
  }
  function action(id, fn) {
    el(id).addEventListener('click', async () => {
      syncContext();
      if (busy) return;
      busy = true;
      const ctx = context();
      const guard = () => { if (ctx !== context()) throw Error('环境、租户或登录已变更，请重新操作'); };
      const inputs = [...$('view-train').querySelectorAll('input, select')];
      inputs.forEach(input => { input.disabled = true; });
      controls();
      try { await fn(guard); guard(); } catch (error) {
        if (id === 'load' && ctx === context()) el('pax-hint').textContent = `加载失败：${error.message}`;
        syncContext(); showError(el('output'), error);
      }
      finally { busy = false; inputs.forEach(input => { input.disabled = false; }); controls(); }
    });
  }
  const output = result => renderJson(el('output'), result);
  function query() {
    const from = pick('from'), to = pick('to');
    if (!from || !to || from.stationCode === to.stationCode || !value('date')) throw Error('请选择不同的出发站、到达站和出行日期');
    return { trainDate: value('date'), fromStation: from.stationCode, toStation: to.stationCode };
  }
  function clearTrip() {
    saveSearchForm();
    invalidate();
    fill('trip', [], () => '');
    fill('seat', [], () => '');
    el('output').replaceChildren();
    resetTrains();
    controls();
  }
  for (const side of ['from', 'to']) {
    el(side).addEventListener('focus', syncContext);
    pickers[side] = window.TrainStationPicker.mount({
      input: el(side), list: el(`${side}-options`), status: el(`${side}-status`), context,
      request: stationName => java('/train/station/search', { stationName }), onChange: clearTrip,
    });
  }
  action('search', async guard => {
    invalidate();
    fill('trip', [], () => '');
    fill('seat', [], () => '');
    resetTrains();
    el('summary').textContent = '查询中…';
    try {
      const data = await java('/train/search', { ...query(), purposeCodes: 'ADULT', compress: 0 });
      guard();
      if (data?.success === false) throw Error(data.errorMsg || data.msg || '余票查询失败');
      const rows = Array.isArray(data) ? data : data?.data;
      const items = (Array.isArray(rows) ? rows : []).flatMap(row => Array.isArray(row?.data) ? row.data : [row]).filter(row => row?.trainCode && row.trainNo);
      trains = items.filter(onSale);
      hiddenCount = items.length - trains.length;
      fill('trip', trains, row => `${row.trainCode} ${row.fromStationName || ''} ${row.startTime || ''} → ${row.toStationName || ''} ${row.arriveTime || ''}`);
      renderTrains();
      output({ 车次数量: items.length, 可订车次: trains.length, 未开售: hiddenCount });
    } catch (error) {
      el('summary').textContent = `查询失败：${error.message}`;
      el('trains').replaceChildren();
      throw error;
    }
  });
  action('info', async guard => {
    const trip = pick('trip');
    if (!trip) throw Error('请选择车次');
    const result = await java('/train/info', { ...query(), trainNo: trip.trainNo, trainCode: trip.trainCode });
    guard(); output(result);
  });
  action('load', async guard => {
    invalidate(); accountId = undefined;
    renderPassengers([], '正在加载企业乘车人及绑定账号…');
    const passengers = await java('/passenger/list', { source: 'ORG', pageNum: 1, pageSize: 100 });
    guard();
    const account = await java('/train/accounts/12306');
    guard();
    const id = Number(account?.accountId);
    if (!Number.isSafeInteger(id) || id <= 0 || String(account?.riskStatus).trim().toUpperCase() !== 'NORMAL') throw Error('当前 12306 账号未绑定或需要核验，请先在商旅端处理');
    accountId = id;
    const items = (passengers?.list || []).filter(person => person.source === 'ORG' && Number.isSafeInteger(Number(person.id)) && Number(person.id) > 0);
    renderPassengers(items);
    if (!value('phone')) el('phone').value = items[0]?.mobile || session.userInfo?.mobile || '';
    output({ 账号状态: '可预订', 企业乘车人数量: items.length });
  });
  function showPrepared(result) {
    pending = result.kind === 'confirm';
    ready = result.kind === 'ready';
    const { quoteToken, ...quote } = result.quote;
    output({ 下一步: pending ? '确认差标结果' : '可提交占座', quote, policy: result.policy });
  }
  action('prepare', async guard => {
    invalidate();
    const trip = pick('trip'), seat = pick('seat'), from = pick('from'), to = pick('to');
    if (!trip || !seat || !from || !to) throw Error('请选择车次及有余票的席别');
    if (!from.cityCode || !to.cityCode) throw Error('车站缺少业务城市编码');
    const employeeId = Number(session.userInfo?.employeeId);
    const employeeNo = String(session.userInfo?.employee_no ?? '').trim();
    const employee = Number.isSafeInteger(employeeId) && employeeId > 0 ? { employeeId } : employeeNo ? { employeeNo } : {};
    const result = await flow.prepare({
      quote: { trainDate: value('date'), fromStationCode: trip.fromStationCode || from.stationCode,
        fromStationName: trip.fromStationName || from.stationName, fromCityCode: from.cityCode, fromCityName: from.cityName,
        toStationCode: trip.toStationCode || to.stationCode, toStationName: trip.toStationName || to.stationName,
        toCityCode: to.cityCode, toCityName: to.cityName, trainNo: trip.trainNo, trainCode: trip.trainCode, seatType: seat.code },
      departTime: trip.startTime, accountId, passengerIds: [...passengerIds],
      contactName: value('contact'), contactPhone: value('phone'), applyNo: value('apply'), employee,
    });
    guard(); showPrepared(result);
  });
  action('confirm', async guard => { const result = await flow.confirmPolicy({ reason: value('reason') }); guard(); showPrepared(result); });
  action('submit', async guard => {
    if (!ready || !window.confirm(`确定向${settings.environment === 'production' ? '线上' : settings.environment}提交占座？不会支付或出票。`)) return;
    guard();
    const order = await flow.submit();
    guard(); ready = false; el('order-no').value = order.orderNo; output(order);
  });
  action('status', async guard => { const result = await flow.status(value('order-no')); guard(); output(result); });
  for (const id of ['from', 'to', 'date']) el(id).addEventListener('change', () => {
    if (id === 'date') saveSearchForm();
    invalidate(); fill('trip', [], () => ''); fill('seat', [], () => ''); resetTrains(); controls();
  });
  el('trains').addEventListener('click', event => {
    const target = event.target.closest('[data-train-pick]');
    if (!target || target.disabled) return;
    selectTrain(Number(target.dataset.trainPick), target.dataset.seatCode);
  });
  el('trip').addEventListener('change', () => {
    invalidate();
    showSeats(pick('trip'));
    highlightTrain();
    controls();
  });
  el('book').addEventListener('click', () => {
    syncContext();
    if (busy) return;
    const trip = pick('trip'), seat = pick('seat');
    if (!trip || !seat) {
      el('summary').textContent = trip ? '请选择有余票的席别后再继续' : '请先在列表中选择车次和席别';
      return;
    }
    const step = $('tr-step-2');
    step.scrollIntoView({ behavior: 'smooth', block: 'start' });
    step.classList.add('is-target');
    setTimeout(() => step.classList.remove('is-target'), 1600);
    setTimeout(() => (el('passengers').querySelector('.pax-item') || el('load')).focus({ preventScroll: true }), 350);
  });
  el('passengers').addEventListener('click', event => {
    const button = event.target.closest('.pax-item');
    if (busy || !button) return;
    syncContext();
    if (!el('passengers').contains(button)) return;
    const id = Number(button.dataset.id);
    if (!passengerIds.delete(id)) passengerIds.add(id);
    updatePassengers();
    invalidate();
  });
  for (const id of ['seat', 'contact', 'phone', 'apply']) el(id).addEventListener('input', invalidate);
  document.querySelector('[data-view="train"]').addEventListener('click', syncContext);
  restoreSearchForm();
})();
