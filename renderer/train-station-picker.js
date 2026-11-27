(function () {
  'use strict';

  const array = value => Array.isArray(value) ? value : [];
  const text = value => typeof value === 'string' ? value.trim() : '';

  function normalizeGroups(data) {
    const seen = new Set();
    return array(data?.groups).flatMap(group => {
      const stations = array(group?.stations).flatMap(item => {
        const stationCode = text(item?.stationCode), stationName = text(item?.stationName);
        if (!stationCode || !stationName || seen.has(stationCode)) return [];
        seen.add(stationCode);
        return [{ ...item, stationCode, stationName }];
      });
      return stations.length ? [{ initial: text(group?.initial) || '#', stations }] : [];
    });
  }

  function createStationSearch({ context, publish, request }) {
    let revision = 0;
    return {
      cancel() { revision++; },
      async run(input) {
        const id = ++revision;
        const ctx = context();
        const keyword = input.trim();
        const current = () => id === revision && ctx === context();
        publish({ status: 'loading', keyword });
        let groups;
        try {
          groups = normalizeGroups(await request(keyword));
        } catch (error) {
          if (current()) publish({ status: 'error', keyword, error });
          return;
        }
        if (current()) publish({ status: 'results', keyword, groups });
      },
    };
  }

  function mount({ input, list, status, context, request, onChange }) {
    let timer, selected, active = -1, rows = [], composing = false;
    const search = createStationSearch({ context, request, publish(state) {
      clear();
      if (state.status === 'loading') return;
      if (state.status === 'error') {
        status.textContent = `${state.error.message}；按方向键重试`;
        return;
      }
      for (const group of state.groups) {
        const container = document.createElement('div');
        container.setAttribute('role', state.keyword ? 'presentation' : 'group');
        if (!state.keyword) {
          container.setAttribute('aria-label', group.initial);
          const heading = document.createElement('div');
          heading.className = 'station-group-title';
          heading.textContent = group.initial;
          heading.setAttribute('aria-hidden', 'true');
          container.append(heading);
        }
        for (const station of group.stations) {
          const option = document.createElement('div');
          option.id = `${input.id}-option-${rows.length}`;
          option.setAttribute('role', 'option');
          option.setAttribute('aria-selected', 'false');
          option.textContent = `${station.stationName}（${station.stationCode}）`;
          option.addEventListener('mousedown', event => event.preventDefault());
          option.addEventListener('click', () => choose(station));
          rows.push({ option, station });
          container.append(option);
        }
        list.append(container);
      }
      status.textContent = rows.length ? `找到 ${rows.length} 个车站` : '没有匹配车站';
    } });
    function clear() {
      active = -1;
      rows = [];
      list.replaceChildren();
      input.removeAttribute('aria-activedescendant');
    }
    function close() {
      clearTimeout(timer);
      search.cancel();
      clear();
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      status.textContent = '';
    }
    function choose(station) {
      selected = station;
      input.value = station.stationName;
      close();
      onChange();
    }
    function schedule(delay) {
      close();
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      status.textContent = '正在加载车站…';
      const ctx = context();
      timer = setTimeout(() => {
        if (ctx !== context() || input.disabled) return close();
        void search.run(input.value);
      }, delay);
    }
    function edited() {
      if (selected) { selected = undefined; onChange(); }
      if (!composing) schedule(250);
    }
    input.addEventListener('focus', () => { if (!selected) schedule(0); });
    input.addEventListener('blur', close);
    input.addEventListener('compositionstart', () => { composing = true; close(); });
    input.addEventListener('compositionend', () => { composing = false; edited(); });
    input.addEventListener('input', edited);
    input.addEventListener('keydown', event => {
      if (composing || event.isComposing) return;
      if (event.key === 'Escape' && !list.hidden) { event.preventDefault(); close(); }
      if (event.key === 'Enter' && active >= 0) { event.preventDefault(); choose(rows[active].station); }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      if (!rows.length) { if (status.textContent !== '正在加载车站…') schedule(0); return; }
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      rows[active]?.option.setAttribute('aria-selected', 'false');
      active = active < 0 ? (direction === 1 ? 0 : rows.length - 1) : (active + direction + rows.length) % rows.length;
      const { option } = rows[active];
      option.setAttribute('aria-selected', 'true');
      input.setAttribute('aria-activedescendant', option.id);
      option.scrollIntoView({ block: 'nearest' });
    });
    return { get selected() { return selected; }, close, reset(station) { selected = station; input.value = station?.stationName || ''; close(); } };
  }

  const api = { normalizeGroups, createStationSearch, mount };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else window.TrainStationPicker = api;
})();
