// Runs inside Electron's smoke renderer via executeJavaScript.
(async () => {
  const { TMC } = window;
  const original = { api: TMC.api, token: TMC.session.token, confirm: window.confirm };
  const savedTrainForm = localStorage.getItem('tmc.train.search.v1');
  const calls = [];
  const routes = {
    '/train/station/search': ({ stationName }) => ({ groups: [{ stations: [{ stationName, stationCode: stationName === '北京南' ? 'VNP' : 'AOH', cityCode: stationName === '北京南' ? 'BJS' : 'SHA', cityName: stationName }] }] }),
    '/train/search': () => [{ trainNo: '240000G101', trainCode: 'G101', startTime: '08:00', edzNum: '4', edzPrice: 500 }],
    '/train/info': () => [],
    '/passenger/list': () => ({ list: [{ source: 'ORG', id: 17, name: '测试', mobile: '13800000000' }, { source: 'ORG', id: 18, name: '同事' }] }),
    '/train/accounts/12306': () => ({ accountId: 42, riskStatus: 'NORMAL' }),
    '/train/orders/price': () => ({ quoteToken: 'mock-quote' }),
    '/v1/co/check/travel/apply/exemption/check': () => ({ passed: true }),
    '/v1/co/check/travel/policy/check': () => ({ passed: true, result: 'PASS' }),
    '/train/orders': () => ({ orderNo: 'MOCK-TRAIN-1' }),
    '/train/orders/MOCK-TRAIN-1': () => ({ fulfillmentStatus: 'OCCUPY_SUCCESS' }),
  };
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const el = id => document.getElementById(`tr-${id}`);
  const set = (id, value, event = 'input') => { el(id).value = value; el(id).dispatchEvent(new Event(event, { bubbles: true })); };
  const click = async id => {
    el(id).click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert(!el('output').querySelector('.out-error'), `${id}: ${el('output').textContent}`);
  };
  try {
    TMC.session.token = 'offline-smoke-token';
    TMC.api = async (service, path, options) => {
      calls.push({ service, path, options });
      assert(Object.hasOwn(routes, path), `Unexpected API ${path}`);
      return { status: 200, json: { success: true, code: 0, data: routes[path](options.body) } };
    };
    localStorage.setItem('tmc.train.search.v1', JSON.stringify({
      from: { stationName: '北京南', stationCode: 'VNP', cityCode: 'BJS' },
      to: { stationName: '上海虹桥', stationCode: 'AOH', cityCode: 'SHA' }, date: '2026-12-05',
    }));
    document.querySelector('[data-view="train"]').click();
    assert(el('from').value === '北京南' && el('to').value === '上海虹桥' && el('date').value === '2026-12-05', 'Saved train form should restore stations and date');
    await click('search');
    assert(calls.at(-1).options.body.fromStation === 'VNP' && calls.at(-1).options.body.toStation === 'AOH', 'Restored stations must be usable without reselection');
    for (const [id, name] of [['from', '北京南'], ['to', '上海虹桥']]) {
      el(id).focus();
      set(id, name);
      const deadline = Date.now() + 2000;
      while (!el(`${id}-options`).querySelector('[role=option]') && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert(el(`${id}-options`).textContent.includes(name), `Missing ${name} station option`);
      for (const key of ['ArrowDown', 'Enter']) el(id).dispatchEvent(new KeyboardEvent('keydown', { key }));
      assert(el(id).getAttribute('aria-expanded') === 'false', 'Selection should close the list');
    }
    await click('search');
    const query = calls.find(call => call.path === '/train/search').options.body;
    assert(query.fromStation === 'VNP' && query.toStation === 'AOH', 'Search must send selected station codes');
    const cards = el('trains').querySelectorAll('.train-card');
    assert(cards.length === 1, 'Search should render a visible train card');
    assert(el('trains').textContent.includes('G101'), 'Train card should show the train code');
    el('trains').querySelector('[data-seat-code="EDZ"]').click();
    assert(el('trip').value === '0' && el('seat').value === '0', 'Seat chip should select the train and seat');
    assert(!el('book').disabled, 'Seat chip should enable the booking jump');
    assert(el('selection').textContent.includes('G101') && el('selection').textContent.includes('二等座'), 'Selection summary should name the chosen train and seat');
    el('book').click();
    assert(document.getElementById('tr-step-2').classList.contains('is-target'), 'Booking jump should highlight the passenger and pricing step');
    set('trip', '0', 'change'); set('seat', '0'); await click('info');
    await click('load');
    const passenger = el('passengers').querySelector('button.pax-item');
    assert(passenger?.textContent.includes('测试'), 'Expected a visible enterprise passenger card');
    assert(!passenger.textContent.includes('13800000000'), 'Passenger card must mask the phone number');
    passenger.click();
    assert(passenger.getAttribute('aria-pressed') === 'true', 'Clicking the passenger should select it');
    passenger.click();
    assert(passenger.getAttribute('aria-pressed') === 'false', 'Clicking the selected passenger should deselect it');
    passenger.click();
    assert(passenger.getAttribute('aria-pressed') === 'true', 'Clicking again should select the passenger');
    el('passengers').querySelectorAll('.pax-item')[1].click();
    assert(el('pax-hint').textContent.includes('已选 2 人'), 'Both passengers should remain selected');
    set('contact', '测试'); await click('prepare');
    assert(!el('submit').disabled, 'Expected reservation enabled after precheck');
    window.confirm = () => false; await click('submit');
    assert(!calls.some(call => call.path === '/train/orders'), 'Cancellation must not reserve');
    window.confirm = () => true; await click('submit');
    assert(el('order-no').value === 'MOCK-TRAIN-1', 'Reservation should populate order number');
    await click('status');
    assert(el('output').textContent.includes('OCCUPY_SUCCESS'), 'Missing order status');
    set('date', '2026-12-06', 'change');
    const saved = JSON.parse(localStorage.getItem('tmc.train.search.v1'));
    assert(saved.date === '2026-12-06' && saved.from.cityCode === 'BJS' && saved.to.stationCode === 'AOH', 'Editing the date must persist it with both selected station records');
    set('from', '北京');
    assert(!JSON.parse(localStorage.getItem('tmc.train.search.v1')).from, 'Editing a station must remove its stale code from storage');
    assert(!el('trip').value && !el('seat').value && el('submit').disabled && el('book').disabled && el('to').value === '上海虹桥', 'Editing one station must invalidate the trip without clearing the other station');
    assert(calls.every(call => call.service === (call.path.startsWith('/v1/') ? 'go' : 'java')), 'Incorrect API service');
    const price = calls.find(call => call.path === '/train/orders/price').options.body;
    const order = calls.find(call => call.path === '/train/orders').options.body;
    assert(price.fromStationCode === 'VNP' && price.seatType === 'EDZ' && order.quoteToken === 'mock-quote' && order.accountId === 42 && order.passengerIds.join(',') === '17,18' && order.idempotentKey, 'Incorrect quote/reservation request');
  } finally {
    if (savedTrainForm === null) localStorage.removeItem('tmc.train.search.v1');
    else localStorage.setItem('tmc.train.search.v1', savedTrainForm);
    TMC.api = original.api; TMC.session.token = original.token; window.confirm = original.confirm;
    document.querySelector('[data-view="train"]').click();
  }
})();
