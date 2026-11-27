/* 火车订票业务步骤；请求与当前登录上下文由调用方注入。 */
(function () {
  'use strict';
  const checkRoot = '/v1/co/check/travel';
  const pendingPolicy = new Set(['OVERAGE_WARN', 'OVERAGE_REASON_REQUIRED']);
  const blockedPolicy = new Set(['OVERAGE_BLOCK', 'NO_POLICY', 'OVERAGE_SELFPAY', 'OVERAGE_APPROVAL']);

  function createBooking({ request, key, context = () => '' }) {
    let attempt;
    let generation = 0;
    const reset = () => { generation++; attempt = undefined; };
    function guard(current) {
      if (current.generation !== generation || current.context !== context()) {
        throw Error('预订上下文已变更，请重新操作');
      }
    }
    async function call(current, service, path, body) {
      guard(current);
      const result = await request(service, path, body === undefined ? { method: 'GET' } : { body });
      guard(current);
      return result;
    }
    function applyPolicy(current, policy, confirmed = false) {
      current.policy = policy;
      if (!confirmed && pendingPolicy.has(policy?.result)) return { kind: 'confirm', quote: current.quote, policy };
      if (!policy?.passed || !policy.result || blockedPolicy.has(policy.result) || policy.result === 'OVERAGE_REASON_REQUIRED') {
        throw Error('差标校验未通过');
      }
      current.ready = true;
      return { kind: 'ready', quote: current.quote, policy };
    }
    async function prepare(draft) {
      reset();
      const current = { generation, context: context(), draft: structuredClone(draft), idempotentKey: key() };
      attempt = current;
      const { quote, departTime, accountId, passengerIds, contactName, contactPhone, applyNo, employee = {} } = current.draft;
      if (!Number.isSafeInteger(accountId) || accountId <= 0) throw Error('请先绑定有效的 12306 账号');
      if (!passengerIds?.length || passengerIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw Error('请选择乘车人');
      if (!contactName?.trim() || !/^1\d{10}$/.test(contactPhone?.trim())) throw Error('请填写联系人及有效手机号');
      current.quote = await call(current, 'java', '/train/orders/price', { ...quote, passengerCount: passengerIds.length });
      if (!current.quote?.quoteToken?.trim()) throw Error(current.quote?.verifyMessage || '验价未返回有效凭证');
      const exemption = await call(current, 'go', `${checkRoot}/apply/exemption/check`, { businessType: 'TRAIN', operationType: 'BOOK', ...employee });
      if (exemption?.passed !== true) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(quote.trainDate) || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(departTime)) throw Error('发车时间无效');
        const application = await call(current, 'go', `${checkRoot}/apply/check`, {
          businessType: 'TRAIN', ...employee, ...(applyNo ? { applyNo } : {}),
          itinerary: { segments: [{ departureCityCode: quote.fromCityCode, departureCityName: quote.fromCityName,
            departureTime: `${quote.trainDate} ${departTime.length === 5 ? `${departTime}:00` : departTime}`,
            arrivalCityCode: quote.toCityCode, arrivalCityName: quote.toCityName }] },
        });
        if (application?.passed !== true || (application.required !== false && !applyNo)) throw Error(application?.message || '申请单校验未通过或未选择申请单');
      }
      const code = quote.trainCode.trim().toUpperCase();
      const trainType = /^[GDC]/.test(code) ? 'HIGH_SPEED' : /^[A-Z]/.test(code) ? 'REGULAR' : /[GDC]\d/.test(code) ? 'HIGH_SPEED' : undefined;
      current.policyRequest = { businessType: 'TRAIN', ...employee, trainFacts: { operation: 'BOOK', selectedSeat: quote.seatType, ...(trainType ? { trainType } : {}) } };
      return applyPolicy(current, await call(current, 'go', `${checkRoot}/policy/check`, current.policyRequest));
    }
    async function confirmPolicy({ reason = '', personalPayConfirmed } = {}) {
      const current = attempt;
      if (!current || current.ready || !pendingPolicy.has(current.policy?.result)) throw Error('没有待确认的差标结果');
      guard(current);
      const text = reason.trim().slice(0, 500);
      if (current.policy.result === 'OVERAGE_REASON_REQUIRED' && !text) throw Error('请填写超标原因');
      const patch = { ...(text ? { overageReason: 'OTHER', overageReasonText: text } : {}), ...(personalPayConfirmed === undefined ? {} : { personalPayConfirmed }) };
      const policy = current.policy.result === 'OVERAGE_WARN' && current.policy.passed === true
        ? current.policy : await call(current, 'go', `${checkRoot}/policy/check`, { ...current.policyRequest, ...patch });
      current.overage = patch;
      return applyPolicy(current, policy, policy.passed === true);
    }
    async function submit() {
      const current = attempt;
      if (!current?.ready) throw Error('请先完成验价与业务校验');
      guard(current);
      if (current.order) return current.order;
      if (current.submitting) throw Error('占座请求正在提交');
      const expiry = Date.parse(current.quote.expiresAt);
      if (Number.isFinite(expiry) && expiry <= Date.now()) throw Error('报价已过期，请重新验价');
      const { accountId, passengerIds, contactName, contactPhone, applyNo, chooseSeats, acceptStanding, notifyPassengerBySms, notifyBookerBySms } = current.draft;
      const approvalApplicationId = current.policy?.effectiveApprovalApplication?.approvalApplicationId?.trim();
      current.submitting = true;
      try {
        const order = await call(current, 'java', '/train/orders', {
          quoteToken: current.quote.quoteToken.trim(), idempotentKey: current.idempotentKey,
          accountId, passengerIds, contactName: contactName.trim(), contactPhone: contactPhone.trim(),
          notifyPassengerBySms: Boolean(notifyPassengerBySms), notifyBookerBySms: Boolean(notifyBookerBySms),
          ...(chooseSeats ? { chooseSeats } : {}), acceptStanding: Boolean(acceptStanding),
          ...(applyNo ? { applyNo } : {}), ...(approvalApplicationId ? { approvalApplicationId } : {}), ...current.overage,
        });
        if (!order?.orderNo) throw Error('占座响应未返回订单号，请检查响应后重试');
        current.order = order;
        return order;
      } finally { current.submitting = false; }
    }
    function status(orderNo) {
      const value = orderNo?.trim();
      if (!value || value === '.' || value === '..') throw Error('请输入订单号');
      return call({ generation, context: context() }, 'java', `/train/orders/${encodeURIComponent(value)}`);
    }
    return { prepare, confirmPolicy, submit, status, reset };
  }
  if (typeof module === 'object' && module.exports) module.exports = { createBooking };
  else window.TrainBooking = { createBooking };
})();
