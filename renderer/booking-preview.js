/* 右栏业务详情独立于接口检查器，不随网络请求切换。 */
(function () {
  'use strict';
  const { $, esc, money } = window.TMC;
  const panels = {};
  let view = 'flight';
  let raw = false;
  const businessView = () => view === 'flight' || view === 'hotel';
  function paint() {
    const showRaw = raw || !businessView();
    $('side-switch').hidden = !businessView();
    $('raw-inspector').hidden = !showRaw;
    $('booking-preview').hidden = showRaw;
    for (const [id, active] of [['side-detail', !showRaw], ['side-raw', showRaw]]) {
      $(id).classList.toggle('active', active);
      $(id).setAttribute('aria-pressed', String(active));
    }
    $('booking-preview').innerHTML = panels[view] || `<div class="preview-empty"><h3>${view === 'hotel' ? '酒店详情' : '航班详情'}</h3><p>从左侧选择${view === 'hotel' ? '酒店或房型报价' : '航班或报价'}，这里会显示对应详情。</p></div>`;
    $('booking-preview').scrollTop = 0;
  }
  function put(key, html, keepTab = false) {
    panels[key] = html;
    if (view === key) { if (!keepTab) raw = false; paint(); }
  }
  const field = (label, value) => `<div><dt>${esc(label)}</dt><dd>${esc(value ?? '未返回')}</dd></div>`;
  const fields = (...entries) => `<dl class="preview-grid">${entries.map(([k, v]) => field(k, v === '' ? null : v)).join('')}</dl>`;
  const card = (title, body) => `<section class="preview-card"><h4>${esc(title)}</h4>${body}</section>`;
  const heading = (kind, title) => `<header class="preview-title"><small>${esc(kind)}</small><h3>${esc(title)}</h3></header>`;
  const cents = (v) => v == null || v === '' ? null : money(v);
  const yuan = (v) => v == null || v === '' ? null : `¥${v}`;
  const station = (s = {}) => [s?.airportName || s?.cityName, s?.stationCode].filter(Boolean).join(' · ');
  const segments = (route) => (route?.trip?.segments || []).map((s, i) => card(`航段 ${i + 1} · ${s.lineNo || '航班号未返回'}`, fields(
    ['出发机场', station(s.depStation)], ['抵达机场', station(s.arrStation)],
    ['出发航站楼', s.depStation?.terminal], ['抵达航站楼', s.arrStation?.terminal],
    ['出发时间', s.depDate], ['抵达时间', s.arrDate], ['机型', s.equip?.craftCode],
  ))).join('');
  function flight(route, product, lookup, keepTab) {
    const title = (route?.trip?.segments || []).map((s) => s.lineNo).filter(Boolean).join(' / ') || '航班';
    if (!product) return put('flight', heading('航班信息', title) + (segments(route) || card('航段', '未返回航段信息')));
    const price = product.tripPrice?.price?.adultPrice || {};
    const bag = product.tripPrice?.baggage || {};
    const rule = product.refundChangeRule || {};
    const parsed = lookup?.data;
    const tiers = (items, fallback) => (Array.isArray(items) && items.length)
      ? items.map((r) => [r.ruleName, r.ruleDesc, r.amount, r.rate].filter((v) => v != null && v !== '').join(' · ')).filter(Boolean).join('\n') || fallback
      : fallback;
    const bags = Array.isArray(parsed?.baggageRules) ? parsed.baggageRules : [];
    const passenger = { ADULT: '成人', CHILD: '儿童', INFANT: '婴儿' };
    const baggage = bags.map((b) => [passenger[b.passengerType] || b.passengerType,
      b.weightKg == null ? null : `${b.weightKg} kg`, b.volumeLimit, b.rawText].filter(Boolean).join(' · ')).filter(Boolean).join('\n');
    const status = lookup?.loading ? '正在查询退改签规则及行李额…'
      : lookup?.error ? `规则查询失败：${lookup.error}（以下为报价自带信息，如有）` : '';
    put('flight', heading('机票报价', title) + card('报价明细', fields(
      ['产品类型', product.productType], ['舱等', product.cabinInfo?.cabinClassCode],
      ['成人总价', yuan(price.totalPrice)], ['票面价', yuan(price.price)],
      ['机建费', yuan(price.air)], ['燃油费', yuan(price.oil)],
    )) + (status ? `<p class="muted-text" role="status">${esc(status)}</p>` : '')
      + card('行李额', baggage || parsed?.rawBaggageInfo
        ? fields(['行李规则', baggage || parsed.rawBaggageInfo])
        : fields(['允许件数', bag.allowedPieces], ['允许重量', bag.allowedWeight == null ? null : `${bag.allowedWeight} kg${bag.weightType === 1 ? '（总重）' : bag.weightType === 0 ? '（单件）' : ''}`]))
      + card('退改签规则', fields(['退票', tiers(parsed?.refundRules, rule.refundText)], ['改签', tiers(parsed?.changeRules, rule.changeText)],
        ['签转', rule.endorsementText], ['规则说明', rule.txt || rule.remark])) + segments(route), keepTab);
  }
  function hotel(item, detail, room, product) {
    const info = { ...item, ...detail };
    const name = info.hotelName || info.name || '酒店';
    const basic = card('酒店概况', fields(['地址', info.address || info.hotelAddress], ['城市', info.cityName],
      ['品牌', info.brand], ['星级', info.starName || info.star || info.starLevel], ['酒店编号', info.hotelId || info.id],
      ['参考起价', cents(info.price)], ['酒店介绍', info.description || info.introduction || info.hotelDesc]));
    if (!product) return put('hotel', heading('酒店基础详情', name) + basic);
    const nights = (product.nightlyPrices || []).map((n) => [n.saleDate || n.stayDate || '房晚', cents(n.price)]);
    put('hotel', heading('酒店报价', product.ratePlanName || room?.roomName || name) + card('房型与价格', fields(
      ['酒店', name], ['房型', room?.roomName], ['床型', room?.bedDescription], ['房间面积', room?.roomArea],
      ['窗型', room?.windowType], ['报价类型', product.hotelProductType], ['参考价', cents(product.price)], ['房费合计', cents(product.totalRoomPrice)],
    )) + card('早餐与取消规则', fields(['早餐', product.breakfastTypeDesc || product.breakfast || product.breakfastType],
      ['取消政策', product.cancelPolicy], ['最晚免费取消', product.latestFreeCancelTime],
    )) + (nights.length ? card('逐晚价格', fields(...nights)) : '') + basic);
  }
  $('side-detail').addEventListener('click', () => { raw = false; paint(); });
  $('side-raw').addEventListener('click', () => { raw = true; paint(); });
  window.BookingPreview = { flight, hotel, clear: (key) => put(key, ''), view: (key) => { view = key; raw = false; paint(); }, showRaw: () => { raw = true; paint(); } };
  paint();
})();
