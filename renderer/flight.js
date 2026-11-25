/* 机票：搜索 → 选航班号 → 拉全部报价 → 选报价 → 详情 → 验价 → 创单 → 支付。 */
(function () {
  'use strict';

  const { $, esc, money, uid, api, toast, jsonBox, showError, okResponse, settings } = window.TMC;

  const state = {
    routes: [],
    guid: '',
    detailKey: '',
    selectedRoute: null,
    selectedProduct: null,
    productRoute: null,
    detail: null,
    quote: null,
    orderNo: '',
    passengers: [],
    passenger: null,
  };

  const boxes = {};

  const SEARCH_FORM_KEY = 'tmc.flight.search.v1';
  const SEARCH_FORM_FIELDS = [
    'f-purpose', 'f-travelType', 'f-depCode', 'f-depType', 'f-arrCode', 'f-arrType',
    'f-depDate', 'f-returnDate', 'f-adult', 'f-child', 'f-infant',
  ];

  function readSavedSearchForm() {
    try {
      const raw = localStorage.getItem(SEARCH_FORM_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function saveSearchForm() {
    const snapshot = {};
    SEARCH_FORM_FIELDS.forEach((id) => { snapshot[id] = $(id).value; });
    try {
      localStorage.setItem(SEARCH_FORM_KEY, JSON.stringify(snapshot));
    } catch { /* 存储不可用时忽略 */ }
  }

  function restoreSearchForm() {
    const saved = readSavedSearchForm();
    if (saved && typeof saved === 'object') {
      SEARCH_FORM_FIELDS.forEach((id) => {
        if (saved[id] !== undefined && saved[id] !== null) $(id).value = saved[id];
      });
      return true;
    }
    return false;
  }

  const firstSegment = (route) => (route && route.trip && route.trip.segments && route.trip.segments[0]) || null;
  const lastSegment = (route) => {
    const segments = (route && route.trip && route.trip.segments) || [];
    return segments[segments.length - 1] || null;
  };

  const stationText = (station) => {
    if (!station) return '';
    return station.cityName || station.stationName || station.stationCode || '';
  };

  const productList = (route) => {
    if (!route) return [];
    const direct = route.productInfos;
    if (Array.isArray(direct)) return direct;
    if (direct && typeof direct === 'object') return [direct];
    return (route.productGroups || []).flatMap((group) => group.products || []);
  };

  const productPriceNumber = (product) => {
    const adult = product && product.tripPrice && product.tripPrice.price && product.tripPrice.price.adultPrice;
    if (!adult) return null;
    const value = adult.totalPrice !== undefined && adult.totalPrice !== null && adult.totalPrice !== ''
      ? adult.totalPrice
      : adult.price;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };

  const productPrice = (product) => {
    const n = productPriceNumber(product);
    return n === null ? '-' : `¥${n.toFixed(2)}`;
  };

  const lowestPrice = (products) => {
    const values = products.map(productPriceNumber).filter((n) => n !== null);
    return values.length ? `¥${Math.min(...values).toFixed(2)} 起` : '';
  };

  const normalizeDateTime = (value) => {
    if (!value) return '';
    const text = String(value).trim().replace(' ', 'T');
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) return String(value);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  };

  const fee = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(2) : '0.00';
  };

  const checkFlightResponse = (result) => {
    if (!okResponse(result)) {
      throw new Error(result.error || `HTTP ${result.status}`);
    }
    return window.TMC.unwrap(result);
  };

  const setStepEnabled = (index, enabled) => {
    const section = $(`f-step-${index}`);
    if (!section) return;
    section.classList.toggle('muted', !enabled);
  };

  const out = (target, result, title) => {
    if (!target) return;
    if (result && result.error) {
      showError(target, result.error);
      return;
    }
    const data = result && result.json !== undefined ? result.json : result && result.text;
    const head = title ? `<div class="out-title">${esc(title)}</div>` : '';
    target.innerHTML = `${head}<pre class="code">${esc(JSON.stringify(data, null, 2) || String(data || ''))}</pre>`;
  };

  /* ---------------- 请求体构造 ---------------- */

  const travelPurpose = () => $('f-purpose').value;

  function buildSearchBody() {
    const body = {
      travelPurpose: travelPurpose(),
      travelType: $('f-travelType').value,
      depCode: $('f-depCode').value.trim().toUpperCase(),
      depCodeType: $('f-depType').value,
      arrCode: $('f-arrCode').value.trim().toUpperCase(),
      arrCodeType: $('f-arrType').value,
      depDate: $('f-depDate').value,
      adultNum: Number($('f-adult').value || 1),
      childNum: Number($('f-child').value || 0),
      infantNum: Number($('f-infant').value || 0),
    };
    if ($('f-travelType').value !== 'OW' && $('f-returnDate').value) {
      body.returnDate = $('f-returnDate').value;
    }
    return body;
  }

  function tenantValue() {
    const raw = String(settings.tenantCode || '').trim();
    if (!raw) return undefined;
    return /^\d+$/.test(raw) ? Number(raw) : raw;
  }

  function currentPassenger() {
    const p = state.passenger;
    if (p) {
      const cardNo = String(p.cardNo || p.cardNoMask || '').replace(/\s+/g, '');
      const phone = String(p.mobile || p.mobileMask || '').replace(/\s+/g, '');
      return {
        name: String(p.name || '').trim(),
        passengerType: 'ADT',
        cardType: String(p.cardType || 'ID').trim(),
        cardNo,
        phone,
      };
    }
    return {
      name: $('f-p-name').value.trim(),
      passengerType: 'ADT',
      cardType: $('f-p-cardType').value || 'NI',
      cardNo: $('f-p-cardNo').value.trim(),
      phone: $('f-p-phone').value.trim(),
    };
  }

  function buildPriceBody() {
    if (!state.detail) throw new Error('请先查询航班详情');
    const route = state.detail.route || {};
    const products = productList(route);
    const product = products.find((item) => item.detailKey === state.detailKey)
      || products[0]
      || state.selectedProduct;
    if (!product) throw new Error('详情里没有 productInfos，无法验价');

    const passenger = currentPassenger();
    if (!passenger.name || !passenger.cardNo || !passenger.phone) {
      throw new Error('请拉取常旅客或填写乘机人姓名、证件号、手机号');
    }

    const adultPrice = (product.tripPrice && product.tripPrice.price && product.tripPrice.price.adultPrice) || {};
    const trip = (state.selectedRoute && state.selectedRoute.trip) || route.trip || {};
    const segments = trip.segments || [];
    const segmentList = segments.map((segment, index) => {
      const segmentNo = segment.sequence !== undefined ? segment.sequence : index + 1;
      const cabins = (product.cabinInfo && product.cabinInfo.cabins) || [];
      const cabin = cabins.find((item) => item.segmentSequence === segmentNo) || cabins[index] || {};
      return {
        segmentNo,
        flightNo: segment.lineNo || '',
        cabinCode: cabin.cabinCode || '',
        cabinClassCode: (product.cabinInfo && product.cabinInfo.cabinClassCode) || '',
        departureAirportCode: (segment.depStation && segment.depStation.stationCode) || '',
        arrivalAirportCode: (segment.arrStation && segment.arrStation.stationCode) || '',
        takeoffTime: normalizeDateTime(segment.depDate),
        arrivalTime: normalizeDateTime(segment.arrDate),
        departureTerminal: (segment.depStation && segment.depStation.terminal) || '',
        arrivalTerminal: (segment.arrStation && segment.arrStation.terminal) || '',
        sessionId: product.sessionId || '',
        salePrice: String(adultPrice.price !== undefined ? adultPrice.price : (adultPrice.totalPrice || '')),
        airportFee: fee(adultPrice.air),
        fuelTax: fee(adultPrice.oil),
        aircraftModel: (segment.equip && segment.equip.craftCode) || '',
      };
    });

    const body = {
      guid: state.guid,
      detailKey: state.detailKey,
      travelPurpose: travelPurpose(),
      supplierKey: 'FENGYI_GUONEI',
      payerType: 'COMPANY',
      segmentList,
      passengerList: [passenger],
    };
    const tenant = tenantValue();
    if (tenant !== undefined) {
      body.companyId = tenant;
      body.partnerCode = tenant;
    }
    return body;
  }

  function buildCreateBody() {
    const passenger = currentPassenger();
    const contactName = $('f-contact-name').value.trim() || passenger.name;
    const contactPhone = $('f-contact-phone').value.trim() || passenger.phone;
    const body = {
      quoteToken: (state.quote && state.quote.quoteToken) || '',
      idempotentKey: uid(),
      travelPurpose: travelPurpose(),
      companyId: tenantValue(),
      partnerCode: tenantValue(),
      employeeName: $('f-employeeName').value.trim() || passenger.name,
      voyageType: 'ONE_WAY',
      contactName,
      contactPhone,
    };
    const applyNo = $('f-applyNo').value.trim();
    if (applyNo) body.applyNo = applyNo;
    const overage = $('f-overageReason').value.trim();
    if (overage) body.overageReason = overage;
    Object.keys(body).forEach((key) => { if (body[key] === undefined) delete body[key]; });
    if (!body.quoteToken) throw new Error('缺少 quoteToken，请先验价');
    return body;
  }

  /* ---------------- 渲染 ---------------- */

  function renderRoutes(routes) {
    const container = $('f-routes');
    if (!Array.isArray(routes) || routes.length === 0) {
      container.innerHTML = '<div class="empty">没有查询到航班</div>';
      return;
    }
    container.innerHTML = routes.map((route, routeIndex) => {
      const segments = (route.trip && route.trip.segments) || [];
      const first = firstSegment(route) || {};
      const last = lastSegment(route) || {};
      const products = productList(route);
      const routeText = segments
        .map((segment) => `${segment.lineNo || ''} ${stationText(segment.depStation)}→${stationText(segment.arrStation)}`)
        .join(' / ');
      return `
        <article class="card">
          <div class="card-head">
            <div>
              <strong>${esc(first.lineNo || '航班')}</strong>
              <span class="muted-text">${esc(stationText(first.depStation))} → ${esc(stationText(last.arrStation))}</span>
            </div>
            <div class="muted-text">${esc(first.depDate || '')}</div>
            <div class="muted-text">guid: <code>${esc(route.trip && route.trip.guid ? route.trip.guid : '-')}</code></div>
          </div>
          <div class="muted-text">${esc(routeText)}</div>
          <div class="actions">
            <button class="primary small" data-route-pick="${routeIndex}">选择此航班</button>
            <span class="muted-text">${products.length ? `搜索已带 ${lowestPrice(products)}，选择后重新拉全部报价` : '选择后自动调用 searchProduct 拉取全部报价'}</span>
          </div>
        </article>`;
    }).join('');

    container.querySelectorAll('[data-route-pick]').forEach((button) => {
      button.addEventListener('click', () => {
        pickRoute(state.routes[Number(button.dataset.routePick)]);
      });
    });
  }

  function renderProducts(products, route) {
    const container = $('f-products');
    if (!products || products.length === 0) {
      container.innerHTML = '<div class="empty">该航班没有可用报价</div>';
      return;
    }
    const flightNo = (firstSegment(route) || {}).lineNo || '';
    container.innerHTML = `
      <div class="card">
        <div class="card-head">
          <strong>${esc(flightNo || '航班')} 的全部报价</strong>
          <span class="muted-text">${products.length} 个报价</span>
        </div>
        <table class="mini-table">
          <thead><tr><th>舱等</th><th>产品类型</th><th>价格</th><th>detailKey</th><th></th></tr></thead>
          <tbody>
            ${products.map((product, index) => `
              <tr>
                <td>${esc((product.cabinInfo && product.cabinInfo.cabinClassCode) || '-')}</td>
                <td>${esc(product.productType || '-')}</td>
                <td class="price">${esc(productPrice(product))}</td>
                <td><code>${esc(product.detailKey || '-')}</code></td>
                <td><button class="ghost small" data-quote-pick="${index}">选择此报价</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    container.querySelectorAll('[data-quote-pick]').forEach((button) => {
      button.addEventListener('click', () => {
        selectQuote(products[Number(button.dataset.quotePick)], route);
      });
    });
  }

  async function pickRoute(route) {
    const guid = (route && route.trip && route.trip.guid) || '';
    if (!guid) {
      toast('该航班没有 guid，无法拉取报价', 'error');
      return;
    }
    state.selectedRoute = route;
    state.guid = guid;
    state.selectedProduct = null;
    state.detailKey = '';
    state.productRoute = null;
    state.detail = null;
    state.quote = null;
    boxes.detail.set({ detailKey: '', guid });
    $('f-selected-hint').textContent = `已选航班 ${(firstSegment(route) || {}).lineNo || guid}，正在拉取全部报价…`;
    $('f-products').innerHTML = '';
    $('f-detail-info').innerHTML = '';
    $('f-quote').innerHTML = '';
    $('btn-f-products').disabled = false;
    $('btn-f-detail').disabled = true;
    $('btn-f-price').disabled = true;
    $('btn-f-create').disabled = true;
    setStepEnabled(2, true);
    $('f-step-2').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    await doProducts();
  }

  async function selectQuote(product, route) {
    if (!product) return;
    state.selectedProduct = product;
    state.productRoute = route || state.productRoute;
    state.detailKey = product.detailKey || '';
    state.detail = null;
    state.quote = null;
    boxes.detail.set({ detailKey: state.detailKey, guid: state.guid, travelPurpose: travelPurpose() });
    $('f-selected-hint').textContent = `已选报价 ${state.detailKey}，正在查询详情…`;
    $('btn-f-detail').disabled = !(state.detailKey && state.guid);
    $('f-detail-info').innerHTML = '';
    $('f-quote').innerHTML = '';
    await doDetail();
  }

  function renderDetail(route) {
    const trip = route.trip || {};
    const products = productList(route);
    const product = products.find((item) => item.detailKey === state.detailKey) || products[0] || state.selectedProduct;
    const segments = trip.segments || [];
    $('f-detail-info').innerHTML = `
      <div class="card">
        <div class="card-head">
          <strong>${esc(product && product.detailKey ? product.detailKey : '详情')}</strong>
          <span class="muted-text">${segments.map((segment) => `${segment.lineNo || ''} ${segment.depStation ? segment.depStation.stationCode : ''}-${segment.arrStation ? segment.arrStation.stationCode : ''}`).join(' / ')}</span>
        </div>
        <div class="muted-text">价格 ${esc(productPrice(product))} · 舱等 ${esc((product && product.cabinInfo && product.cabinInfo.cabinClassCode) || '-')}</div>
      </div>`;
  }

  function renderPassengers() {
    const container = $('f-passengers');
    if (!container) return;
    if (!state.passengers.length) {
      container.innerHTML = '';
      return;
    }
    container.innerHTML = state.passengers.map((passenger, index) => {
      const active = state.passenger && (state.passenger.id === passenger.id || state.passenger.passengerNo === passenger.passengerNo);
      const cert = [passenger.cardTypeDesc || passenger.cardType, passenger.cardNoMask || passenger.cardNo].filter(Boolean).join(' ');
      const phone = passenger.mobileMask || passenger.mobile || '';
      return `
        <button type="button" class="pax-item${active ? ' active' : ''}" data-pax="${index}">
          <b>${esc(passenger.name || '-')}</b>
          <span class="muted-text">${esc(cert)}</span>
          <span class="muted-text">${esc(phone)}</span>
        </button>`;
    }).join('');
    container.querySelectorAll('[data-pax]').forEach((button) => {
      button.addEventListener('click', () => {
        selectPassenger(state.passengers[Number(button.dataset.pax)]);
      });
    });
  }

  function selectPassenger(passenger) {
    if (!passenger) return;
    state.passenger = passenger;
    $('f-p-name').value = passenger.name || '';
    $('f-p-cardType').value = normalizeCardType(passenger.cardType);
    $('f-p-cardNo').value = String(passenger.cardNo || passenger.cardNoMask || '').replace(/\s+/g, '');
    $('f-p-phone').value = String(passenger.mobile || passenger.mobileMask || '').replace(/\s+/g, '');
    if (!$('f-contact-name').value.trim()) $('f-contact-name').value = passenger.name || '';
    if (!$('f-contact-phone').value.trim()) $('f-contact-phone').value = String(passenger.mobile || passenger.mobileMask || '');
    renderPassengers();
    if (state.detail) {
      try { boxes.price.set(buildPriceBody()); } catch { /* 等用户补齐信息 */ }
    }
    toast(`已选择乘机人 ${passenger.name || ''}`, 'ok');
  }

  function renderQuote(quote) {
    const price = quote.price || {};
    $('f-quote').innerHTML = `
      <div class="card">
        <div class="card-head"><strong>验价成功</strong><span class="badge ok">quoteToken 已获取</span></div>
        <div class="kv">
          <div><span>应付</span><b>${esc(money(price.payableAmount))}</b></div>
          <div><span>实收</span><b>${esc(money(price.actualAmount))}</b></div>
          <div><span>票面</span><b>${esc(money(price.baseAmount))}</b></div>
          <div><span>服务费</span><b>${esc(money(price.serviceFeeTotal))}</b></div>
        </div>
        ${quote.priceChanged ? '<div class="out-error">价格发生变化，请确认后再下单</div>' : ''}
        <div class="muted-text">quoteToken: <code>${esc(quote.quoteToken || '')}</code></div>
      </div>`;
  }

  /* ---------------- 事件 ---------------- */

  async function doSearch() {
    const button = $('btn-f-search');
    button.disabled = true;
    $('f-search-hint').textContent = '查询中…';
    try {
      const result = await api('java', '/flight/search', { body: boxes.search.get() });
      const json = checkFlightResponse(result);
      saveSearchForm();
      state.routes = json.routes || [];
      renderRoutes(state.routes);
      $('f-search-hint').textContent = `共 ${json.totalCountry !== undefined ? json.totalCountry : state.routes.length} 个航班 · ${json.traceId ? 'traceId ' + json.traceId : ''}`;
      toast(`查询到 ${state.routes.length} 个航班`, 'ok');
      setStepEnabled(2, state.routes.length > 0);
    } catch (error) {
      showError($('f-routes'), error);
      $('f-search-hint').textContent = '查询失败';
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function doProducts() {
    if (!state.guid) return;
    const body = {
      guid: state.guid,
      travelPurpose: travelPurpose(),
      adultNum: Number($('f-adult').value || 1),
      childNum: Number($('f-child').value || 0),
      infantNum: Number($('f-infant').value || 0),
    };
    try {
      const result = await api('java', '/flight/searchProduct', { body });
      const json = checkFlightResponse(result);
      const route = json.route || state.selectedRoute;
      const products = productList(route);
      state.productRoute = route;
      if (route && route.trip) {
        state.selectedRoute = state.selectedRoute && state.selectedRoute.trip && state.selectedRoute.trip.guid === route.trip.guid
          ? { ...state.selectedRoute, ...route }
          : { ...state.selectedRoute, ...route, trip: route.trip };
      }
      renderProducts(products, state.selectedRoute || route);
      $('f-selected-hint').textContent = `航班 ${(firstSegment(state.selectedRoute) || {}).lineNo || state.guid} 共 ${products.length} 个报价，选择报价后自动查详情`;
      toast(`拉到 ${products.length} 个报价`, 'ok');
      setStepEnabled(2, true);
    } catch (error) {
      showError($('f-products'), error);
      $('f-selected-hint').textContent = '拉取报价失败';
      toast(error.message, 'error');
    }
  }

  async function doDetail() {
    const button = $('btn-f-detail');
    button.disabled = true;
    $('f-selected-hint').textContent = '正在查询详情…';
    try {
      const result = await api('java', '/flight/searchDetail', { body: boxes.detail.get() });
      const json = checkFlightResponse(result);
      if (!json.route) throw new Error('详情里没有 route');
      state.detail = json;
      state.selectedRoute = json.route;
      renderDetail(json.route);
      try {
        boxes.price.set(buildPriceBody());
      } catch {
        /* 乘机人信息还没填完，验价时再统一校验 */
      }
      $('btn-f-price').disabled = false;
      setStepEnabled(3, true);
      $('f-step-3').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      if (!state.passengers.length) void doPassengers();
      $('f-selected-hint').textContent = `已获取报价详情 ${state.detailKey}`;
    } catch (error) {
      showError($('f-detail-info'), error);
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function doPassengers() {
    const button = $('btn-f-passengers');
    button.disabled = true;
    $('f-passenger-hint').textContent = '正在拉取常旅客…';
    try {
      const result = await api('java', '/passenger/list', {
        body: { source: 'ORG', pageNum: 1, pageSize: 50 },
      });
      const json = checkFlightResponse(result);
      const list = Array.isArray(json) ? json : (json.list || []);
      state.passengers = list;
      renderPassengers();
      $('f-passenger-hint').textContent = `共 ${list.length} 位常旅客，点选即可填入`;
      $('f-step-3').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      if (!list.length) {
        showError($('f-passengers'), new Error('没有查到常旅客，可手动填写乘机人'));
      }
    } catch (error) {
      showError($('f-passengers'), error);
      $('f-passenger-hint').textContent = '拉取失败';
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function doPrice() {
    const button = $('btn-f-price');
    button.disabled = true;
    try {
      const body = boxes.price.get();
      const result = await api('java', '/air/order/price', { body });
      const quote = checkFlightResponse(result);
      const quoteToken = quote.quoteToken && String(quote.quoteToken).trim();
      if (!quoteToken) throw new Error(quote.verifyMessage || '报价结果缺少 quoteToken');
      quote.quoteToken = quoteToken;
      state.quote = quote;
      renderQuote(quote);
      boxes.create.set(buildCreateBody());
      $('btn-f-create').disabled = false;
      setStepEnabled(4, true);
      $('f-quote').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      toast('验价成功，已获取 quoteToken', 'ok');
    } catch (error) {
      showError($('f-quote'), error);
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function doCreate() {
    const button = $('btn-f-create');
    button.disabled = true;
    try {
      const result = await api('java', '/air/order/create', { body: boxes.create.get() });
      const order = checkFlightResponse(result);
      if (!order.orderNo) throw new Error('下单响应没有 orderNo');
      state.orderNo = order.orderNo;
      $('f-orderNo').value = order.orderNo;
      out($('f-order'), result, `订单 ${order.orderNo}`);
      enablePay(true);
      setStepEnabled(5, true);
      $('f-step-5').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      toast(`下单成功：${order.orderNo}`, 'ok');
    } catch (error) {
      showError($('f-order'), error);
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  function enablePay(enabled) {
    ['btn-f-pay', 'btn-f-alipay', 'btn-f-order-detail', 'btn-f-cancel'].forEach((id) => { $(id).disabled = !enabled; });
  }

  async function doPay() {
    const orderNo = $('f-orderNo').value.trim();
    if (!orderNo) return toast('请填写订单号', 'error');
    const body = { orderNo, zfyz: '1', travelPurpose: travelPurpose() };
    const payMethod = $('f-payMethod').value.trim();
    if (payMethod) body.payMethod = payMethod;
    const result = await api('java', '/air/order/pay', { body });
    checkFlightResponse(result);
    out($('f-pay'), result, '支付结果');
  }

  async function doAlipay() {
    const orderNo = $('f-orderNo').value.trim();
    if (!orderNo) return toast('请填写订单号', 'error');
    const result = await api('java', `/air/order/${encodeURIComponent(orderNo)}/pay/alipay`, {
      body: { idempotentKey: uid(), travelPurpose: travelPurpose() },
    });
    checkFlightResponse(result);
    out($('f-pay'), result, '支付宝支付参数');
  }

  async function doOrderDetail() {
    const orderNo = $('f-orderNo').value.trim();
    if (!orderNo) return;
    const result = await api('java', `/air/order/${encodeURIComponent(orderNo)}`, { method: 'GET' });
    checkFlightResponse(result);
    out($('f-pay'), result, '订单详情');
  }

  async function doCancel() {
    const orderNo = $('f-orderNo').value.trim();
    if (!orderNo) return;
    if (!window.confirm(`确认取消订单 ${orderNo}？`)) return;
    const result = await api('java', '/air/order/cancel', {
      body: { orderNo, cancelReason: '调试工具取消', travelPurpose: travelPurpose() },
    });
    checkFlightResponse(result);
    out($('f-pay'), result, '取消结果');
  }

  function resetFlow() {
    state.routes = [];
    state.guid = '';
    state.detailKey = '';
    state.selectedRoute = null;
    state.selectedProduct = null;
    state.productRoute = null;
    state.detail = null;
    state.quote = null;
    state.orderNo = '';
    state.passengers = [];
    state.passenger = null;
    $('f-routes').innerHTML = '';
    $('f-products').innerHTML = '';
    $('f-detail-info').innerHTML = '';
    $('f-quote').innerHTML = '';
    $('f-order').innerHTML = '';
    $('f-pay').innerHTML = '';
    $('f-passengers').innerHTML = '';
    $('f-orderNo').value = '';
    $('f-selected-hint').textContent = '先在上一步选择航班号';
    $('f-passenger-hint').textContent = 'POST /passenger/list，点选后自动填入乘机人';
    setStepEnabled(2, false);
    $('btn-f-products').disabled = true;
    $('btn-f-detail').disabled = true;
    $('btn-f-price').disabled = true;
    $('btn-f-create').disabled = true;
    enablePay(false);
    [2, 3, 4, 5].forEach((index) => setStepEnabled(index, false));
    boxes.search.set(buildSearchBody());
    boxes.detail.set({ detailKey: '', guid: '' });
    boxes.price.set({});
    boxes.create.set({});
    toast('机票流程已重置', 'ok');
  }

  function updatePurposeHint() {
    $('f-purpose-hint').hidden = travelPurpose() !== 'PRIVATE';
  }

  function onPurposeChange() {
    updatePurposeHint();
    if (state.guid && state.detailKey) {
      boxes.detail.set({ guid: state.guid, detailKey: state.detailKey, travelPurpose: travelPurpose() });
    }
    state.quote = null;
    $('f-quote').innerHTML = '';
    $('btn-f-create').disabled = true;
    enablePay(false);
    try { boxes.price.set(buildPriceBody()); } catch { /* 乘机人未填完时忽略 */ }
    toast(`已切换为${travelPurpose() === 'PRIVATE' ? '因私' : '因公'}，请重新验价`, 'ok');
  }

  function initFlight() {
    const restored = restoreSearchForm();
    if (!$('f-depDate').value) $('f-depDate').value = window.TMC.dateOffset(7);
    if (!$('f-returnDate').value) $('f-returnDate').value = window.TMC.dateOffset(10);
    if (restored) $('f-search-hint').textContent = '已恢复上次查询条件';

    boxes.search = jsonBox($('f-json-search'), buildSearchBody());
    boxes.detail = jsonBox($('f-json-detail'), { detailKey: '', guid: '' });
    boxes.price = jsonBox($('f-json-price'), {});
    boxes.create = jsonBox($('f-json-create'), {});

    const syncSearch = () => {
      boxes.search.set(buildSearchBody());
      saveSearchForm();
    };
    SEARCH_FORM_FIELDS.forEach((id) => {
      $(id).addEventListener('input', syncSearch);
      $(id).addEventListener('change', syncSearch);
    });
    $('f-purpose').addEventListener('change', onPurposeChange);
    updatePurposeHint();

    ['f-p-name', 'f-p-cardType', 'f-p-cardNo', 'f-p-phone'].forEach((id) => {
      $(id).addEventListener('input', () => {
        state.passenger = null;
        renderPassengers();
        if (state.detail) {
          try { boxes.price.set(buildPriceBody()); } catch { /* 信息还不完整 */ }
        }
      });
      $(id).addEventListener('change', () => {
        $(id).dispatchEvent(new Event('input', { bubbles: false }));
      });
    });

    $('btn-f-search').addEventListener('click', doSearch);
    $('btn-f-products').addEventListener('click', doProducts);
    $('btn-f-detail').addEventListener('click', doDetail);
    $('btn-f-passengers').addEventListener('click', doPassengers);
    $('btn-f-price').addEventListener('click', doPrice);
    $('btn-f-create').addEventListener('click', doCreate);
    $('btn-f-pay').addEventListener('click', doPay);
    $('btn-f-alipay').addEventListener('click', doAlipay);
    $('btn-f-order-detail').addEventListener('click', doOrderDetail);
    $('btn-f-cancel').addEventListener('click', doCancel);
    $('btn-flight-reset').addEventListener('click', resetFlow);

    $('f-orderNo').addEventListener('input', () => {
      const hasOrder = Boolean($('f-orderNo').value.trim());
      enablePay(hasOrder);
    });
  }

  window.FlightFlow = { init: initFlight, reset: resetFlow };
})();
