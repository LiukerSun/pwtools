import { useLayoutEffect, useRef, useState } from 'react';
import { Alert, Button, Modal, NumberInput, SegmentedControl, Switch, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { ArrowRightLeft, Check, Undo2 } from 'lucide-react';
import type { OrderTransfer as Transfer, OrderTransferActionInput, OrderTransferInput, ServiceOrder, TransferEvent } from '../shared/contracts';
import { api, errorInfo } from './api';
import { orderLabels, quantityText } from './orderPresentation';
import { moneyText, rentalDate } from './rentalPresentation';
import { automaticTransferRatio, canCancelTransfer, currentTransfer, refundedTransferCash, transferPercent, transferPreview, transferStatus } from './transferPresentation';
import './transfer.css';

export type TransferDialogMode = 'create' | 'settle' | 'cancel' | 'refund' | 'waiver' | 'confirm_refund';
const titles: Record<TransferDialogMode, string> = { create: '转单', settle: '确认结账', cancel: '撤销转单', refund: '转单部分退款', waiver: '转单免单', confirm_refund: '确认退款' };
type PendingRequest = { kind: 'create'; input: OrderTransferInput } | { kind: 'action'; input: OrderTransferActionInput };

export default function OrderTransfer({ order, mode, onClose, onSaved, onError, onNavigationStateChange }: {
  order: ServiceOrder; mode: TransferDialogMode; onClose: () => void; onSaved: (order: ServiceOrder) => void;
  onError: (error: unknown) => boolean; onNavigationStateChange: (state: { dirty: boolean; busy: boolean }) => void;
}) {
  const transfer = currentTransfer(order);
  const automatic = automaticTransferRatio(order);
  const [progressMode, setProgressMode] = useState('auto');
  const [progress, setProgress] = useState<number | ''>(() => Math.round(automatic.numerator / automatic.denominator * 10_000) / 100);
  const [prepaid, setPrepaid] = useState(false);
  const [amount, setAmount] = useState<number | ''>(() => transfer ? transfer.amount_due_cents / 100 : '');
  const [finalIncome, setFinalIncome] = useState<number | ''>(mode === 'waiver' ? 0 : '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [requestId] = useState(() => crypto.randomUUID());
  const saving = useRef(false);
  const pending = useRef<PendingRequest | null>(null);
  const errorFocus = useRef<HTMLDivElement>(null);
  const locked = busy || uncertain;
  const progressBps = progressMode === 'auto' ? null : progress === '' ? null : Math.round(progress * 100);
  const preview = transferPreview(order, progressBps, prepaid);
  const retained = transfer?.final_income_cents ?? transfer?.agreed_income_cents ?? 0;
  const cents = amount === '' ? null : Math.round(amount * 100);
  const finalCents = finalIncome === '' ? null : Math.round(finalIncome * 100);
  const refundTotal = transfer ? refundedTransferCash(transfer) + transfer.pending_refund_cents : 0;
  const maximumCash = transfer ? transfer.prepaid ? transfer.original_income_cents - refundTotal : transfer.agreed_income_cents : 0;
  const minimumCash = transfer?.prepaid ? maximumCash - transfer.agreed_income_cents : 0;
  const actualIncome = cents === null || !transfer ? null : transfer.prepaid ? maximumCash - cents : cents;
  const submissionDisabled = mode === 'create' ? preview === null : transfer === null;
  useLayoutEffect(() => { onNavigationStateChange({ dirty, busy: locked }); }, [dirty, locked, onNavigationStateChange]);
  useLayoutEffect(() => () => onNavigationStateChange({ dirty: false, busy: false }), [onNavigationStateChange]);
  useLayoutEffect(() => { if (error) errorFocus.current?.focus(); }, [error]);
  const close = () => { if (locked) return; if (dirty) setDiscard(true); else onClose(); };
  const changed = () => { setDirty(true); setFieldError(''); };
  const invalid = (message: string) => { setFieldError(message); setError(message); };

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving.current) return;
    setError(''); setFieldError('');
    if (!pending.current) {
      if (mode === 'create') {
        if (!preview) { invalid('请先在订单配置中补齐总价、接单人数和本人到手比例。'); return; }
        if (progressMode === 'manual' && (progress === '' || progressBps === null || !Number.isSafeInteger(progressBps) || progressBps < 0 || progressBps > 10_000)) { invalid('协商进度须为 0% 至 100%。'); return; }
        pending.current = { kind: 'create', input: { id: requestId, prepaid, progress_bps: progressBps, note: note.trim(), expected_updated_at: order.updated_at } };
      } else {
        if (!transfer) { invalid('转单记录已变化，请关闭并刷新订单。'); return; }
        const input: OrderTransferActionInput = { id: requestId, transfer_id: transfer.id, action: mode === 'waiver' ? 'refund' : mode, note: note.trim(), expected_updated_at: order.updated_at };
        if (mode === 'settle') {
          if (cents === null || !Number.isSafeInteger(cents) || cents < minimumCash || cents > maximumCash) { invalid(`本次金额须在 ${moneyText(minimumCash)} 至 ${moneyText(maximumCash)} 之间。`); return; }
          input.amount_cents = cents;
        }
        if (mode === 'refund' || mode === 'waiver') {
          if (finalCents === null || !Number.isSafeInteger(finalCents) || finalCents < 0 || finalCents > retained || (mode === 'refund' && finalCents >= retained)) { invalid('最终保留收入须低于当前本人收入，且不能小于零。'); return; }
          input.final_income_cents = finalCents; input.mode = mode;
        }
        pending.current = { kind: 'action', input };
      }
    }
    saving.current = true; setBusy(true);
    try {
      const saved = pending.current.kind === 'create'
        ? await api.transferOrder(order.id, pending.current.input)
        : await api.transferOrderAction(order.id, pending.current.input);
      const message = mode === 'create' ? '已转单，金额待结账确认' : mode === 'settle' ? '已结账，实际收入已计入收益' : mode === 'cancel' ? '已撤销转单，订单恢复待打' : mode === 'confirm_refund' ? '已确认退款，支出已记录' : '退款方案已保存，实际退款后请确认';
      notifications.show({ message, color: 'teal' });
      onSaved(saved);
    } catch (failure) {
      const info = errorInfo(failure);
      const unknown = /TIMEOUT|NETWORK|UNKNOWN|INTERNAL|HTTP_5|INVALID_RESPONSE/.test(info.code);
      setUncertain(current => current || unknown);
      if (!unknown && !uncertain) pending.current = null;
      if (!onError(failure)) setError(info.message);
    } finally { saving.current = false; setBusy(false); }
  }

  const submitLabel = uncertain ? '重试核实本次操作' : mode === 'create' ? '确认转单' : mode === 'settle' ? transfer?.prepaid ? '确认付款并结账' : '确认收款并结账' : mode === 'cancel' ? '确认撤销转单' : mode === 'confirm_refund' ? '确认已退款' : '确认退款方案';
  return <><Modal opened centered size="lg" title={titles[mode]} onClose={close} withCloseButton={!locked} closeOnEscape={!locked} closeOnClickOutside={!locked} classNames={{ content: 'transfer-modal' }}>
    <form className="transfer-form" onSubmit={save}>
      <p className="transfer-context"><strong>{order.boss_name} / {order.title}</strong><span>{orderLabels[order.kind]}</span></p>
      {error && <div ref={errorFocus} tabIndex={-1}><Alert color="red" title="尚未完成">{error}</Alert></div>}
      {uncertain && <Alert color="orange">操作结果待核实。请使用下方按钮重试，确认结果后再离开；重试不会重复记账。</Alert>}
      {mode === 'create' ? <>
        {!preview && <Alert color="orange">请先在订单配置中补齐总价、接单人数和本人到手比例，再计算转单金额。</Alert>}
        <section className="transfer-progress-source" aria-label="实际订单进度">
          <span>当前实际进度</span><strong>{order.kind === 'single_round' ? '单局单默认按 0% 转单' : transferPercent(automatic.numerator, automatic.denominator)}</strong>
          <p>{order.kind === 'single_round' ? `最佳单场 ${quantityText(order.completed_quantity, order.kind)}；单场目标 ${quantityText(order.total_quantity, order.kind)}。可填写协商进度。` : `已完成 ${quantityText(order.completed_quantity, order.kind)} / 总约定 ${quantityText(order.total_quantity, order.kind)}`}</p>
          {order.kind === 'escort' && <small>总约定包含炸单追加和约定调整。金额按原始数量精确计算，进度最多计 100%。</small>}
        </section>
        <div className="transfer-progress-choice"><label>转单采用的进度</label><SegmentedControl aria-label="转单进度计算方式" value={progressMode} onChange={value => { setProgressMode(value); changed(); }} data={[{ value: 'auto', label: '按实际进度' }, { value: 'manual', label: '协商进度' }]} disabled={locked} fullWidth /></div>
        {progressMode === 'manual' && <NumberInput label="协商进度（%）" description="只用于本次转单金额，不修改原有对局和实际进度。" value={progress} onChange={value => { setProgress(value === '' ? '' : Number(value)); changed(); }} min={0} max={100} decimalScale={2} hideControls suffix=" %" disabled={locked} error={fieldError || undefined} required />}
        <Switch label="已预收本人整份款项" description={preview ? `勾选表示已收到本人整单应得的 ${moneyText(preview.original)}，转单时计算需付下家的剩余部分。` : '按本人均分并扣除抽成后的整份款项计算。'} checked={prepaid} onChange={event => { setPrepaid(event.currentTarget.checked); changed(); }} disabled={locked} />
        <section className="transfer-preview" aria-label="转单金额预览" aria-live="polite">
          <div><span>本人整单应得</span><strong>{preview ? moneyText(preview.original) : '待补录'}</strong></div>
          <div><span>本人本段应得 · {preview ? transferPercent(preview.numerator, preview.denominator) : '—'}</span><strong>{preview ? moneyText(preview.expected) : '—'}</strong></div>
          <div className="transfer-preview-total"><span>{prepaid ? '待付下家' : '待收下家'}</span><strong>{preview ? moneyText(preview.cash) : '—'}</strong></div>
          <p>整单应得 = 总价 ÷ 接单人数 × 本人到手比例；本段应得 = 整单应得 × 转单进度。</p>
        </section>
        <Alert color="blue">确认转单后退出待打列表，保留对局记录和本次约定。预计金额暂不计入收入，实际收到或付出后再确认结账。</Alert>
      </> : transfer ? <>
        <TransferSnapshot transfer={transfer} compact />
        {mode === 'settle' && <>
          <NumberInput label={transfer.prepaid ? '实际付给下家（元）' : '实际收到金额（元）'} description={`允许 ${moneyText(minimumCash)} 至 ${moneyText(maximumCash)}；按双方最终结账金额填写。`} value={amount} onChange={value => { setAmount(value === '' ? '' : Number(value)); changed(); }} min={minimumCash / 100} max={maximumCash / 100} decimalScale={2} hideControls required disabled={locked} error={fieldError || undefined} />
          <section className="transfer-preview" aria-label="实际结账预览" aria-live="polite"><div className="transfer-preview-total"><span>结账后本人实际收益</span><strong>{actualIncome === null ? '—' : moneyText(actualIncome)}</strong></div><p>{transfer.prepaid ? '已预收本人整份款项 − 实际付给下家金额 − 已退和待退款项' : '本次实际收到的款项'}，租号费用另计。</p></section>
          <Alert color="blue">实际款项已收付后再确认。确认后记录现金流水，并将本人实际收益计入租号分析。</Alert>
        </>}
        {(mode === 'refund' || mode === 'waiver') && <>
          <div className="transfer-current-income"><span>{transfer.final_income_cents === null ? '当前本人可结收入' : '当前本人保留收入'}</span><strong>{moneyText(retained)}</strong></div>
          <NumberInput label="最终保留本人收入（元）" description="仅填写本人最终保留的金额；下一组自行退还其持有部分。" value={finalIncome} onChange={value => { setFinalIncome(value === '' ? '' : Number(value)); changed(); }} min={0} max={retained / 100} decimalScale={2} hideControls required disabled={locked || mode === 'waiver'} error={fieldError || undefined} />
          <RefundPreview transfer={transfer} finalCents={finalCents} waiver={mode === 'waiver'} />
          <Alert color="blue">这里只保存退款方案。需要退回的现金，在实际退还后点击“确认退款”入账。</Alert>
        </>}
        {mode === 'confirm_refund' && <>
          <section className="transfer-preview" aria-label="待退款金额"><div className="transfer-preview-total"><span>本次确认退款</span><strong>{moneyText(transfer.pending_refund_cents)}</strong></div></section>
          <p>确认已实际退还以上款项后，记录退款支出并清空待退款金额。</p>
        </>}
        {mode === 'cancel' && <Alert color="orange">撤销本次转单后，订单恢复原有进度和待打状态，转单计算保留为历史。仅尚未发生转单收付款时可以撤销。</Alert>}
      </> : <Alert color="orange">转单记录已变化，请关闭并刷新订单。</Alert>}
      <Textarea label={mode === 'create' ? '转单说明' : '操作说明'} placeholder={mode === 'create' ? '例如下一组打手、双方协商事项' : '可记录结账或退款约定'} value={note} onChange={event => { setNote(event.currentTarget.value); changed(); }} disabled={locked} maxLength={1000} minRows={2} />
      <div className="transfer-form-actions"><Button variant="default" disabled={locked} onClick={close}>取消</Button><Button type="submit" loading={busy} disabled={submissionDisabled} leftSection={mode === 'create' ? <ArrowRightLeft size={15} aria-hidden="true" /> : mode === 'cancel' ? <Undo2 size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}>{submitLabel}</Button></div>
    </form>
  </Modal><Modal opened={discard} onClose={() => setDiscard(false)} title="尚有未保存转单信息" centered size="sm"><p>放弃本次填写的转单或结账信息？</p><div className="transfer-form-actions"><Button variant="default" onClick={() => setDiscard(false)}>继续填写</Button><Button color="orange" onClick={onClose}>放弃修改</Button></div></Modal></>;
}

