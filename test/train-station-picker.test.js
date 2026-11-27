const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeGroups, createStationSearch } = require('../renderer/train-station-picker');

const station = (stationCode, stationName = '北京') => ({ stationCode, stationName });
const response = (...stations) => ({ groups: [{ initial: 'B', stations }] });

test('normalizes grouped results and deduplicates by code, not name', () => {
  assert.deepEqual(normalizeGroups({ groups: [
    { initial: 'B', stations: [station('BJP'), station('BJP'), station('BXP'), null, station('')] },
    { stations: [station('SHH', '上海')] }, { stations: [] },
  ] }), [{ initial: 'B', stations: [station('BJP'), station('BXP')] }, { initial: '#', stations: [station('SHH', '上海')] }]);
  assert.deepEqual(normalizeGroups(null), []);
});

test('preserves the city metadata required by pricing', () => {
  const item = { ...station('BJP'), cityCode: '010', cityName: '北京' };
  assert.deepEqual(normalizeGroups(response(item))[0].stations[0], item);
});

function setup() {
  let context = 'uat';
  const pending = [], states = [];
  const search = createStationSearch({
    context: () => context,
    publish: state => states.push(state),
    request: keyword => new Promise((resolve, reject) => pending.push({ keyword, resolve, reject })),
  });
  return { pending, states, search, changeContext: () => { context = 'prod'; } };
}

test('late success cannot replace newer results', async () => {
  const { search, pending, states } = setup();
  const old = search.run(' 北 '), current = search.run('北京');
  assert.equal(pending[0].keyword, '北');
  pending[1].resolve(response(station('BJP')));
  await current;
  pending[0].resolve(response(station('BXP')));
  await old;
  assert.equal(states.at(-1).groups[0].stations[0].stationCode, 'BJP');
});

test('context changes and cancellation discard late errors and results', async () => {
  const { search, pending, states, changeContext } = setup();
  const old = search.run('北');
  changeContext();
  pending[0].reject(new Error('old error'));
  await old;
  const current = search.run('');
  search.cancel();
  pending[1].resolve(response(station('BJP')));
  await current;
  assert.deepEqual(states.map(state => state.status), ['loading', 'loading']);
});
