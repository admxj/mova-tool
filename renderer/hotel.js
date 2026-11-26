/* 酒店：搜索 → 详情选房型 → 验价 → 创单 → 支付。 */
(function () {
  'use strict';

  const { $, esc, money, uid, api, toast, jsonBox, showError, okResponse, settings, session, dateOffset, normalizeCardType } = window.TMC;

  const state = {
    hotels: [],
    hotel: null,
    detail: null,
    room: null,
    product: null,
    quote: null,
    orderNo: '',
    passengers: [],
    guest: null,
  };

  const boxes = {};

  const CANCEL_REASON_LABELS = {
    TRIP_CANCELLED: '行程取消',
    TIME_CHANGED: '时间变更',
    LOCATION_UNSUITABLE: '酒店位置不合适',
    OTHER: '其他',
  };

  const SEARCH_FORM_KEY = 'tmc.hotel.search.v1';
  const SEARCH_FORM_FIELDS = ['h-purpose', 'h-cityCode', 'h-cityName', 'h-checkIn', 'h-checkOut', 'h-pageSize'];

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

  const nightsBetween = (checkIn, checkOut) => {
    const start = new Date(`${checkIn}T00:00:00`);
    const end = new Date(`${checkOut}T00:00:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 1;
    const nights = Math.round((end - start) / 86400000);
    return nights > 0 ? nights : 1;
  };

  const addDays = (date, days) => {
    const d = new Date(`${date}T00:00:00`);
    d.setDate(d.getDate() + days);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  const checkResponse = (result) => {
    if (!okResponse(result)) throw new Error(result.error || `HTTP ${result.status}`);
    return window.TMC.unwrap(result);
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

  const setStepEnabled = (index, enabled) => {
    const section = $(`h-step-${index}`);
    if (section) section.classList.toggle('muted', !enabled);
  };

  function tenantValue() {
    const raw = String(settings.tenantCode || (session.userInfo && session.userInfo.tenantCode) || '').trim();
    if (!raw) return undefined;
    return /^\d+$/.test(raw) ? Number(raw) : raw;
  }

  /* ---------------- 请求体 ---------------- */

  const travelPurpose = () => $('h-purpose').value;

  function buildSearchBody() {
    const checkInDate = $('h-checkIn').value;
    const checkOutDate = $('h-checkOut').value;
    const body = {
      travelPurpose: travelPurpose(),
      checkInDate,
      checkOutDate,
      nightCount: nightsBetween(checkInDate, checkOutDate),
      pageNumber: 1,
      pageSize: Number($('h-pageSize').value || 10),
    };
    const cityCode = $('h-cityCode').value.trim();
    if (cityCode) body.cityCode = Number(cityCode);
    const cityName = $('h-cityName').value.trim();
    if (cityName) body.cityName = cityName;
    return body;
  }

  function buildDetailBody() {
    const body = {
      hotelId: $('h-hotelId').value.trim(),
      travelPurpose: travelPurpose(),
      checkInDate: $('h-checkIn').value,
      checkOutDate: $('h-checkOut').value,
    };
    const supplierHotelId = $('h-supplierHotelId').value.trim();
    if (supplierHotelId) body.supplierHotelId = supplierHotelId;
    return body;
  }

  function buildQuoteBody() {
    const hotel = state.hotel;
    const room = state.room;
    const product = state.product;
    if (!hotel || !room || !product) throw new Error('请先选择酒店、房型和产品');
    if (!product.partnerCode) throw new Error('该产品缺少 partnerCode，无法验价');

    const checkInDate = $('h-checkIn').value;
    const checkOutDate = $('h-checkOut').value;
    const nights = nightsBetween(checkInDate, checkOutDate);
    const nightly = Array.isArray(product.nightlyPrices) ? product.nightlyPrices : [];
    const roomNights = Array.from({ length: nights }, (_, index) => {
      const item = nightly[index] || {};
      const amountCents = item.price !== undefined && item.price !== null
        ? Math.round(Number(item.price))
        : Math.round(Number(product.price || product.totalRoomPrice || 0) / nights);
      const supplierCents = item.supplierPrice !== undefined && item.supplierPrice !== null
        ? Math.round(Number(item.supplierPrice))
        : undefined;
      const night = {
        stayDate: item.saleDate || item.date || addDays(checkInDate, index),
        roomCount: 1,
        saleRoomAmount: amountCents,
        actualRoomAmount: amountCents,
        serviceFee: 0,
        ratePlanSnapshot: JSON.stringify({
          ratePlanName: product.ratePlanName,
          ratePlanCode: product.ratePlanCode,
          hotelProductType: product.hotelProductType,
          breakfast: product.breakfast,
          cancellationText: product.cancelPolicy,
        }),
      };
      if (supplierCents !== undefined) night.supplierSaleRoomAmount = supplierCents;
      return night;
    });

    const guestName = $('h-g-name').value.trim();
    const guestCardNo = $('h-g-cardNo').value.trim();
    const guestPhone = $('h-g-phone').value.trim();
    if (!guestName || !guestCardNo || !guestPhone) throw new Error('请填写入住人姓名、证件号、手机号');

    const contactName = $('h-contact-name').value.trim() || guestName;
    const contactPhone = $('h-contact-phone').value.trim() || guestPhone;
    const partnerCode = String(product.partnerCode).trim();
    const guest = state.guest;
    const isPrivate = travelPurpose() === 'PRIVATE';
    const selfEmployeeId = (session.userInfo && session.userInfo.employeeId) || undefined;
    const guestPayload = guest
      ? {
          employeeId: isPrivate ? selfEmployeeId : (guest.employeeId || guest.id),
          name: guest.name,
          enName: guest.enName,
          mobileMask: guest.mobileMask,
          mobileCipher: guestPhone,
          cardType: normalizeCardType(guest.cardType),
          cardNoMask: guest.cardNoMask || guestCardNo,
          jobNo: guest.jobNo,
          deptId: guest.deptId,
          deptCode: guest.deptCode,
          deptName: guest.deptName,
        }
      : {
          employeeId: isPrivate ? selfEmployeeId : undefined,
          name: guestName,
          cardType: $('h-g-cardType').value || 'NI',
          cardNo: guestCardNo,
          mobileCipher: guestPhone,
        };
    Object.keys(guestPayload).forEach((key) => { if (guestPayload[key] === undefined) delete guestPayload[key]; });

    const body = {
      idempotentKey: uid(),
      travelPurpose: travelPurpose(),
      tenantCode: tenantValue(),
      employeeName: guestName,
      settleChannel: 'CREDIT',
      orderSource: 'H5',
      normHotelId: hotel.id || $('h-hotelId').value.trim(),
      channelHotelId: hotel.supplierHotelId || $('h-supplierHotelId').value.trim() || undefined,
      partnerCode,
      supplyCode: product.supplyCode || '',
      hotelName: hotel.name,
      hotelCityId: hotel.cityCode ? String(hotel.cityCode) : undefined,
      hotelCityName: hotel.cityName || $('h-cityName').value.trim() || undefined,
      hotelAddress: hotel.address,
      houseTypeId: String(room.roomId || ''),
      roomName: room.roomName || '',
      productId: product.ratePlanId || product.ratePlanCode || '',
      productName: product.ratePlanName || '',
      hotelProductType: product.hotelProductType,
      ratePlanCode: product.ratePlanCode || product.ratePlanId || '',
      checkInDate,
      checkOutDate,
      roomCount: 1,
      guestCount: 1,
      breakfastType: product.breakfast || undefined,
      windowType: String(product.windowType || room.windowType || '') || undefined,
      payAtHotelFlag: product.payAtHotelFlag === 1 ? 1 : 0,
      cancelPolicy: product.cancelPolicy ? String(product.cancelPolicy).slice(0, 1000) : undefined,
      cancelRule: product.cancelPolicy || undefined,
      lastCancelTime: product.latestFreeCancelTime || undefined,
      contactName,
      contactTelCipher: contactPhone,
      guests: [guestPayload],
      roomNights,
    };
    Object.keys(body).forEach((key) => { if (body[key] === undefined) delete body[key]; });
    return body;
  }

  function buildCreateBody() {
    if (!state.quote || !state.quote.quoteToken) throw new Error('缺少 quoteToken，请先验价');
    const body = {
      quoteToken: state.quote.quoteToken,
      idempotentKey: uid(),
      travelPurpose: travelPurpose(),
    };
    if (state.quote.financeUnitCode) body.financeUnitCode = state.quote.financeUnitCode;
    const applyNo = $('h-applyNo').value.trim();
    if (applyNo) body.applyNo = applyNo;
    const overage = $('h-overageReason').value.trim();
    if (overage) body.overageReason = overage;
    return body;
  }

  /* ---------------- 渲染 ---------------- */

  function renderHotels(hotels) {
    const container = $('h-hotels');
    if (!Array.isArray(hotels) || hotels.length === 0) {
      container.innerHTML = '<div class="empty">没有搜索到酒店</div>';
      return;
    }
    container.innerHTML = hotels.map((hotel, index) => `
      <article class="card">
        <div class="card-head">
          <div>
            <strong>${esc(hotel.name || '酒店')}</strong>
            <span class="muted-text">${esc(hotel.star || '')} · ${esc(hotel.address || '')}</span>
          </div>
          <div class="price">${esc(money(Number(hotel.price || 0)))}</div>
        </div>
        <div class="muted-text">
          hotelId: <code>${esc(hotel.id || '-')}</code>
          · supplierHotelId: <code>${esc(hotel.supplierHotelId || '-')}</code>
          · ${esc(hotel.distanceKm !== undefined ? hotel.distanceKm + 'km' : '')}
        </div>
        <div class="actions"><button class="ghost small" data-hotel-pick="${index}">选此酒店</button></div>
      </article>`).join('');

    container.querySelectorAll('[data-hotel-pick]').forEach((button) => {
      button.addEventListener('click', () => {
        const hotel = state.hotels[Number(button.dataset.hotelPick)];
        state.hotel = hotel;
        window.BookingPreview.hotel(hotel);
        state.detail = state.room = state.product = state.quote = null;
        for (const id of ['h-rooms', 'h-quote']) $(id).innerHTML = '';
        for (const id of ['btn-h-price', 'btn-h-create']) $(id).disabled = true;
        setStepEnabled(3, false);
        setStepEnabled(4, false);
        $('h-hotelId').value = hotel.id || '';
        $('h-supplierHotelId').value = hotel.supplierHotelId || '';
        boxes.detail.set(buildDetailBody());
        $('btn-h-detail').disabled = !hotel.id;
        $('h-selected-hint').textContent = `已选 ${hotel.name || hotel.id}`;
        setStepEnabled(2, true);
        $('h-step-2').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });
  }

  function renderRooms(rooms) {
    const container = $('h-rooms');
    if (!Array.isArray(rooms) || rooms.length === 0) {
      container.innerHTML = '<div class="empty">没有可订房型</div>';
      return;
    }
    container.innerHTML = rooms.map((room, roomIndex) => {
      const products = room.products || [];
      const rows = products.length
        ? products.map((product, productIndex) => `
          <tr>
            <td>${esc(product.ratePlanName || '-')}</td>
            <td>${esc(product.hotelProductType || '-')}</td>
            <td>${esc(product.breakfast || '-')}</td>
            <td class="price">${esc(money(Number(product.price || product.totalRoomPrice || 0)))}</td>
            <td><button class="ghost small" data-room-pick="${roomIndex}" data-product-pick="${productIndex}">选此产品</button></td>
          </tr>`).join('')
        : '<tr><td colspan="5" class="empty">该房型暂无可订产品</td></tr>';

      return `
        <article class="card">
          <div class="card-head">
            <strong>${esc(room.roomName || '房型')}</strong>
            <span class="muted-text">${esc(room.bedDescription || '')} · ${esc(room.roomArea || '')} · ${esc(room.windowType || '')}</span>
          </div>
          <table class="mini-table">
            <thead><tr><th>产品</th><th>类型</th><th>早餐</th><th>价格</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </article>`;
    }).join('');

    container.querySelectorAll('[data-room-pick]').forEach((button) => {
      button.addEventListener('click', () => {
        const room = rooms[Number(button.dataset.roomPick)];
        const product = (room.products || [])[Number(button.dataset.productPick)];
        selectRoom(room, product);
      });
    });
  }

  function selectRoom(room, product) {
    state.room = room;
    state.product = product;
    if (!product) return;
    window.BookingPreview.hotel(state.hotel, state.detail?.hotelDetail, room, product);
    state.quote = null;
    $('h-quote').innerHTML = '';
    $('btn-h-create').disabled = true;
    setStepEnabled(4, false);
    try {
      boxes.price.set(buildQuoteBody());
    } catch {
      /* 入住人信息还没填完，验价时再统一校验 */
    }
    $('btn-h-price').disabled = false;
    setStepEnabled(3, true);
    $('h-price-hint').textContent = `已选 ${product.ratePlanName || ''} · ${product.partnerCode || ''}`;
  }

  /* ---------------- 常旅客 ---------------- */
  function isGuestComplete(passenger) {
    return Boolean(
      passenger
      && passenger.id !== undefined
      && passenger.name && String(passenger.name).trim()
      && passenger.cardType && String(passenger.cardType).trim()
      && ((passenger.cardNoMask && String(passenger.cardNoMask).trim())
        || (passenger.cardNo && String(passenger.cardNo).trim()))
      && /^1[3-9]\d{9}$/.test(String(passenger.mobile || '').trim()),
    );
  }

  function renderPassengers() {
    const container = $('h-passengers');
    if (!container) return;
    if (!state.passengers.length) {
      container.innerHTML = '';
      return;
    }
    container.innerHTML = state.passengers.map((passenger, index) => {
      const active = state.guest && state.guest.id === passenger.id;
      const complete = isGuestComplete(passenger);
      const cert = [passenger.cardTypeDesc || passenger.cardType, passenger.cardNoMask || passenger.cardNo].filter(Boolean).join(' ');
      const phone = passenger.mobile || passenger.mobileMask || '缺手机号';
      return `
        <button type="button" class="pax-item${active ? ' active' : ''}${complete ? '' : ' pax-incomplete'}" data-h-pax="${index}">
          <b>${esc(passenger.name || '-')}</b>
          <span class="muted-text">${esc(cert)}</span>
          <span class="muted-text">${esc(phone)}</span>
        </button>`;
    }).join('');
    container.querySelectorAll('[data-h-pax]').forEach((button) => {
      button.addEventListener('click', () => selectGuest(state.passengers[Number(button.dataset.hPax)]));
    });
  }

  function selectGuest(passenger) {
    if (!passenger) return false;
    if (!isGuestComplete(passenger)) {
      toast('该常旅客缺少手机号或证件信息，请换一位或手动填写', 'error');
      return false;
    }
    state.guest = passenger;
    $('h-g-name').value = passenger.name || '';
    $('h-g-cardType').value = normalizeCardType(passenger.cardType);
    $('h-g-cardNo').value = String(passenger.cardNoMask || passenger.cardNo || '').replace(/\s+/g, '');
    $('h-g-phone').value = String(passenger.mobile || '').trim();
    if (!$('h-contact-name').value.trim()) $('h-contact-name').value = passenger.name || '';
    if (!$('h-contact-phone').value.trim()) $('h-contact-phone').value = String(passenger.mobile || '').trim();
    renderPassengers();
    if (state.room && state.product) {
      try { boxes.price.set(buildQuoteBody()); } catch { /* 等用户补齐其他信息 */ }
    }
    toast(`已选择入住人 ${passenger.name || ''}`, 'ok');
    return true;
  }

  async function doPassengers(autoSelect) {
    const button = $('btn-h-passengers');
    button.disabled = true;
    $('h-pax-hint').textContent = '正在拉取常旅客…';
    try {
      const result = await api('java', '/passenger/list', {
        body: { pageNum: 1, pageSize: 100 },
      });
      const json = checkResponse(result);
      const list = Array.isArray(json) ? json : (json.list || []);
      state.passengers = list;
      renderPassengers();
      $('h-pax-hint').textContent = list.length
        ? `共 ${list.length} 位常旅客，点选即可填入入住人`
        : '没有查到常旅客，可手动填写';
      if (autoSelect) {
        const preferred = list.find((item) => item.source === 'ORG' && isGuestComplete(item))
          || list.find(isGuestComplete);
        if (preferred) selectGuest(preferred);
      }
    } catch (error) {
      showError($('h-passengers'), error);
      $('h-pax-hint').textContent = '拉取常旅客失败';
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  /* ---------------- 动作 ---------------- */

  async function doSearch() {
    const button = $('btn-h-search');
    button.disabled = true;
    saveSearchForm();
    $('h-search-hint').textContent = '搜索中…';
    try {
      const json = checkResponse(await api('java', '/hotel/search', { body: boxes.search.get() }));
      window.BookingPreview.clear('hotel');
      state.hotels = json.hotels || [];
      renderHotels(state.hotels);
      $('h-search-hint').textContent = `共 ${json.total !== undefined ? json.total : state.hotels.length} 家 · searchSessionId ${json.searchSessionId || '-'}`;
      toast(`搜索到 ${state.hotels.length} 家酒店`, 'ok');
    } catch (error) {
      showError($('h-hotels'), error);
      $('h-search-hint').textContent = '搜索失败';
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function doDetail() {
    const selected = state.hotel;
    const button = $('btn-h-detail');
    button.disabled = true;
    try {
      const json = checkResponse(await api('java', '/hotel/detail', { body: boxes.detail.get() }));
      if (state.hotel !== selected) return;
      state.detail = json;
      window.BookingPreview.hotel(state.hotel, json.hotelDetail);
      renderRooms(json.rooms || []);
      setStepEnabled(3, true);
      toast(`加载到 ${(json.rooms || []).length} 个房型`, 'ok');
      if (!state.passengers.length) void doPassengers(true);
    } catch (error) {
      if (state.hotel !== selected) return;
      showError($('h-rooms'), error);
      toast(error.message, 'error');
    } finally {
      if (state.hotel === selected) button.disabled = false;
    }
  }

  async function doPrice() {
    const button = $('btn-h-price');
    button.disabled = true;
    try {
      const json = checkResponse(await api('java', '/hotel/orders/price', { body: boxes.price.get() }));
      const quoteToken = json.quoteToken && String(json.quoteToken).trim();
      if (!quoteToken) throw new Error(json.verifyMessage || '验价结果缺少 quoteToken');
      json.quoteToken = quoteToken;
      state.quote = json;
      $('h-quote').innerHTML = `
        <div class="card">
          <div class="card-head"><strong>验价成功</strong><span class="badge ok">quoteToken 已获取</span></div>
          <div class="kv">
            <div><span>房费</span><b>${esc(money(json.saleAmount))}</b></div>
            <div><span>实付</span><b>${esc(money(json.actualAmount || json.saleAmount))}</b></div>
            <div><span>服务费</span><b>${esc(money(json.serviceFeeTotal))}</b></div>
            <div><span>${travelPurpose() === 'PRIVATE' ? '个人承担' : '企业承担'}</span><b>${esc(money(json.personalPayAmount !== undefined && travelPurpose() === 'PRIVATE' ? json.personalPayAmount : json.companyPayAmount))}</b></div>
          </div>
          ${json.priceChanged ? '<div class="out-error">价格发生变化，请确认后再下单</div>' : ''}
          <div class="muted-text">quoteToken: <code>${esc(json.quoteToken)}</code></div>
        </div>`;
      boxes.create.set(buildCreateBody());
      $('btn-h-create').disabled = false;
      setStepEnabled(4, true);
      toast('酒店验价成功', 'ok');
    } catch (error) {
      showError($('h-quote'), error);
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function doCreate() {
    const button = $('btn-h-create');
    button.disabled = true;
    try {
      const result = await api('java', '/hotel/orders/create', { body: boxes.create.get() });
      const order = checkResponse(result);
      if (!order.orderNo) throw new Error(order.message || '下单响应没有 orderNo');
      state.orderNo = order.orderNo;
      $('h-orderNo').value = order.orderNo;
      out($('h-order'), result, `订单 ${order.orderNo}`);
      enablePay(true);
      setStepEnabled(5, true);
      $('h-step-5').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      toast(`酒店下单成功：${order.orderNo}`, 'ok');
    } catch (error) {
      showError($('h-order'), error);
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  function enablePay(enabled) {
    ['btn-h-pay', 'btn-h-pay-status', 'btn-h-alipay', 'btn-h-order-detail', 'btn-h-cancel', 'btn-h-refunds'].forEach((id) => { $(id).disabled = !enabled; });
  }

  const orderPath = () => encodeURIComponent($('h-orderNo').value.trim());

  async function doPay() {
    if (!$('h-orderNo').value.trim()) return toast('请填写订单号', 'error');
    const result = await api('java', `/hotel/orders/${orderPath()}/pay`, {
      body: { travelPurpose: travelPurpose() },
    });
    checkResponse(result);
    out($('h-pay'), result, '企业支付结果');
  }

  async function doPayStatus() {
    if (!$('h-orderNo').value.trim()) return;
    const result = await api('java', `/hotel/orders/${orderPath()}/pay/status`, { method: 'GET' });
    checkResponse(result);
    out($('h-pay'), result, '支付状态');
  }

  async function doAlipay() {
    if (!$('h-orderNo').value.trim()) return;
    const result = await api('java', `/hotel/orders/${orderPath()}/pay/alipay`, {
      body: { idempotentKey: uid(), travelPurpose: travelPurpose() },
    });
    const data = checkResponse(result);
    out($('h-pay'), result, '支付宝支付参数');
    TMC.showPay($('h-pay'), data, '酒店支付宝支付');
  }

  async function doOrderDetail() {
    if (!$('h-orderNo').value.trim()) return;
    const result = await api('java', `/hotel/orders/${orderPath()}/detail`, { body: {} });
    checkResponse(result);
    out($('h-pay'), result, '酒店订单详情');
  }

  /* ---------------- 退订 / 取消 ---------------- */

  const cancelMode = () => $('h-cancel-mode').value;

  function buildCancelBody() {
    const body = { idempotentKey: uid(), travelPurpose: travelPurpose() };
    if (cancelMode() === 'refund') {
      const code = $('h-cancel-reason').value;
      body.reasonCode = code;
      const desc = $('h-cancel-desc').value.trim();
      if (desc) body.reasonDesc = desc;
      else if (CANCEL_REASON_LABELS[code] && code !== 'OTHER') body.reasonDesc = CANCEL_REASON_LABELS[code];
    }
    const applyNo = $('h-cancel-applyNo').value.trim();
    if (applyNo) body.applyNo = applyNo;
    return body;
  }

  function syncCancelMode() {
    const refund = cancelMode() === 'refund';
    $('h-cancel-reason').disabled = !refund;
    $('h-cancel-desc').disabled = !refund;
  }

  async function doCancel() {
    if (!$('h-orderNo').value.trim()) return toast('请填写订单号', 'error');
    const body = boxes.cancel.get();
    if (cancelMode() === 'refund' && body.reasonCode === 'OTHER' && !String(body.reasonDesc || '').trim()) {
      return toast('退订原因为「其他」时，请填写原因说明', 'error');
    }
    const button = $('btn-h-cancel');
    button.disabled = true;
    try {
      const result = await api('java', `/hotel/orders/${orderPath()}/cancel`, { body });
      const data = checkResponse(result);
      out($('h-cancel'), result, cancelMode() === 'refund' ? '退订提交结果' : '取消提交结果');
      toast(`已提交${cancelMode() === 'refund' ? '退订' : '取消'}：${data.cancelNo || data.orderNo || ''}`, 'ok');
      // 提交成功后换一个幂等键，方便再次调试；同一订单重复提交相同 key 会被后端去重。
      boxes.cancel.set(buildCancelBody());
    } catch (error) {
      showError($('h-cancel'), error);
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function doRefunds() {
    if (!$('h-orderNo').value.trim()) return toast('请填写订单号', 'error');
    try {
      const result = await api('java', `/hotel/orders/${orderPath()}/refunds`, { method: 'GET' });
      checkResponse(result);
      out($('h-cancel'), result, '退款单');
    } catch (error) {
      showError($('h-cancel'), error);
      toast(error.message, 'error');
    }
  }

  function resetFlow() {
    window.BookingPreview.clear('hotel');
    state.hotels = [];
    state.hotel = null;
    state.detail = null;
    state.room = null;
    state.product = null;
    state.quote = null;
    state.orderNo = '';
    state.passengers = [];
    state.guest = null;
    ['h-hotels', 'h-rooms', 'h-quote', 'h-order', 'h-pay', 'h-cancel', 'h-passengers'].forEach((id) => { $(id).innerHTML = ''; });
    ['h-hotelId', 'h-supplierHotelId', 'h-orderNo'].forEach((id) => { $(id).value = ''; });
    ['btn-h-detail', 'btn-h-price', 'btn-h-create'].forEach((id) => { $(id).disabled = true; });
    enablePay(false);
    [2, 3, 4, 5].forEach((index) => setStepEnabled(index, false));
    boxes.search.set(buildSearchBody());
    boxes.detail.set({ hotelId: '', checkInDate: $('h-checkIn').value, checkOutDate: $('h-checkOut').value });
    boxes.price.set({});
    boxes.create.set({});
    toast('酒店流程已重置', 'ok');
  }

  function updatePurposeHint() {
    $('h-purpose-hint').hidden = travelPurpose() !== 'PRIVATE';
  }

  function onPurposeChange() {
    updatePurposeHint();
    if (state.hotel) boxes.detail.set(buildDetailBody());
    state.quote = null;
    $('h-quote').innerHTML = '';
    $('btn-h-create').disabled = true;
    enablePay(false);
    if (state.room && state.product) {
      try { boxes.price.set(buildQuoteBody()); } catch { /* 入住人未填完时忽略 */ }
    }
    toast(`已切换为${travelPurpose() === 'PRIVATE' ? '因私' : '因公'}，请重新验价`, 'ok');
  }

  /* ---------------- 城市下拉（/hotel/region/search） ---------------- */
  const cityState = { items: [], active: -1, timer: null, seq: 0 };

  function closeCityOptions() {
    $('h-city-options').hidden = true;
    cityState.active = -1;
  }

  function pickCity(region) {
    if (!region || !region.cityCode) return;
    $('h-cityCode').value = region.cityCode;
    if (region.name) $('h-cityName').value = region.name;
    boxes.search.set(buildSearchBody());
    saveSearchForm();
    closeCityOptions();
  }

  function renderCityOptions(regions) {
    const list = $('h-city-options');
    cityState.items = regions;
    cityState.active = -1;
    if (!regions.length) {
      list.innerHTML = '<div class="combo-empty">没有匹配城市</div>';
    } else {
      list.innerHTML = regions.map((region, index) => `
        <div class="combo-item" data-city-index="${index}">
          <span>${esc(region.name || '-')}</span><code>${esc(region.cityCode || '')}</code>
        </div>`).join('');
      list.querySelectorAll('[data-city-index]').forEach((item) => {
        item.addEventListener('mousedown', (event) => {
          event.preventDefault();
          pickCity(cityState.items[Number(item.dataset.cityIndex)]);
        });
      });
    }
    list.hidden = false;
  }

  async function searchCities(keyword) {
    const seq = ++cityState.seq;
    try {
      const result = await api('java', '/hotel/region/search', {
        method: 'POST',
        body: keyword ? { keyword } : {},
      });
      if (seq !== cityState.seq) return;
      const json = checkResponse(result);
      const groups = json.groups || [];
      renderCityOptions(groups.flatMap((group) => group.regions || []).filter((region) => region && region.cityCode));
    } catch (error) {
      if (seq !== cityState.seq) return;
      const list = $('h-city-options');
      list.innerHTML = `<div class="combo-empty">${esc(error.message || '城市加载失败')}</div>`;
      list.hidden = false;
    }
  }

  function setupCityPicker() {
    const input = $('h-cityCode');
    input.addEventListener('input', () => {
      clearTimeout(cityState.timer);
      cityState.timer = setTimeout(() => searchCities(input.value.trim()), 250);
    });
    input.addEventListener('focus', () => {
      if ($('h-city-options').hidden && !input.value.trim()) searchCities('');
    });
    input.addEventListener('blur', () => setTimeout(closeCityOptions, 120));
    input.addEventListener('keydown', (event) => {
      if ($('h-city-options').hidden) return;
      const items = [...$('h-city-options').querySelectorAll('.combo-item')];
      if (!items.length) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        cityState.active = event.key === 'ArrowDown'
          ? Math.min(cityState.active + 1, items.length - 1)
          : Math.max(cityState.active - 1, 0);
        items.forEach((item, index) => item.classList.toggle('active', index === cityState.active));
        items[cityState.active].scrollIntoView({ block: 'nearest' });
      } else if (event.key === 'Enter' && cityState.active >= 0) {
        event.preventDefault();
        pickCity(cityState.items[cityState.active]);
        input.blur();
      } else if (event.key === 'Escape') {
        closeCityOptions();
      }
    });
  }

  function initHotel() {
    const restored = restoreSearchForm();
    if (!$('h-checkIn').value) $('h-checkIn').value = dateOffset(7);
    if (!$('h-checkOut').value) $('h-checkOut').value = dateOffset(8);
    if (restored) $('h-search-hint').textContent = '已恢复上次查询条件';

    boxes.search = jsonBox($('h-json-search'), buildSearchBody());
    boxes.detail = jsonBox($('h-json-detail'), buildDetailBody());
    boxes.price = jsonBox($('h-json-price'), {});
    boxes.create = jsonBox($('h-json-create'), {});
    boxes.cancel = jsonBox($('h-json-cancel'), buildCancelBody());

    const syncSearch = () => {
      boxes.search.set(buildSearchBody());
      saveSearchForm();
    };
    SEARCH_FORM_FIELDS.forEach((id) => {
      $(id).addEventListener('input', syncSearch);
      $(id).addEventListener('change', syncSearch);
    });
    $('h-purpose').addEventListener('change', onPurposeChange);
    updatePurposeHint();
    setupCityPicker();

    ['h-hotelId', 'h-supplierHotelId'].forEach((id) => {
      $(id).addEventListener('input', () => {
        if (state.hotel) boxes.detail.set(buildDetailBody());
      });
    });

    ['h-g-name', 'h-g-cardType', 'h-g-cardNo', 'h-g-phone', 'h-contact-name', 'h-contact-phone'].forEach((id) => {
      if (id === 'h-g-cardType') {
        $(id).addEventListener('change', () => $(id).dispatchEvent(new Event('input', { bubbles: false })));
      }
      $(id).addEventListener('input', () => {
        if (id === 'h-g-name' || id === 'h-g-cardType' || id === 'h-g-cardNo') {
          state.guest = null;
          renderPassengers();
        }
        if (state.room && state.product) {
          try { boxes.price.set(buildQuoteBody()); } catch { /* 信息还不完整 */ }
        }
      });
    });

    syncCancelMode();
    ['h-cancel-mode', 'h-cancel-reason', 'h-cancel-desc', 'h-cancel-applyNo'].forEach((id) => {
      $(id).addEventListener('input', () => boxes.cancel.set(buildCancelBody()));
      $(id).addEventListener('change', () => {
        if (id === 'h-cancel-mode') syncCancelMode();
        boxes.cancel.set(buildCancelBody());
      });
    });

    $('btn-h-passengers').addEventListener('click', () => doPassengers(false));
    $('btn-h-search').addEventListener('click', doSearch);
    $('btn-h-detail').addEventListener('click', doDetail);
    $('btn-h-price').addEventListener('click', doPrice);
    $('btn-h-create').addEventListener('click', doCreate);
    $('btn-h-pay').addEventListener('click', doPay);
    $('btn-h-pay-status').addEventListener('click', doPayStatus);
    $('btn-h-alipay').addEventListener('click', doAlipay);
    $('btn-h-order-detail').addEventListener('click', doOrderDetail);
    $('btn-h-cancel').addEventListener('click', doCancel);
    $('btn-h-refunds').addEventListener('click', doRefunds);
    $('btn-hotel-reset').addEventListener('click', resetFlow);

    $('h-orderNo').addEventListener('input', () => {
      enablePay(Boolean($('h-orderNo').value.trim()));
      boxes.cancel.set(buildCancelBody());
    });
  }

  window.HotelFlow = { init: initHotel, reset: resetFlow };
})();
