// Runs inside Electron's smoke renderer via executeJavaScript.
(async () => {
  const { TMC } = window;
  const original = { api: TMC.api, token: TMC.session.token, confirm: window.confirm };
  const calls = [];
  const routes = {
    '/train/station/search': ({ stationName }) => ({ groups: [{ stations: [{ stationName, stationCode: stationName === '北京南' ? 'VNP' : 'AOH', cityCode: stationName === '北京南' ? 'BJS' : 'SHA', cityName: stationName }] }] }),
    '/train/search': () => [{ trainNo: '240000G101', trainCode: 'G101', startTime: '08:00', edzNum: '4', edzPrice: 500 }],
    '/train/info': () => [],
    '/passenger/list': () => ({ list: [{ source: 'ORG', id: 17, name: '测试', mobile: '13800000000' }] }),
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
    document.querySelector('[data-view="train"]').click();
    set('from-key', '北京南'); set('to-key', '上海虹桥');
    await click('find-from'); await click('find-to'); await click('search');
    set('trip', '0', 'change'); set('seat', '0'); await click('info');
    await click('load'); set('contact', '测试'); await click('prepare');
    assert(!el('submit').disabled, 'Expected reservation enabled after precheck');
    window.confirm = () => false; await click('submit');
    assert(!calls.some(call => call.path === '/train/orders'), 'Cancellation must not reserve');
    window.confirm = () => true; await click('submit');
    assert(el('order-no').value === 'MOCK-TRAIN-1', 'Reservation should populate order number');
    await click('status');
    assert(el('output').textContent.includes('OCCUPY_SUCCESS'), 'Missing order status');
    assert(calls.every(call => call.service === (call.path.startsWith('/v1/') ? 'go' : 'java')), 'Incorrect API service');
    const price = calls.find(call => call.path === '/train/orders/price').options.body;
    const order = calls.find(call => call.path === '/train/orders').options.body;
    assert(price.fromStationCode === 'VNP' && price.seatType === 'EDZ' && order.quoteToken === 'mock-quote' && order.accountId === 42 && order.passengerIds[0] === 17 && order.idempotentKey, 'Incorrect quote/reservation request');
  } finally {
    TMC.api = original.api; TMC.session.token = original.token; window.confirm = original.confirm;
    document.querySelector('[data-view="train"]').click();
  }
})();
