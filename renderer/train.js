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
  const pick = id => lists[id]?.[value(id) === '' ? -1 : Number(value(id))];
  const seats = { swz: '商务座', tdz: '特等座', ydz: '一等座', edz: '二等座', rw: '软卧', yw: '硬卧', rz: '软座', yz: '硬座', wz: '无座' };
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
  function controls() {
    el('confirm').disabled = busy || !pending;
    el('submit').disabled = busy || !ready;
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
    for (const id of ['from', 'to', 'trip', 'seat', 'passengers']) fill(id, [], () => '');
    for (const id of ['contact', 'phone', 'apply', 'reason', 'order-no']) el(id).value = '';
    el('output').replaceChildren();
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
      try { await fn(guard); guard(); } catch (error) { syncContext(); showError(el('output'), error); }
      finally { busy = false; inputs.forEach(input => { input.disabled = false; }); controls(); }
    });
  }
  const output = result => renderJson(el('output'), result);
  function query() {
    const from = pick('from'), to = pick('to');
    if (!from || !to || from.stationCode === to.stationCode || !value('date')) throw Error('请选择不同的出发站、到达站和出行日期');
    return { trainDate: value('date'), fromStation: from.stationCode, toStation: to.stationCode };
  }
  for (const side of ['from', 'to']) action(`find-${side}`, async guard => {
    invalidate();
    fill(side, [], () => '');
    fill('trip', [], () => '');
    fill('seat', [], () => '');
    const data = await java('/train/station/search', { stationName: value(`${side}-key`) });
    guard();
    const items = (data?.groups || []).flatMap(group => group.stations || []).filter(item => item.stationCode);
    fill(side, items, item => `${item.stationName}（${item.stationCode}）`);
    if (items.length === 1) el(side).selectedIndex = 1;
    output({ 车站数量: items.length });
  });
  action('search', async guard => {
    invalidate();
    fill('trip', [], () => '');
    fill('seat', [], () => '');
    const data = await java('/train/search', { ...query(), purposeCodes: 'ADULT', compress: 0 });
    guard();
    if (data?.success === false) throw Error(data.errorMsg || data.msg || '余票查询失败');
    const rows = Array.isArray(data) ? data : data?.data;
    const items = (Array.isArray(rows) ? rows : []).flatMap(row => Array.isArray(row?.data) ? row.data : [row]).filter(row => row?.trainCode && row.trainNo);
    fill('trip', items, row => `${row.trainCode} ${row.fromStationName || ''} ${row.startTime || ''} → ${row.toStationName || ''} ${row.arriveTime || ''}`);
    output({ 车次数量: items.length });
  });
  action('info', async guard => {
    const trip = pick('trip');
    if (!trip) throw Error('请选择车次');
    const result = await java('/train/info', { ...query(), trainNo: trip.trainNo, trainCode: trip.trainCode });
    guard(); output(result);
  });
  action('load', async guard => {
    invalidate(); accountId = undefined;
    fill('passengers', [], () => '');
    const passengers = await java('/passenger/list', { source: 'ORG', pageNum: 1, pageSize: 100 });
    guard();
    const account = await java('/train/accounts/12306');
    guard();
    const id = Number(account?.accountId);
    if (!Number.isSafeInteger(id) || id <= 0 || String(account?.riskStatus).trim().toUpperCase() !== 'NORMAL') throw Error('当前 12306 账号未绑定或需要核验，请先在商旅端处理');
    accountId = id;
    const items = (passengers?.list || []).filter(person => person.source === 'ORG' && Number.isSafeInteger(Number(person.id)) && Number(person.id) > 0);
    fill('passengers', items, person => person.name || person.realName || `乘车人 ${person.id}`);
    if (items.length === 1) el('passengers').selectedIndex = 0;
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
    const employeeNo = [session.userInfo?.employeeId, session.userInfo?.employee_no].map(id => String(id || '').trim()).find(id => /^\d+$/.test(id));
    const result = await flow.prepare({
      quote: { trainDate: value('date'), fromStationCode: trip.fromStationCode || from.stationCode,
        fromStationName: trip.fromStationName || from.stationName, fromCityCode: from.cityCode, fromCityName: from.cityName,
        toStationCode: trip.toStationCode || to.stationCode, toStationName: trip.toStationName || to.stationName,
        toCityCode: to.cityCode, toCityName: to.cityName, trainNo: trip.trainNo, trainCode: trip.trainCode, seatType: seat.code },
      departTime: trip.startTime, accountId, passengerIds: [...el('passengers').selectedOptions].map(option => Number(lists.passengers[Number(option.value)].id)),
      contactName: value('contact'), contactPhone: value('phone'), applyNo: value('apply'), employee: employeeNo ? { employeeNo } : {},
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
    invalidate(); fill('trip', [], () => ''); fill('seat', [], () => '');
  });
  el('trip').addEventListener('change', () => {
    invalidate();
    const trip = pick('trip');
    const available = trip && trip.canSale !== 'N' && trip.canBuyNow !== 'N' ? Object.entries(seats).flatMap(([id, label]) => {
      const count = String(trip[`${id}Num`] ?? '').trim();
      const price = trip[`${id}Price`];
      return (count === '有' || Number(count) > 0) ? [{ code: id.toUpperCase(), label, count, price }] : [];
    }) : [];
    fill('seat', available, item => `${item.label} · 余票 ${item.count}${item.price == null ? '' : ` · ¥${item.price}`}`);
  });
  for (const id of ['seat', 'passengers', 'contact', 'phone', 'apply']) el(id).addEventListener('input', invalidate);
  document.querySelector('[data-view="train"]').addEventListener('click', syncContext);
  el('date').value = dateOffset(0);
})();
