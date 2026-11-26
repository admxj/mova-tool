/* 机票改签：按 H5 契约逐步校验，提交和支付均需确认。 */
(function () {
  'use strict';

  const text = (value) => String(value ?? '').trim();
  const cents = (value) => {
    if (!text(value)) return undefined;
    const amount = Math.round(Number(value) * 100);
    return Number.isSafeInteger(amount) && amount >= 0 ? amount : undefined;
  };
  const amount = (n) => Number.isSafeInteger(n) && n >= 0;
  const beijingTime = (value) => {
    const raw = text(value);
    if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
      const time = Date.parse(raw);
      return Number.isFinite(time) ? new Date(time + 28800000).toISOString().slice(0, 19).replace('T', ' ') : '';
    }
    const match = raw.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?/);
    return match ? `${match[1]} ${match[2]}:${match[3] || '00'}` : '';
  };
  const prices = (product) => product.tripPrice?.price?.adultPrice || {};
  function quote(product) {
    const { price, air, oil, totalPrice } = prices(product);
    if (text(totalPrice)) return cents(totalPrice);
    const parts = [price, air, oil].map(cents);
    return parts.every(amount) ? parts.reduce((a, b) => a + b, 0) : undefined;
  }
  function selectedFlight(route, product) {
    const segment = route.trip?.segments?.[0] || {};
    const price = prices(product);
    const ticket = cents(price.price);
    return {
      guid: text(route.trip?.guid), detailKey: text(product.detailKey),
      flightNo: segment.lineNo || '', carrierFlightNo: segment.lineNo || '',
      airlineCode: segment.mktCode || segment.opCode || '',
      aircraftModel: segment.equip?.craftCode || segment.equip?.craftName,
      departureAirport: segment.depStation?.stationCode || '', arrivalAirport: segment.arrStation?.stationCode || '',
      departureTerminal: segment.depStation?.terminal, arrivalTerminal: segment.arrStation?.terminal,
      takeoffTime: beijingTime(segment.depDate), arrivalTime: beijingTime(segment.arrDate),
      cabinCode: product.cabinInfo?.cabins?.[0]?.cabinCode || '', cabinLevel: product.cabinInfo?.cabinClassCode,
      cabinDiscount: product.tripPrice?.cabinDiscount, policyId: product.tripPrice?.policyId || '',
      salePrice: ticket ?? cents(price.totalPrice), airportFee: ticket === undefined ? 0 : cents(price.air) ?? 0,
      fuelFee: ticket === undefined ? 0 : cents(price.oil) ?? 0,
    };
  }
  function comparableFlights(routes) {
    return routes.flatMap((route) => {
      const guid = text(route.trip?.guid);
      const segments = route.trip?.segments || [];
      const first = segments[0];
      const last = segments.at(-1);
      if (!guid || !first) return [];
      const quotes = (route.productInfos || []).flatMap((product) => {
        const cabinLevel = text(product.cabinInfo?.cabinClassCode).toUpperCase();
        const price = quote(product);
        const fareClass = (product.cabinInfo?.cabins || []).map((cabin) => text(cabin.cabinCode).toUpperCase()).filter(Boolean).join('/');
        return cabinLevel && amount(price) ? [{ cabinLevel, price, ...(fareClass ? { fareClass } : {}) }] : [];
      });
      return quotes.length ? [{
        guid, quotes, airlineCode: text(first.opCode || first.mktCode),
        flightNo: text(first.opLineNo || first.lineNo).toUpperCase().replace(/^[A-Z0-9]{2}(?=\d)/, ''),
        departureAirportCode: first.depStation?.stationCode, arrivalAirportCode: last.arrStation?.stationCode,
        departureTime: first.depDate, arrivalTime: last.arrDate,
      }] : [];
    });
  }

  function init() {
    const root = document.getElementById('air-change-panel');
    if (!root || !window.TMC) return;
    const { api, unwrap, money, uid, esc, settings, session } = window.TMC;
    root.innerHTML = `
      <p>仅支持 H5 自愿、因公改签（企业支付）；因私或非自愿改签请通过其他已支持渠道办理。</p>
      <div class="grid">
        <label>原订单号 <input data-field="order" placeholder="留空使用上方机票订单号"></label>
        <label>指定票号（选填，逗号分隔） <input data-field="tickets" placeholder="默认检查订单全部票号"></label>
        <label>新出发日期 <input type="date" data-field="date"></label>
        <label>新航班及舱位 <select data-field="cabin"><option value="">请先查询</option></select></label>
        <label>改签原因 <input data-field="reason" maxlength="500"></label>
        <label>出差申请单号 <input data-field="apply" placeholder="仅未获豁免时需要"></label>
        <label>超标原因（差标要求时填写） <input data-field="overage" maxlength="500"></label>
        <label>改签子订单号 <input data-field="endorse" placeholder="提交后自动填入，也可填入查询详情"></label>
      </div>
      <div class="actions">
        <button type="button" data-action="search">查询可改签航班及舱位</button>
        <button type="button" data-action="estimate">预估改签费用</button>
        <button type="button" data-action="submit">提交改签</button>
        <button type="button" data-action="pay">确认企业支付</button>
        <button type="button" data-action="detail">查询改签详情</button>
      </div>
      <p data-status role="status" aria-live="polite"></p>`;
    const field = (name) => root.querySelector(`[data-field="${name}"]`);
    const btn = (name) => root.querySelector(`[data-action="${name}"]`);
    const value = (name) => text(field(name).value);
    const status = root.querySelector('[data-status]');
    const orderNo = () => value('order') || text(document.getElementById('f-orderNo')?.value);
    const context = () => JSON.stringify([settings.javaBase, settings.javaPrefix, settings.goBase, settings.goPrefix,
      settings.tenantCode, session.token, session.userInfo?.employeeId, session.userInfo?.employee_no, session.userInfo?.employeeNo]);
    const environment = () => `${settings.javaBase}${settings.javaPrefix} · 租户 ${settings.tenantCode || '登录态默认'}`;
    const queryKey = () => JSON.stringify([context(), orderNo(), value('tickets'), value('date')]);
    const childPath = (id) => `/air/order/${encodeURIComponent(id)}`;
    const ask = (message) => window.confirm(message);
    const requests = new Map();
    const submitted = new Set();
    let search, estimate, submission, activeContext, busy = false;
    const choice = () => search && search.key === queryKey() && value('cabin') !== ''
      ? search.choices[Number(value('cabin'))] : undefined;
    const currentEstimate = () => estimate?.choice === choice() ? estimate : undefined;
    const payable = () => submission && !submission.paid && submission.context === context() && submission.endorseNo === value('endorse') &&
      Number.isSafeInteger(submission.payAmount) && ['PENDING', 'UNPAID'].includes(submission.payStatus);
    const render = () => {
      btn('search').disabled = busy || !orderNo() || !value('date');
      btn('estimate').disabled = busy || !choice();
      btn('submit').disabled = busy || !currentEstimate() || !value('reason') ||
        submitted.has(currentEstimate()?.selection);
      btn('pay').disabled = busy || !payable();
      btn('detail').disabled = busy || !value('endorse');
      root.querySelectorAll('input, select').forEach((el) => { el.disabled = busy; });
    };
    async function call(service, path, body) {
      if (activeContext !== context()) throw new Error('环境或登录账号已变更，请重新查询');
      const result = await api(service, path, body === undefined ? { method: 'GET' } : { method: 'POST', body });
      if (activeContext !== context()) throw new Error('环境或登录账号已变更，请在原环境查单确认结果');
      if (!result?.ok) throw new Error(result?.error || `接口请求失败（HTTP ${result?.status ?? '-'}）`);
      const data = unwrap(result);
      if (!data || typeof data !== 'object' || Array.isArray(data) ||
        (service === 'go' && result.json?.data == null)) throw new Error('接口返回缺少业务数据');
      return data;
    }
    const java = (path, body) => call('java', path, body);
    const check = (path, body) => call('go', `/v1/co/check/travel/${path}`, body);
    const employee = () => {
      const user = window.TMC.session.userInfo;
      const employeeNo = text(user?.employee_no ?? user?.employeeNo);
      return amount(user?.employeeId) && user.employeeId > 0 ? { employeeId: user.employeeId } : employeeNo ? { employeeNo } : {};
    };
    const distinct = (items) => [...new Set(items.map(text).filter(Boolean))];
    const actions = {
      async search() {
        const key = queryKey();
        const order = orderNo();
        const departureDate = value('date');
        search = estimate = undefined;
        field('cabin').innerHTML = '<option value="">请先查询</option>';
        const detail = await java(childPath(order));
        if (detail.orderNo !== order) throw new Error('原订单号与详情不符');
        if (detail.travelPurpose === 'PRIVATE') throw new Error('当前工具只支持自愿因公改签');
        const orderTickets = distinct((detail.passengers || []).flatMap((p) => (p.tickets || []).map((t) => t.ticketNo)));
        const requested = distinct(value('tickets').split(/[,，\s]+/));
        const ticketNoList = requested.length ? requested : orderTickets;
        if (!ticketNoList.length || ticketNoList.some((ticket) => !orderTickets.includes(ticket))) {
          throw new Error('没有可用票号，或指定票号不属于该订单');
        }
        const eligibility = await java('/air/endorse/check', { orderNo: order, ticketNoList });
        if (eligibility.canEndorse !== true) throw new Error(eligibility.failReason || '该订单不可改签');
        const allowed = distinct((eligibility.ticketList || []).map((t) => t.ticketNo));
        if (ticketNoList.some((ticket) => !allowed.includes(ticket))) throw new Error('改签资格返回的票号不完整，请指定可改签票号后重试');
        const response = await java('/air/endorse/flights', { orderNo: order, ticketNoList, departureDate });
        const routes = response.routes || [];
        const choices = routes.flatMap((route) => (route.productInfos || []).flatMap((product) => {
          const flight = selectedFlight(route, product);
          const sessionId = text(product.sessionId);
          const stock = text(product.cabinInfo?.cabinNum);
          const preview = product.endorseEstimate;
          if (!flight.guid || !flight.detailKey || !sessionId || !flight.cabinCode || !flight.cabinLevel ||
            !amount(quote(product)) || (stock && Number(stock) <= 0) || preview?.calculable === false) return [];
          return [{ route, product, flight, sessionId }];
        }));
        search = { key, order, ticketNoList, choices, comparable: comparableFlights(routes), originalFlight: eligibility.originalSegment?.flightNo };
        field('cabin').innerHTML = '<option value="">请选择航班及舱位</option>' + choices.map(({ flight, product }, index) =>
          `<option value="${index}">${esc(`${flight.flightNo} · ${flight.departureAirport} → ${flight.arrivalAirport} · ${flight.takeoffTime} · ${flight.cabinLevel} ${flight.cabinCode} · 新票 ${money(quote(product))}`)}</option>`).join('');
        if (!value('apply')) field('apply').value = text(detail.application?.applyNo);
        return choices.length ? `找到 ${choices.length} 个可预估的舱位，请选择。` : '该日期没有可预估的改签舱位。';
      },
      async estimate() {
        estimate = undefined;
        const selected = choice();
        const { flight, sessionId } = selected;
        const { order, ticketNoList } = search;
        const base = { orderNo: order, ticketNoList, sessionId, selectedFlight: flight };
        const quoteResult = await java('/air/order/refund-change/estimate', { ...base, operationType: 'CHANGE' });
        const fees = [quoteResult.fareDifference, quoteResult.supplierFee, quoteResult.platformChangeServiceFee,
          quoteResult.enterprisePayableAmount ?? quoteResult.estimatedSettlementAmount];
        if (quoteResult.operationAllowed === false || quoteResult.calculable !== true ||
          !fees.every(Number.isSafeInteger) || !amount(quoteResult.targetAmount) || !amount(fees[2])) {
          throw new Error(quoteResult.unavailableReason || '改签预估不完整或不允许改签');
        }
        const summary = `票面差价 ${money(fees[0])} · 航司手续费 ${money(fees[1])} · 平台服务费 ${money(fees[2])} · 企业应付 ${money(fees[3])}`;
        estimate = { choice: selected, base, quoteResult, summary,
          selection: JSON.stringify([context(), order, [...ticketNoList].sort(), flight.guid, flight.detailKey, sessionId]) };
        return summary;
      },
      async submit() {
        const current = currentEstimate();
        const { choice: selected, base, quoteResult, summary, selection } = current;
        const detail = await java(childPath(base.orderNo));
        if (detail.orderNo !== base.orderNo || !amount(detail.successfulChangeRefundTimes)) throw new Error('原订单退改次数缺失或异常');
        const identity = employee();
        const operation = { businessType: 'FLIGHT', operationType: 'CHANGE', ...identity };
        const exemption = await check('apply/exemption/check', operation);
        const applyNo = exemption.passed === true ? '' : value('apply');
        if (exemption.passed !== true && !applyNo) throw new Error(exemption.message || '当前改签需要出差申请单');
        if (applyNo) {
          const application = await check('apply/operation/check', { ...operation, orderNo: base.orderNo, applyNo });
          if (application.passed !== true) throw new Error(application.message || '该申请单不能用于改签');
        }
        const overageReasonText = value('overage');
        const fulfillment = overageReasonText ? { overageReason: 'OTHER', overageReasonText } : {};
        const departureTimes = (selected.route.trip?.segments || []).map((segment) => beijingTime(segment.depDate).slice(0, 16)).filter(Boolean);
        const distance = selected.route.trip?.mileage;
        const policy = await check('policy/check', { businessType: 'FLIGHT', ...identity, ...fulfillment, flightFacts: {
          operation: 'CHANGE', successfulChangeRefundTimes: detail.successfulChangeRefundTimes,
          selectedFlightGuid: selected.flight.guid, selectedQuotePrice: quote(selected.product),
          amountExcludingServiceFee: quoteResult.targetAmount, serviceFee: quoteResult.platformChangeServiceFee,
          cabinLevels: text(selected.flight.cabinLevel).toUpperCase().split('/').filter(Boolean), comparableFlights: search.comparable,
          departureTimes, bookingTime: beijingTime(new Date().toISOString()), ...(Number.isFinite(distance) ? { totalDistanceKm: distance } : {}),
        } });
        const active = (policy.violations || []).filter((item) => text(item.action));
        const warnings = active.map((item) => item.message || item.action).join('；');
        if (policy.passed !== true && !active.length) throw new Error(policy.message || '改签差标校验未通过');
        if (active.length) {
          const required = policy.requiredActions || [];
          if ((required.includes('REASON_REQUIRED') || policy.result === 'OVERAGE_REASON_REQUIRED') && !overageReasonText) {
            throw new Error(`差标要求填写超标原因：${warnings}`);
          }
          if (policy.passed !== true || active.some((item) => ['BLOCK', 'APPROVAL_REQUIRED', 'PERSONAL_PAY'].includes(item.action)) ||
            required.some((action) => !['WARN', 'UNLIMITED'].includes(action) && !policy.satisfiedActions?.includes(action)) ||
            !['COMPLIANT', 'WHITELIST_BYPASS', 'OVERAGE_UNLIMITED', 'OVERAGE_REASON_REQUIRED', 'OVERAGE_WARN'].includes(policy.result)) {
            throw new Error(`改签差标未通过：${warnings || policy.result || '未知决策'}`);
          }
        }
        if (queryKey() !== search.key) throw new Error('原订单或查询条件已变更，请重新查询');
        const submitContext = context();
        if (!ask(`确认提交自愿因公改签？\n环境：${environment()}\n订单：${base.orderNo}\n票号：${base.ticketNoList.join('、')}\n${search.originalFlight || '原航班'} → ${selected.flight.flightNo} ${selected.flight.takeoffTime} ${selected.flight.cabinCode}舱\n原因：${value('reason')}${applyNo ? `\n申请单：${applyNo}` : ''}\n${summary}${warnings ? `\n差标提示：${warnings}` : ''}`)) return '已取消提交。';
        if (!requests.has(selection)) requests.set(selection, uid());
        const approvalApplicationId = text(policy.effectiveApprovalApplication?.approvalApplicationId);
        const estimateNo = text(quoteResult.estimateNo);
        const result = await java('/air/endorse/submit', { ...base, voluntary: true, privateTravel: false,
          endorseReason: value('reason'), clientRequestId: requests.get(selection), ...fulfillment,
          ...(estimateNo ? { estimateNo } : {}), ...(applyNo ? { applyNo } : {}),
          ...(approvalApplicationId ? { approvalApplicationId } : {}),
        });
        const endorseNo = text(result.endorseNo);
        if (!endorseNo) throw new Error('接口未返回改签子订单号；请先核对订单状态，重试会复用本次幂等键');
        submitted.add(selection);
        submission = { ...result, endorseNo, context: submitContext, payStatus: result.payStatus || 'PENDING' };
        field('endorse').value = endorseNo;
        return `已提交：${endorseNo} · 改签状态 ${result.endorseStatus || '待查询'} · 支付状态 ${submission.payStatus} · 确认金额 ${money(result.payAmount)}`;
      },
      async pay() {
        const { endorseNo, payAmount } = submission;
        const payment = payAmount > 0 ? `扣款 ${money(payAmount)}` : payAmount < 0 ? `退款 ${money(-payAmount)}` : '零元，仅推进改签';
        if (!ask(`确认企业支付？\n环境：${environment()}\n改签单：${endorseNo}\n${payment}`)) return '已取消支付。';
        const result = await java('/air/endorse/pay', { endorseNo, expectedAmount: payAmount });
        if (result.success !== true) throw new Error(result.failReason || '企业支付未完成，请先查询详情');
        submission.paid = true;
        return `企业支付已确认 · 改签状态 ${result.endorseStatus || '待查询'} · 支付状态 ${result.payStatus || '待查询'}`;
      },
      async detail() {
        const endorseNo = value('endorse');
        const result = await java(childPath(endorseNo));
        if (result.orderNo && result.orderNo !== endorseNo) throw new Error('返回的订单与改签子订单号不一致');
        return `改签子订单 ${result.orderNo || endorseNo} · 订单状态 ${result.statusName || result.orderStatus || result.status || '见响应'} · 支付状态 ${result.payStatus || '见响应'}；完整响应可在右侧检查器查看。`;
      },
    };
    Object.entries(actions).forEach(([name, action]) => btn(name).addEventListener('click', async () => {
      if (busy) return;
      render();
      if (btn(name).disabled) return;
      busy = true;
      activeContext = context();
      status.textContent = '处理中…';
      render();
      try { status.textContent = await action(); }
      catch (error) { status.textContent = error.message || '请求失败'; }
      finally { busy = false; render(); }
    }));
    root.addEventListener('input', render);
    root.addEventListener('change', render);
    const fallback = document.getElementById('f-orderNo');
    fallback?.addEventListener('input', render);
    fallback?.addEventListener('change', render);
    // 订票会直接赋值上方订单号，不一定会派发输入事件。
    root.addEventListener('focusin', render);
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
