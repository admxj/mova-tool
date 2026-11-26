/* 机票退票：查单、费用预估及申请。 */
(function () {
  'use strict';

  function init() {
    const panel = document.getElementById('air-refund-panel');
    if (!panel || panel.dataset.ready) return;
    panel.dataset.ready = 'true';
    const { api, unwrap, okResponse, money, settings, session } = window.TMC;
    const previousOrder = document.getElementById('f-orderNo');
    panel.innerHTML = `
      <div class="grid">
        <label>订单号 <input data-refund="order" placeholder="留空使用上方订单号" /></label>
        <label>票号（逗号或空格分隔） <input data-refund="tickets" placeholder="留空则从订单详情取票号" /></label>
        <label>退票类型 <select data-refund="type"><option value="1">自愿退票</option><option value="0">非自愿退票（航班延误 / 取消）</option></select></label>
        <label>退票原因 <input data-refund="reason" placeholder="必填" /></label>
        <label>出差申请单号 <input data-refund="apply" placeholder="如要求关联请填写，最终由服务端校验" /></label>
      </div>
      <div class="actions">
        <button type="button" class="ghost" data-refund="query">查询订单及退票状态</button>
        <button type="button" class="ghost" data-refund="estimate">预估退票费用</button>
        <button type="button" class="primary" data-refund="submit" disabled>提交退票申请</button>
      </div>
      <p class="muted-text">提交仅发起退票申请，不代表退款成功；实际金额和进度以订单查询结果为准。</p>
      <div class="results" data-refund="result" role="status" aria-live="polite"></div>`;
    const get = (key) => panel.querySelector(`[data-refund="${key}"]`);
    const value = (key) => get(key).value.trim();
    const orderNo = () => value('order') || previousOrder?.value.trim() || '';
    const scope = () => JSON.stringify([settings.javaBase, settings.javaPrefix, settings.tenantCode, session.token, orderNo()]);
    const estimateKey = () => JSON.stringify([scope(), value('tickets'), value('type')]);
    const show = (text) => { get('result').textContent = text; };
    let busy = false;
    let estimate;

    const ticketsOf = (detail) => (detail.passengers || []).flatMap((passenger) => passenger.tickets || []);
    const ticketNumber = (ticket) => String(ticket.ticketNo ?? '').trim();
    const statusLine = (detail) => [
      `订单 ${detail.orderNo || orderNo()}`,
      `订单状态：${detail.orderStatus || detail.displayStatusDesc || detail.displayStatus || '未返回'}`,
      ...ticketsOf(detail).filter(ticketNumber).map((ticket) =>
        `客票 ${ticketNumber(ticket)}：${ticket.ticketStatusDesc || ticket.ticketStatus || '未返回'}${ticket.refundAmount == null ? '' : `，退款金额 ${money(ticket.refundAmount)}`}`),
    ].join(' · ');

    function sync() {
      get('query').disabled = busy;
      get('estimate').disabled = busy;
      get('submit').disabled = busy || estimate?.key !== estimateKey();
    }

    async function request(path, body) {
      const response = await api('java', path, body === undefined ? { method: 'GET' } : { method: 'POST', body });
      if (!okResponse(response)) {
        // 优先展示业务响应错误，但绝不把失败 HTTP 响应当作成功。
        unwrap(response);
        throw new Error(response.error || `HTTP ${response.status}`);
      }
      return unwrap(response);
    }

    const detailFor = (id) => request(`/air/order/${encodeURIComponent(id)}`);
    const bind = (key, handler) => get(key).addEventListener('click', async () => {
      if (busy) return;
      const id = orderNo();
      if (!id) return show('请填写机票订单号。');
      busy = true;
      sync();
      try { await handler(id); }
      catch (error) {
        const note = key === 'submit' ? '；若请求结果不明确，请先查单，不要重复提交。' : '';
        show(`${error.message || '操作失败'}${note}`);
      } finally {
        busy = false;
        sync();
      }
    });

    bind('query', async (id) => {
      const key = scope();
      const detail = await detailFor(id);
      if (key !== scope()) return;
      show(`${statusLine(detail)}。完整响应见接口检查器。`);
    });

    bind('estimate', async (id) => {
      estimate = undefined;
      const key = estimateKey();
      const explicit = value('tickets').split(/[\s,，]+/).filter(Boolean);
      const ticketNoList = [...new Set(explicit.length ? explicit : ticketsOf(await detailFor(id)).map(ticketNumber).filter(Boolean))];
      if (key !== estimateKey()) return;
      if (!ticketNoList.length) return show('未查到票号，请核对订单或手动填写有效票号。');
      const data = await request('/air/order/refund-change/estimate', { orderNo: id, operationType: 'REFUND', ticketNoList });
      if (key !== estimateKey()) return;
      if (data?.operationAllowed !== true) {
        return show(data?.unavailableReason || '未确认当前客票允许退票；请核对订单和票号后重试。');
      }
      const hasAmount = data.calculable === true && Number.isSafeInteger(data.estimatedRefundAmount);
      estimate = { key, ticketNoList, data, hasAmount };
      if (!hasAmount) {
        const reason = data.unavailableReason ? `（${data.unavailableReason}）` : '';
        return show(`允许申请退票，但暂无法预估退款金额${reason}。可确认后提交，实际金额以审核结果为准。`);
      }
      show(`已预估 ${ticketNoList.length} 张票：供应商退票费 ${money(data.supplierFee)}，预计退款 ${money(data.estimatedRefundAmount)}。${data.disclaimer || '实际退款以审核结果为准。'}`);
    });

    bind('submit', async (id) => {
      if (estimate?.key !== estimateKey()) return show('请先对当前订单和票号进行费用预估。');
      const reason = value('reason');
      if (!reason) return show('请填写退票原因。');
      const type = value('type');
      const applyNo = value('apply');
      const { ticketNoList, data, hasAmount } = estimate;
      const refundSummary = hasAmount
        ? `预计退款：${money(data.estimatedRefundAmount)}（以审核结果为准）`
        : '退款金额暂无法预估，实际退款及手续费以审核结果为准。';
      const body = {
        orderNo: id, ticketNoList, isVoluntaryRefund: type,
        refundReasonCode: type === '1' ? 'VOLUNTARY' : 'IRREGULAR_FLIGHT',
        refundReasonDesc: reason, ...(applyNo ? { applyNo } : {}),
      };
      if (!window.confirm(`提交${type === '1' ? '自愿' : '非自愿'}退票申请？\n环境：${settings.javaBase}\n订单：${id}\n票号：${ticketNoList.join('、')}\n原因：${reason}\n申请单：${applyNo || '未填写'}\n${refundSummary}`)) return;
      estimate = undefined;
      const result = await request('/air/order/refund', body);
      show(`退票申请已提交（${result?.orderNo || id}）${result?.orderStatus ? ` · 状态：${result.orderStatus}` : ''}。请通过查单确认进度。`);
    });

    const clear = () => {
      estimate = undefined;
      show('');
      sync();
    };
    ['order', 'tickets', 'type'].forEach((key) => get(key).addEventListener('input', clear));
    previousOrder?.addEventListener('input', () => { if (!value('order')) clear(); });
    sync();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