function RefundPreview({ transfer, finalCents, waiver }: { transfer: Transfer; finalCents: number | null; waiver: boolean }) {
  const current = transfer.final_income_cents ?? transfer.agreed_income_cents;
  if (finalCents === null || finalCents < 0 || finalCents > current) return null;
  const unsettled = transfer.final_income_cents === null;
  const due = unsettled && !waiver ? transfer.prepaid ? transfer.amount_due_cents : finalCents : 0;
  const refund = unsettled && transfer.prepaid && waiver ? transfer.original_income_cents - refundedTransferCash(transfer)
    : unsettled && !transfer.prepaid ? 0 : transfer.pending_refund_cents + current - finalCents;
  return <section className="transfer-preview" aria-label="退款方案预览" aria-live="polite">
    <div><span>{unsettled ? '调整后本人可结收入' : '调整后本人实际收益'}</span><strong>{moneyText(finalCents)}</strong></div>
    {unsettled && !waiver && <div><span>{transfer.prepaid ? '调整后待付下家' : '调整后待收下家'}</span><strong>{moneyText(due)}</strong></div>}
    <div className="transfer-preview-total"><span>待退回本人持有款项</span><strong>{moneyText(refund)}</strong></div>
    {unsettled && waiver && transfer.prepaid && <p>本人已预收整份款项且尚未付给下家，取消下家应付，并退回本人持有的整份款项。</p>}
  </section>;
}

