const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBooking } = require('../renderer/train-booking');

const draft = {
  quote: { trainDate: '2027-01-01', fromStationName: '北京南', fromCityCode: 'BJP', fromCityName: '北京', toStationName: '上海虹桥', toCityCode: 'SHH', toCityName: '上海', trainNo: '240000G101', trainCode: 'G101', seatType: 'SECOND_CLASS', passengerCount: 1 },
  departTime: '08:00', accountId: 42, passengerIds: [17], contactName: '乘客', contactPhone: '13800000000',
};
const policyPath = '/v1/co/check/travel/policy/check';
const setup = (overrides = {}) => {
  const calls = [];
  const responses = {
    '/train/orders/price': { quoteToken: 'quote' },
    '/v1/co/check/travel/apply/exemption/check': { passed: true },
    [policyPath]: { passed: true, result: 'PASS' },
    '/train/orders': { orderNo: 'T1' },
    '/train/orders/T1': { fulfillmentStatus: 'OCCUPY_SUCCESS' },
    ...overrides,
  };
  const flow = createBooking({ key: () => 'key-1', request: async (service, path, options) => {
    calls.push({ service, path, ...options });
    const result = responses[path];
    return typeof result === 'function' ? result() : result;
  } });
  return { calls, flow };
};

test('quote and policy precede separate explicit reservation and status', async () => {
  const { flow, calls } = setup();
  assert.equal((await flow.prepare(draft)).kind, 'ready');
  assert.deepEqual(calls.map(({service,path}) => [service,path]), [
    ['java','/train/orders/price'], ['go','/v1/co/check/travel/apply/exemption/check'], ['go',policyPath],
  ]);
  assert.equal((await flow.submit()).orderNo, 'T1');
  assert.equal(calls[3].body.quoteToken, 'quote');
  assert.deepEqual(calls[3].body.passengerIds, [17]);
  assert.equal((await flow.status('T1')).fulfillmentStatus, 'OCCUPY_SUCCESS');
});

test('blocked policy cannot reserve', async () => {
  const { flow } = setup({ [policyPath]: { passed: true, result: 'OVERAGE_BLOCK' } });
  await assert.rejects(flow.prepare(draft), /差标/);
  await assert.rejects(flow.submit(), /校验/);
});

test('required application prevents reservation without applyNo', async () => {
  const { flow } = setup({ '/v1/co/check/travel/apply/exemption/check': { passed: false }, '/v1/co/check/travel/apply/check': { passed: true, required: true } });
  await assert.rejects(flow.prepare(draft), /申请单/);
  await assert.rejects(flow.submit(), /校验/);
});

test('retries preserve the reservation idempotency key', async () => {
  let retries = 0;
  const { flow, calls } = setup({ '/train/orders': () => { if (!retries++) throw Error('timeout'); return { orderNo: 'T1' }; } });
  await flow.prepare(draft);
  await assert.rejects(flow.submit(), /timeout/);
  await flow.submit();
  assert.deepEqual(calls.filter(c => c.path === '/train/orders').map(c => c.body.idempotentKey), ['key-1','key-1']);
});

test('context invalidation discards a delayed quote', async () => {
  let resolve;
  const { flow, calls } = setup({ '/train/orders/price': () => new Promise(r => { resolve = r; }) });
  const pending = flow.prepare(draft);
  flow.reset();
  resolve({ quoteToken: 'stale' });
  await assert.rejects(pending, /上下文/);
  assert.equal(calls.length, 1);
});
