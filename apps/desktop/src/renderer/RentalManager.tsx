import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Loader, Modal, NumberInput, Select, Textarea, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { ArrowDownLeft, ArrowUpRight, Check, KeyRound, Plus, RefreshCw } from 'lucide-react';
import type { RentalAccount, RentalAnalysis, RentalOrderAnalysis, RentalSession, RentalSessionInput } from '../shared/contracts';
import { api, errorInfo } from './api';
import DateTimeField from './DateTimeField';
import { MAX_CENTS, RENTAL_QUOTE_SCALE, coinText, moneyText, rentalDate, rentalLocalTime, rentalQuoteText } from './rentalPresentation';
import { MAX_QUANTITY } from './orderPresentation';
import './rentals.css';
import { settlementLabels } from './OrderSettlement';

function rentalOrderStatus(order: RentalOrderAnalysis): string {
  if (order.settlement_mode === 'transfer') return order.income_status === 'settled' ? '已转单 · 已结账' : '已转单 · 待结账';
  if (order.order_status === 'archived') return order.settlement_mode ? `${settlementLabels[order.settlement_mode]} · 已归档` : '已归档';
  return order.order_status === 'completed' ? '已结单' : '待结算';
}

type NavigationState = { dirty: boolean; busy: boolean };
type Props = { onError: (error: unknown) => boolean; onNavigationStateChange: (state: NavigationState) => void };
const cleanState: NavigationState = { dirty: false, busy: false };