export function TransferActions({ order, disabled, onOpen }: { order: ServiceOrder; disabled: boolean; onOpen: (mode: TransferDialogMode) => void }) {
  const transfer = currentTransfer(order);
  if (!transfer) return null;
  const retained = transfer.final_income_cents ?? transfer.agreed_income_cents;
  return <>
    {transfer.status === 'pending' && <Button variant="light" size="xs" disabled={disabled} onClick={() => onOpen('settle')}>确认结账</Button>}
    {transfer.pending_refund_cents > 0 && <Button variant="light" color="orange" size="xs" disabled={disabled} onClick={() => onOpen('confirm_refund')}>确认退款</Button>}
    {retained > 0 && <Button variant="subtle" color="orange" size="xs" disabled={disabled} onClick={() => onOpen('refund')}>部分退款</Button>}
    {transfer.status !== 'waived' && <Button variant="subtle" color="gray" size="xs" disabled={disabled} onClick={() => onOpen('waiver')}>免单</Button>}
    {canCancelTransfer(transfer) && <Button variant="subtle" color="gray" size="xs" disabled={disabled} onClick={() => onOpen('cancel')}>撤销转单</Button>}
  </>;
}

export function TransferSummary({ order }: { order: ServiceOrder }) {
  const transfer = currentTransfer(order);
  if (!transfer) return null;
  return <div className="transfer-order-summary" aria-label="转单收付状态">
    <strong className={`transfer-state ${transfer.status}`}>{transferStatus(transfer)}</strong>
    {transfer.status === 'pending' && <span>{transfer.prepaid ? '待付' : '待收'} <b>{moneyText(transfer.amount_due_cents)}</b></span>}
    {transfer.pending_refund_cents > 0 && <span>待退 <b>{moneyText(transfer.pending_refund_cents)}</b></span>}
    <span>{transfer.final_income_cents === null ? '实际收益待结账' : <>本人实际收益 <b>{moneyText(transfer.final_income_cents)}</b></>}</span>
  </div>;
}

