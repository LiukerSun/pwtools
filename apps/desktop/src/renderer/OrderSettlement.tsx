import { useLayoutEffect, useRef, useState } from 'react';
import { Alert, Button, Modal, NumberInput, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { OrderArchiveInput, OrderSettlement as Settlement, ServiceOrder } from '../shared/contracts';
import { api, errorInfo } from './api';
import { moneyText, orderNetCents, rentalDate } from './rentalPresentation';
import './settlement.css';

export const settlementLabels = { waiver: '免单', refund: '部分退款', completed: '正常结单' };
export function originalPersonalIncome(order: ServiceOrder): number | null {
  return order.price_cents == null || order.participant_count == null || order.commission_bps == null ? null
    : orderNetCents(order.price_cents, order.participant_count, order.commission_bps);
}

export default function OrderSettlement({ order, mode, onClose, onSaved, onError, onNavigationStateChange }: {
  order: ServiceOrder; mode: Settlement['mode'] | 'restore'; onClose: () => void; onSaved: () => void;
  onError: (error: unknown) => boolean; onNavigationStateChange: (state: { dirty: boolean; busy: boolean }) => void;
}) {
  const original = originalPersonalIncome(order);
  const [income, setIncome] = useState<number | ''>(mode === 'waiver' ? 0 : mode === 'refund' ? '' : (original ?? 0) / 100);
  const [percent, setPercent] = useState<number | ''>(mode === 'waiver' ? 100 : mode === 'refund' ? '' : 0);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [discard, setDiscard] = useState(false);
  const saving = useRef(false);
  const id = useRef(crypto.randomUUID());
  const pending = useRef<OrderArchiveInput | null>(null);
  const locked = busy || uncertain;
  useLayoutEffect(() => { onNavigationStateChange({ dirty, busy: locked }); }, [dirty, locked, onNavigationStateChange]);
  useLayoutEffect(() => () => onNavigationStateChange({ dirty: false, busy: false }), [onNavigationStateChange]);
  const close = () => { if (!locked) { if (dirty) setDiscard(true); else onClose(); } };
  const changePercent = (value: string | number) => {
    const next = value === '' ? '' : Number(value); setPercent(next); setDirty(true);
    setIncome(next === '' || original === null ? '' : Math.round(original * (100 - next) / 100) / 100);
  };
  const changeIncome = (value: string | number) => {
    const next = value === '' ? '' : Number(value); setIncome(next); setDirty(true);
    setPercent(next === '' || !original ? '' : Math.round((1 - Math.round(next * 100) / original) * 10_000) / 100);
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (saving.current) return;
    const cents = income === '' ? null : Math.round(income * 100);
    if (mode !== 'restore' && (!uncertain && (original === null || cents === null || !Number.isSafeInteger(cents) || cents < 0 || cents > original || (mode === 'refund' && cents >= original)))) {
      setError(original === null ? '请先在订单配置中补齐总价、人数和抽成。' : '请填写有效的最终本人收入；部分退款后的收入应低于原应得收入。'); return;
    }
    saving.current = true; setBusy(true); setError('');
    try {
      if (mode === 'restore') {
        const last = order.settlement_history?.at(-1);
        if (!last) throw new Error('结算历史未加载，请刷新订单。');
        await api.restoreOrder(order.id, last.id);
      } else {
        pending.current ??= { id: id.current, mode, final_income_cents: cents!, note: note.trim(), expected_updated_at: order.updated_at };
        await api.archiveOrder(order.id, pending.current);
      }
      notifications.show({ message: mode === 'restore' ? '已恢复，收入待重新结算' : '已结算归档，对局和收入已计入租号分析', color: 'teal' });
      onSaved();
    } catch (failure) {
      const info = errorInfo(failure);
      const unknown = /TIMEOUT|NETWORK|UNKNOWN|INTERNAL|HTTP_5|INVALID_RESPONSE/.test(info.code);
      setUncertain(current => current || unknown);
      if (!unknown && !uncertain) pending.current = null;
      if (!onError(failure)) setError(info.message);
    } finally { saving.current = false; setBusy(false); }
  };
  return <><Modal opened centered size="md" title={mode === 'restore' ? '恢复订单' : `${settlementLabels[mode]}并归档`} onClose={close} withCloseButton={!locked} closeOnEscape={!locked} closeOnClickOutside={!locked}>
    <form className="settlement-form" onSubmit={save}>
      <p><strong>{order.boss_name} / {order.title}</strong></p>
      {error && <Alert color="red">{error}</Alert>}
      {uncertain && <Alert color="orange">结算结果待核实，请重试确认后再离开。</Alert>}
      {mode === 'restore' ? <p>恢复后可继续记录和校对对局。收入重新显示“待结算”，之前的结算保留为历史；再次归档时需重新确认最终收入。</p> : <>
        <div className="settlement-original"><span>原应得本人收入</span><strong>{original === null ? '待补录' : moneyText(original)}</strong><small>订单总价 ÷ 接单人数 × 本人到手比例</small></div>
        {mode === 'refund' && <NumberInput label="退款比例" description="按原应得本人收入计算，与最终本人收入联动。" suffix=" %" min={0} max={100} decimalScale={2} hideControls value={percent} onChange={changePercent} disabled={locked || original === null} />}
        <NumberInput label="最终本人收入（元）" description="这是本人最终到手金额，不再均分或扣抽成，也暂不扣租号费用。" min={0} max={(original ?? 0) / 100} decimalScale={2} hideControls value={income} onChange={changeIncome} disabled={locked || mode !== 'refund' || original === null} />
        <Textarea label="结算说明" placeholder="例如退款原因、提前结束原因" value={note} onChange={event => { setNote(event.currentTarget.value); setDirty(true); }} disabled={locked} maxLength={1000} minRows={2} />
        <Alert color="blue">确认已与老板谈妥后归档。实际对局继续计入账号使用和租号分析，未完成部分不再计入待办。归档后需先恢复订单才能修改。</Alert>
      </>}
      <div className="settlement-actions"><Button variant="default" disabled={locked} onClick={close}>取消</Button><Button type="submit" loading={busy} disabled={mode !== 'restore' && original === null}>{uncertain ? '重试核实结算' : mode === 'restore' ? '确认恢复' : '确认结算并归档'}</Button></div>
    </form>
  </Modal><Modal opened={discard} onClose={() => setDiscard(false)} title="尚有未保存结算" centered size="sm"><p>放弃本次填写的结算信息？</p><div className="settlement-actions"><Button variant="default" onClick={() => setDiscard(false)}>继续填写</Button><Button color="orange" onClick={onClose}>放弃修改</Button></div></Modal></>;
}

export function SettlementHistory({ order }: { order: ServiceOrder }) {
  const history = order.settlement_history ?? [];
  const last = history.at(-1);
  if (!history.length) return null;
  return <section className="settlement-history" aria-label="结算历史"><div className="settlement-history-heading"><strong>{order.status === 'archived' ? `最终本人收入 ${moneyText(last!.final_income_cents)}` : '本人收入：待结算'}</strong><span>{history.length} 次结算</span></div>
    <details><summary>查看结算历史</summary>{[...history].reverse().map(item => <div className="settlement-history-item" key={item.id}><strong>{settlementLabels[item.mode]} · {moneyText(item.final_income_cents)}</strong><span>{rentalDate(item.archived_at)}{item.restored_at ? ` · ${rentalDate(item.restored_at)} 已恢复` : ' · 当前结算'}</span><span>原应得 {moneyText(item.original_income_cents)} · 少赚 {moneyText(item.original_income_cents - item.final_income_cents)}</span>{item.note && <p>{item.note}</p>}</div>)}</details>
  </section>;
}