export default function RentalManager({ onError, onNavigationStateChange }: Props) {
  const [accounts, setAccounts] = useState<RentalAccount[]>([]);
  const [sessions, setSessions] = useState<RentalSession[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<RentalAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [reportLoading, setReportLoading] = useState(false);
  const [error, setError] = useState('');
  const [reportError, setReportError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [creating, setCreating] = useState(false);
  const [returning, setReturning] = useState<RentalSession | null>(null);
  const [filter, setFilter] = useState('all');
  useLayoutEffect(() => () => onNavigationStateChange(cleanState), [onNavigationStateChange]);
  useEffect(() => {
    let alive = true; setLoading(true); setError('');
    void Promise.all([api.listRentalAccounts(), api.listRentalSessions()]).then(([accountResult, sessionResult]) => {
      if (!alive) return;
      setAccounts(accountResult.items); setSessions(sessionResult.items);
      setSelected(previous => sessionResult.items.some(item => item.id === previous) ? previous : sessionResult.items[0]?.id ?? null);
    }).catch(failure => { if (alive && !onError(failure)) setError(errorInfo(failure).message); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [refresh, onError]);
  useEffect(() => {
    if (!selected) { setAnalysis(null); return; }
    let alive = true; setReportLoading(true); setReportError(''); setAnalysis(null);
    void api.rentalAnalysis(selected).then(result => { if (alive) setAnalysis(result); }).catch(failure => { if (alive && !onError(failure)) setReportError(errorInfo(failure).message); }).finally(() => { if (alive) setReportLoading(false); });
    return () => { alive = false; };
  }, [selected, refresh, onError]);
  const visible = sessions.filter(item => filter === 'all' || (filter === 'active' ? !item.returned_at : Boolean(item.returned_at)));
  const activeCount = sessions.filter(item => !item.returned_at).length;
  return <div className="rentals-page">
    <div className="rental-toolbar"><div><strong>{activeCount} 个账号租用中</strong></div><div className="rental-toolbar-actions"><Button variant="default" leftSection={<RefreshCw size={15} />} loading={loading} onClick={() => setRefresh(n => n + 1)}>刷新</Button><Button leftSection={<Plus size={16} />} disabled={loading || Boolean(error)} onClick={() => setCreating(true)}>开始租号</Button></div></div>
    {error && <Alert color="red" title="租号记录未读取">{error}</Alert>}
    {loading && sessions.length === 0 ? <div className="rental-empty" role="status"><Loader size="sm" />正在读取租号记录…</div> : !error && sessions.length === 0 ? <div className="panel rental-empty"><KeyRound size={38} strokeWidth={1.3} /><h2>记录第一次租号</h2><p>保存账号、租前报价和押金。每局选择用号，还号时填写最终成本。</p><Button onClick={() => setCreating(true)} leftSection={<Plus size={16} />}>添加账号并开始租用</Button></div> : sessions.length > 0 && <div className="rental-layout">
      <aside className="panel rental-list" aria-label="租用记录"><Select label="查看租用" allowDeselect={false} value={filter} data={[{ value: 'all', label: '全部租用' }, { value: 'active', label: '租用中' }, { value: 'returned', label: '已还号' }]} onChange={value => setFilter(value || 'all')} />
        {visible.length === 0 && <p className="rental-muted">暂无符合条件的租用记录。</p>}
        {visible.map(item => <button type="button" className={`rental-list-item ${selected === item.id ? 'selected' : ''}`} key={item.id} aria-pressed={selected === item.id} onClick={() => setSelected(item.id)}><span><strong>{item.account_name}</strong><Badge size="sm" variant="light" color={item.returned_at ? 'gray' : 'cyan'}>{item.returned_at ? '已还号' : '租用中'}</Badge></span><small>{rentalDate(item.started_at)}</small><span><span>{item.round_count} 局</span><span>{item.final_cost_cents === null ? `押金 ${moneyText(item.deposit_cents)}` : `成本 ${moneyText(item.final_cost_cents)}`}</span></span></button>)}
      </aside>
      <section className="rental-report" aria-label="租号分析">{reportLoading ? <div className="panel rental-empty" role="status"><Loader size="sm" />正在计算分析…</div> : reportError ? <Alert color="red" title="分析未读取">{reportError}<Button variant="subtle" size="xs" onClick={() => setRefresh(n => n + 1)}>重新读取</Button></Alert> : analysis && <RentalReport report={analysis} onReturn={() => setReturning(analysis.session)} />}</section>
    </div>}
    {creating && <StartRental accounts={accounts} sessions={sessions} onClose={() => { setCreating(false); onNavigationStateChange(cleanState); }} onSaved={session => { setCreating(false); setSelected(session.id); setFilter('all'); setRefresh(n => n + 1); onNavigationStateChange(cleanState); }} onError={onError} onNavigationStateChange={onNavigationStateChange} />}
    {returning && <ReturnRental session={returning} onClose={() => { setReturning(null); onNavigationStateChange(cleanState); }} onSaved={() => { setReturning(null); setRefresh(n => n + 1); onNavigationStateChange(cleanState); }} onError={onError} onNavigationStateChange={onNavigationStateChange} />}
  </div>;
}

function RentalReport({ report, onReturn }: { report: RentalAnalysis; onReturn: () => void }) {
  const rental = report.session;
  const average = (cents: number | null) => cents === null || report.round_count === 0 ? '—' : moneyText(Math.round(cents / report.round_count));
  return <>
    <div className="panel rental-report-head"><div><div className="rental-title"><h2>{rental.account_name}</h2><Badge variant="light" color={rental.returned_at ? 'gray' : 'cyan'}>{rental.returned_at ? '已还号' : '租用中'}</Badge></div><p>{rentalDate(rental.started_at)} → {rental.returned_at ? rentalDate(rental.returned_at) : '尚未还号'}</p></div><Button variant={rental.returned_at ? 'default' : 'filled'} onClick={onReturn}>{rental.returned_at ? '修正结算金额' : '还号结算'}</Button></div>
    <div className="rental-metrics">
      <Metric label="实际对局" value={`${report.round_count} 局`} detail={`参与 ${report.order_count} 笔订单`} />
      <Metric label="已确定收入" value={moneyText(report.income_cents)} detail={report.pending_order_count ? `${report.pending_order_count} 笔订单待分摊` : '按结单总局数分摊'} />
      <Metric label="最终租号成本" value={rental.final_cost_cents === null ? '待还号' : moneyText(rental.final_cost_cents)} detail={`押金 ${moneyText(rental.deposit_cents)}`} />
      <Metric label="扣租后收益" value={report.profit_cents === null ? '待确定' : moneyText(report.profit_cents)} detail={rental.final_cost_cents === null ? '还号后确定成本' : report.pending_order_count ? '待所有参与订单结单' : '归属收入 − 租号成本'} />
    </div>
    <div className="panel rental-efficiency"><span>平均每局收入 <strong>{report.pending_order_count ? '待全部分摊' : average(report.income_cents)}</strong></span><span>平均每局成本 <strong>{average(rental.final_cost_cents)}</strong></span>{report.refund_cents !== null && <span className="rental-settlement">{report.supplement_cents ? <ArrowUpRight size={16} /> : <ArrowDownLeft size={16} />}{report.supplement_cents ? '应补差额' : '应退押金'} <strong>{moneyText(report.supplement_cents || report.refund_cents)}</strong></span>}</div>
    <section className="panel rental-efficiency" aria-label="退款与免单影响"><span>退款 / 结账少赚 <strong>{moneyText(report.lost_income_cents ?? 0)}</strong></span><span>影响 <strong>{report.affected_order_count ?? 0} 单 · {report.affected_round_count ?? 0} 局</strong></span><span>按应得金额参考收益 <strong>{report.original_profit_cents == null ? '待全部结算' : moneyText(report.original_profit_cents)}</strong></span><small>参考收益按本人应得收入减去同一笔租号成本。转单仅以本人已打部分为基准，下一组应得部分不计为少赚。</small></section>
    {report.pending_order_count > 0 && <Alert color="blue" title="部分收入待分摊">未结单的订单先记录参与局数，结单后补入收入；转单须确认实际结账后计入。收入信息未填写的订单，需要在订单配置中补录。</Alert>}
    <section className="panel rental-orders"><div className="rental-section-heading"><h3>参与订单</h3><span>每笔订单按实际局数分配本人到手收入</span></div>{report.orders.length === 0 ? <p className="rental-muted">还没有对局。记一场时选择这个账号，记录会自动汇总到这里。</p> : <div className="rental-table-wrap"><table><thead><tr><th>订单 / 老板</th><th>本号局数</th><th>订单总局数</th><th>占比</th><th>本人订单收入</th><th>本号归属收入</th><th>退款 / 结账少赚</th></tr></thead><tbody>{report.orders.map(order => <tr key={order.order_id}><td><strong>{order.title}</strong><small>{order.boss_name} · {rentalOrderStatus(order)}</small></td><td>{order.rental_rounds}</td><td>{order.total_rounds}{order.income_status !== 'settled' && <small>当前已录</small>}</td><td>{order.total_rounds ? `${(order.rental_rounds / order.total_rounds * 100).toFixed(1)}%` : '—'}{order.income_status !== 'settled' && <small>结单后确定</small>}</td><td>{order.order_income_cents === null ? '待结算' : moneyText(order.order_income_cents)}</td><td>{order.income_status === 'settled' && order.income_cents !== null ? <strong>{moneyText(order.income_cents)}</strong> : <Badge variant="light" color="blue">{order.income_status === 'missing_finance' ? '待补录收入' : '待分摊'}</Badge>}</td><td>{order.lost_income_cents == null ? '待结算' : moneyText(order.lost_income_cents)}</td></tr>)}</tbody></table></div>}</section>
    <details className="panel rental-quotes"><summary>租前资料与备注</summary><dl><div><dt>租号比例</dt><dd>1 元 : {coinText(rental.coin_per_yuan)}</dd></div><div><dt>AW / 把</dt><dd>{rentalQuoteText(rental.aw_price)}</dd></div><div><dt>6头 / 个</dt><dd>{rentalQuoteText(rental.helmet_price)}</dd></div><div><dt>6甲 / 个</dt><dd>{rentalQuoteText(rental.armor_price)}</dd></div><div><dt>开租纯币</dt><dd>{coinText(rental.initial_coins)}</dd></div></dl>{rental.note && <p>{rental.note}</p>}</details>
  </>;
}
function Metric({ label, value, detail }: { label: string; value: string; detail: string }) { return <div className="panel rental-metric"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>; }

type Numeric = number | '';
const numeric = (value: number | string): Numeric => value === '' ? '' : Number(value);
type RentalDraft = { account: string; name: string; rate: Numeric; aw: Numeric; helmet: Numeric; armor: Numeric; coins: Numeric; deposit: Numeric; started: string; note: string };
function StartRental({ accounts, sessions, onClose, onSaved, onError, onNavigationStateChange }: { accounts: RentalAccount[]; sessions: RentalSession[]; onClose: () => void; onSaved: (session: RentalSession) => void } & Props) {
  const [draft, setDraft] = useState<RentalDraft>(() => ({ account: 'new', name: '', rate: '', aw: 0, helmet: 0, armor: 0, coins: 0, deposit: '', started: rentalLocalTime(), note: '' }));
  const initial = useRef(JSON.stringify(draft));
  const accountId = useRef(crypto.randomUUID());
  const sessionId = useRef(crypto.randomUUID());
  const saving = useRef(false);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [discard, setDiscard] = useState(false);
  const dirty = initial.current !== JSON.stringify(draft);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { onNavigationStateChange({ dirty, busy }); }, [dirty, busy, onNavigationStateChange]);
  const patch = (values: Partial<RentalDraft>) => setDraft(current => ({ ...current, ...values }));
  const close = () => { if (!busy) { if (dirty) setDiscard(true); else onClose(); } };
  const chooseAccount = (value: string) => {
    const previous = sessions.find(item => item.account_id === value);
    patch({ account: value, ...(previous ? { rate: previous.coin_per_yuan / 10_000, aw: previous.aw_price / RENTAL_QUOTE_SCALE, helmet: previous.helmet_price / RENTAL_QUOTE_SCALE, armor: previous.armor_price / RENTAL_QUOTE_SCALE, deposit: previous.deposit_cents / 100 } : {}) });
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (saving.current) return;
    const coinValues = [draft.rate, draft.coins];
    const quoteValues = [draft.aw, draft.helmet, draft.armor];
    if ((draft.account === 'new' && !draft.name.trim()) || coinValues.some(value => value === '' || !Number.isFinite(value) || value < 0 || value * 10_000 > MAX_QUANTITY) || quoteValues.some(value => value === '' || !Number.isFinite(value) || value < 0 || value * RENTAL_QUOTE_SCALE > MAX_QUANTITY) || Number(draft.rate) <= 0 || draft.deposit === '' || !Number.isFinite(draft.deposit) || draft.deposit < 0 || draft.deposit * 100 > MAX_CENTS || !draft.started || Number.isNaN(new Date(`${draft.started}:00+08:00`).getTime())) { setError('请完整填写账号、有效租号比例、非负报价和押金，以及开始时间。'); return; }
    const input: RentalSessionInput = { id: sessionId.current, account_id: draft.account === 'new' ? accountId.current : draft.account, coin_per_yuan: Math.round(Number(draft.rate) * 10_000), aw_price: Math.round(Number(draft.aw) * RENTAL_QUOTE_SCALE), helmet_price: Math.round(Number(draft.helmet) * RENTAL_QUOTE_SCALE), armor_price: Math.round(Number(draft.armor) * RENTAL_QUOTE_SCALE), initial_coins: Math.round(Number(draft.coins) * 10_000), deposit_cents: Math.round(draft.deposit * 100), started_at: new Date(`${draft.started}:00+08:00`).toISOString(), note: draft.note.trim() };
    saving.current = true; setBusy(true); setError('');
    try {
      if (draft.account === 'new') await api.createRentalAccount({ id: accountId.current, name: draft.name.trim(), note: '' });
      const saved = await api.createRentalSession(input);
      if (mounted.current) { notifications.show({ message: '租用已记录，记一场时可选择这个账号', color: 'teal' }); onSaved(saved); }
    } catch (failure) { if (mounted.current && !onError(failure)) setError(errorInfo(failure).message); }
    finally { saving.current = false; if (mounted.current) setBusy(false); }
  };
  return <><Modal opened onClose={close} title="开始租号" centered size="lg" withCloseButton={!busy} closeOnClickOutside={!busy} closeOnEscape={!busy}><form className="rental-form" onSubmit={save}>
    {error && <Alert color="red" title="尚未保存">{error}</Alert>}
    <Select label="租用账号" allowDeselect={false} searchable value={draft.account} disabled={busy} data={[{ value: 'new', label: '添加新账号' }, ...accounts.map(account => ({ value: account.id, label: account.name, disabled: sessions.some(session => session.account_id === account.id && !session.returned_at) }))]} onChange={value => { if (value) chooseAccount(value); }} />
    {draft.account === 'new' && <TextInput label="账号名称" description="填写方便辨认的游戏 ID 或备注名。" required maxLength={80} value={draft.name} disabled={busy} onChange={event => patch({ name: event.currentTarget.value })} />}
    <div className="rental-form-two"><NumberInput label="租号比例（1元对应 W）" required min={0.0001} max={MAX_QUANTITY / 10_000} decimalScale={4} hideControls value={draft.rate} disabled={busy} onChange={value => patch({ rate: numeric(value) })} /><NumberInput label="押金（元）" required min={0} max={MAX_CENTS / 100} decimalScale={2} hideControls value={draft.deposit} disabled={busy} onChange={value => patch({ deposit: numeric(value) })} /></div>
    <fieldset className="rental-form-quotes"><legend>租前报价</legend><div className="rental-form-three">{([{ key: 'aw', label: 'AW（元/把）' }, { key: 'helmet', label: '6头（元/个）' }, { key: 'armor', label: '6甲（元/个）' }] as const).map(field => <NumberInput key={field.key} label={field.label} min={0} max={MAX_QUANTITY / RENTAL_QUOTE_SCALE} decimalScale={2} hideControls value={draft[field.key]} disabled={busy} onChange={value => patch({ [field.key]: numeric(value) })} />)}</div></fieldset>
    <NumberInput label="开租纯币数量（W）" description="记录租号开始时的游戏货币数量。" min={0} max={MAX_QUANTITY / 10_000} decimalScale={4} hideControls value={draft.coins} disabled={busy} onChange={value => patch({ coins: numeric(value) })} />
    <DateTimeField label="开始租用时间" value={draft.started} disabled={busy} onChange={started => patch({ started })} />
    <Textarea label="租用备注" maxLength={2000} value={draft.note} disabled={busy} onChange={event => patch({ note: event.currentTarget.value })} />
    <div className="rental-form-actions"><Button variant="default" disabled={busy} onClick={close}>取消</Button><Button type="submit" leftSection={<Check size={15} />} loading={busy}>确认租用</Button></div>
  </form></Modal><DiscardModal opened={discard} onClose={() => setDiscard(false)} onDiscard={onClose} /></>;
}

function ReturnRental({ session, onClose, onSaved, onError, onNavigationStateChange }: { session: RentalSession; onClose: () => void; onSaved: () => void } & Props) {
  const [cost, setCost] = useState<Numeric>(session.final_cost_cents === null ? '' : session.final_cost_cents / 100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [discard, setDiscard] = useState(false);
  const initial = useRef(cost); const saving = useRef(false); const mounted = useRef(true);
  const dirty = cost !== initial.current;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { onNavigationStateChange({ dirty, busy }); }, [dirty, busy, onNavigationStateChange]);
  const close = () => { if (!busy) { if (dirty) setDiscard(true); else onClose(); } };
  const costCents = cost === '' ? null : Math.round(cost * 100);
  const difference = costCents === null ? null : session.deposit_cents - costCents;
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (saving.current) return;
    if (costCents === null || !Number.isSafeInteger(costCents) || costCents < 0 || costCents > MAX_CENTS) { setError('请填写有效的最终租号成本，免费也需填写 0。'); return; }
    saving.current = true; setBusy(true); setError('');
    try { await api.returnRentalSession(session.id, { final_cost_cents: costCents }); if (mounted.current) { notifications.show({ message: '租号成本已确定，未结单收入将在结单后自动补入', color: 'teal' }); onSaved(); } }
    catch (failure) { if (mounted.current && !onError(failure)) setError(errorInfo(failure).message); }
    finally { saving.current = false; if (mounted.current) setBusy(false); }
  };
  return <><Modal opened onClose={close} title={session.returned_at ? '修正结算金额' : '还号结算'} centered size="sm" withCloseButton={!busy} closeOnEscape={!busy} closeOnClickOutside={!busy}><form className="rental-form" onSubmit={save}><p><strong>{session.account_name}</strong> · 押金 {moneyText(session.deposit_cents)}</p>{error && <Alert color="red">{error}</Alert>}<NumberInput label="最终租号成本（元）" description="填写与出租方确认的实际费用。" required min={0} max={MAX_CENTS / 100} decimalScale={2} hideControls value={cost} disabled={busy} onChange={value => setCost(numeric(value))} autoFocus /><div className="rental-return-preview" aria-live="polite"><span>{difference !== null && difference < 0 ? '应补差额' : '应退押金'}</span><strong>{difference === null ? '—' : moneyText(Math.abs(difference))}</strong></div><p className="rental-muted">未结单订单先保留参与局数，结单后自动补算收入。</p><div className="rental-form-actions"><Button variant="default" disabled={busy} onClick={close}>取消</Button><Button type="submit" loading={busy}>{session.returned_at ? '保存结算' : '确认还号'}</Button></div></form></Modal><DiscardModal opened={discard} onClose={() => setDiscard(false)} onDiscard={onClose} /></>;
}
function DiscardModal({ opened, onClose, onDiscard }: { opened: boolean; onClose: () => void; onDiscard: () => void }) { return <Modal opened={opened} onClose={onClose} title="尚有未保存修改" centered size="sm"><p>放弃本次未保存的修改？</p><div className="rental-form-actions"><Button variant="default" onClick={onClose}>继续填写</Button><Button color="orange" onClick={onDiscard}>放弃修改</Button></div></Modal>; }