function TransferSnapshot({ transfer, compact = false }: { transfer: Transfer; compact?: boolean }) {
  const snapshot = transfer.original_order;
  return <section className="transfer-snapshot" aria-label="转单时约定">
    <div className="transfer-section-heading"><strong>转单时约定</strong><span>{rentalDate(transfer.created_at)}</span></div>
    <dl className="transfer-facts">
      <div><dt>本人整单应得</dt><dd>{moneyText(transfer.original_income_cents)}</dd></div>
      <div><dt>{transfer.progress_bps === null ? '采用自动进度' : '采用协商进度'}</dt><dd>{transferPercent(transfer.progress_numerator, transfer.progress_denominator)}</dd></div>
      <div><dt>本人本段应得</dt><dd>{moneyText(transfer.expected_income_cents)}</dd></div>
      <div><dt>{transfer.prepaid ? '原预计付给下家' : '原预计收到款项'}</dt><dd>{moneyText(transfer.expected_cash_cents)}</dd></div>
    </dl>
    <p className="transfer-small">{transfer.prepaid ? `转单前已预收本人整份款项 ${moneyText(transfer.original_income_cents)}` : '转单前未预收本人整份款项'}</p>
    {!compact && <>
      <p className="transfer-small">总价 {snapshot.price_cents == null ? '—' : moneyText(snapshot.price_cents)} · {snapshot.participant_count ?? '—'} 人均分 · 本人到手 {snapshot.commission_bps == null ? '—' : `${(10_000 - snapshot.commission_bps) / 100}%`}</p>
      <p className="transfer-small">实际完成 {quantityText(snapshot.completed_quantity, snapshot.kind)} · 总约定 {quantityText(snapshot.total_quantity, snapshot.kind)}{snapshot.failure_quantity > 0 ? `（含追加 ${quantityText(snapshot.failure_quantity, snapshot.kind)}）` : ''}</p>
      {transfer.note && <p className="transfer-note">{transfer.note}</p>}
    </>}
  </section>;
}

function eventLabel(event: TransferEvent): string {
  if (event.action === 'settle') return '确认结账';
  if (event.action === 'cancel') return '撤销转单';
  if (event.action === 'confirm_refund') return '确认已退款';
  return event.mode === 'waiver' ? '免单方案' : '部分退款方案';
}

export function TransferHistory({ order }: { order: ServiceOrder }) {
  const history = order.transfer_history ?? [];
  if (history.length === 0) return null;
  return <section className="transfer-history" aria-label="转单记录"><div className="transfer-section-heading"><strong>转单记录</strong><span>{history.length} 次转单</span></div>
    {[...history].reverse().map((transfer, index) => <details className="transfer-history-item" key={transfer.id} open={index === 0}>
      <summary><span>第 {history.length - index} 次转单 · {transferStatus(transfer)}</span><span>{moneyText(transfer.expected_income_cents)} 本段应得</span></summary>
      <TransferSnapshot transfer={transfer} />
      <div className="transfer-income-result"><span>本人实际收益</span><strong>{transfer.cancelled_at ? '转单已撤销' : transfer.final_income_cents === null ? '待结账，暂不计入' : moneyText(transfer.final_income_cents)}</strong></div>
      <section className="transfer-cash-history" aria-label="实际收付流水"><h4>实际收付流水</h4>{transfer.cash_events.length === 0 ? <p className="transfer-small">尚无转单收付记录。</p> : <ul>{transfer.cash_events.map(cash => <li key={cash.id}><div><strong>{cash.kind === 'refund' ? '实际退款' : cash.direction === 'receipt' ? '收到下家款项' : '付给下家款项'}</strong><b>{cash.direction === 'receipt' ? '+' : '−'}{moneyText(cash.amount_cents)}</b></div><time dateTime={cash.created_at}>{rentalDate(cash.created_at)}</time>{cash.note && <p>{cash.note}</p>}</li>)}</ul>}</section>
      {transfer.events.length > 0 && <details className="transfer-audit"><summary>查看结账与退款操作记录</summary><ul>{transfer.events.map(event => <li key={event.id}><strong>{eventLabel(event)}</strong><time dateTime={event.created_at}>{rentalDate(event.created_at)}</time>{event.final_income_cents !== null && <span>最终保留本人收入 {moneyText(event.final_income_cents)}</span>}{event.amount_cents !== null && <span>本次结账金额 {moneyText(event.amount_cents)}</span>}{event.note && <p>{event.note}</p>}</li>)}</ul></details>}
    </details>)}
  </section>;
}
