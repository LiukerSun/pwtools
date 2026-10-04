import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Alert, Avatar, Button, Collapse, Loader, Menu, Modal, NumberInput, SegmentedControl, Textarea, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { ArrowLeft, BookOpen, Check, ChevronDown, ChevronRight, Clock3, MessageSquare, MoreHorizontal, Pencil, Plus, RefreshCw, Search, ShieldCheck, SlidersHorizontal, Trash2, UsersRound } from 'lucide-react';
import type { Boss, BossInput, LedgerEntry, LedgerEntryKind, ServiceOrder } from '../shared/contracts';
import { api, errorInfo } from './api';
import OrderSetup from './OrderSetup';
import RoundEntry from './RoundEntry';
import LedgerHistory from './LedgerHistory';
import { MAX_QUANTITY, failureSummary, minutesText, orderLabels, orderStateText, orderSummary, quantityText } from './orderPresentation';
import './ledger.css';

interface NavigationState { dirty: boolean; busy: boolean }
interface BossLedgerProps {
  onError: (error: unknown) => boolean;
  initialBossId?: string;
  initialOrderId?: string;
  onNavigationStateChange?: (state: NavigationState) => void;
}
type FormContext = { type: 'boss-create' } | { type: 'boss-edit'; boss: Boss } | { type: 'adjustment'; order: ServiceOrder };
type OrderEditor = { boss: Boss; order?: never; saveAsTemplate?: never } | { boss?: never; order: ServiceOrder; saveAsTemplate?: boolean };
interface FormValues extends BossInput { quantity: number; note: string; occurred_at: string }
type Quantities = Record<'hourly' | 'escort', number | null>;
type EntryTarget = { order: ServiceOrder; matchId?: string };
type Deletion = { type: 'manual'; order: ServiceOrder; entry: LedgerEntry } | { type: 'screenshot'; order: ServiceOrder; matchId: string; label: string; confirmed: boolean };
const entryLabels: Record<LedgerEntryKind, string> = { progress: '完成一场', failure: '失败追加', adjustment: '调整约定' };
const cleanState: NavigationState = { dirty: false, busy: false };

function localDateTime(): string {
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find((value) => value.type === name)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}
const emptyValues = (): FormValues => ({ display_name: '', game_id: '', game_name: '', notes: '', quantity: 0, note: '', occurred_at: localDateTime() });
const entryQuantity = (entry: LedgerEntry): number => entry.kind === 'failure' ? entry.failure_extra_amount || entry.quantity : entry.credited_amount ?? entry.quantity;
function sumOrders(items: ServiceOrder[], field: 'completed_quantity' | 'remaining_quantity'): Quantities {
  const sums: Record<'hourly' | 'escort', bigint | null> = { hourly: 0n, escort: 0n };
  for (const order of items) {
    if (order.kind !== 'hourly' && order.kind !== 'escort') continue;
    const sum = sums[order.kind];
    if (sum === null) continue;
    if (!Number.isSafeInteger(order[field]) || order[field] < 0) { sums[order.kind] = null; continue; }
    const next = sum + BigInt(order[field]);
    sums[order.kind] = next > BigInt(Number.MAX_SAFE_INTEGER) ? null : next;
  }
  return { hourly: sums.hourly === null ? null : Number(sums.hourly), escort: sums.escort === null ? null : Number(sums.escort) };
}

export default function BossLedger({ onError, initialBossId, initialOrderId, onNavigationStateChange }: BossLedgerProps) {
  const mounted = useRef(true);
  const [bosses, setBosses] = useState<Boss[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialBossId || null);
  const [boss, setBoss] = useState<Boss | null>(null);
  const [orders, setOrders] = useState<ServiceOrder[]>([]);
  const [allOrders, setAllOrders] = useState<ServiceOrder[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [refresh, setRefresh] = useState(0);
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [completedOpen, setCompletedOpen] = useState(false);
  const [form, setForm] = useState<FormContext | null>(null);
  const [values, setValues] = useState<FormValues>(emptyValues);
  const initialValues = useRef('');
  const idempotencyKey = useRef('');
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [orderEditor, setOrderEditor] = useState<OrderEditor | null>(null);
  const [orderEditorState, setOrderEditorState] = useState<NavigationState>(cleanState);
  const [entryTarget, setEntryTarget] = useState<EntryTarget | null>(null);
  const [entryState, setEntryState] = useState<NavigationState>(cleanState);
  const modeRef = useRef<HTMLDivElement>(null);
  const overviewScroll = useRef(0);
  const orderNodes = useRef(new Map<string, HTMLElement>());
  const pendingAnchor = useRef<{ id: string; offset?: number; focus?: boolean } | null>(initialOrderId ? { id: initialOrderId, focus: true } : null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [deletion, setDeletion] = useState<Deletion | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const dirty = Boolean(form && JSON.stringify(values) !== initialValues.current);
  const navigationBusy = busy || orderEditorState.busy || entryState.busy;
  const navigationDirty = dirty || orderEditorState.dirty || entryState.dirty;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { onNavigationStateChange?.({ dirty: navigationDirty, busy: navigationBusy }); }, [navigationDirty, navigationBusy, onNavigationStateChange]);
  useLayoutEffect(() => () => onNavigationStateChange?.(cleanState), [onNavigationStateChange]);
  useEffect(() => {
    setSelectedId(initialBossId || null); setExpandedOrderId(null); setCompletedOpen(false);
    pendingAnchor.current = initialOrderId ? { id: initialOrderId, focus: true } : null;
  }, [initialBossId, initialOrderId]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => modeRef.current?.closest('.page-main')?.scrollTo({ top: selectedId ? 0 : overviewScroll.current }));
    return () => cancelAnimationFrame(frame);
  }, [selectedId]);
  useEffect(() => {
    let alive = true; setListLoading(true); setListError('');
    void Promise.all([api.listBosses(), api.listOrders()]).then(([response, orderResponse]) => {
      if (!alive) return;
      setBosses(response.items); setAllOrders(orderResponse.items);
      setSelectedId((current) => current && !response.items.some((item) => item.id === current) ? null : current);
    }).catch((error: unknown) => { if (alive && !onError(error)) setListError(errorInfo(error).message); }).finally(() => { if (alive) setListLoading(false); });
    return () => { alive = false; };
  }, [refresh, onError]);
  useEffect(() => {
    let alive = true;
    if (!selectedId) { setBoss(null); setOrders([]); setDetailLoading(false); return; }
    setDetailLoading(true); setDetailError('');
    void Promise.all([api.getBoss(selectedId), api.listOrders(selectedId)]).then(([nextBoss, response]) => {
      if (!alive) return;
      setBoss(nextBoss); setOrders(response.items.sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id)));
      if (pendingAnchor.current && response.items.some((order) => order.id === pendingAnchor.current?.id && order.status === 'completed')) setCompletedOpen(true);
    }).catch((error: unknown) => { if (alive && !onError(error)) setDetailError(errorInfo(error).message); }).finally(() => { if (alive) setDetailLoading(false); });
    return () => { alive = false; };
  }, [selectedId, refresh, onError]);
  useEffect(() => {
    if (detailLoading || !pendingAnchor.current || !orders.length) return;
    const anchor = pendingAnchor.current;
    const frame = requestAnimationFrame(() => {
      const node = orderNodes.current.get(anchor.id);
      const scroller = modeRef.current?.closest('.page-main');
      if (!node || !scroller) return;
      scroller.scrollTop += node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - (anchor.offset ?? 12);
      if (anchor.focus) node.querySelector<HTMLButtonElement>('.ledger-order-row-main')?.focus({ preventScroll: true });
      setHighlightId(anchor.id); pendingAnchor.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [orders, detailLoading, completedOpen]);
  useEffect(() => { if (!highlightId) return; const timer = window.setTimeout(() => setHighlightId(null), 2200); return () => clearTimeout(timer); }, [highlightId]);

  const summaries = useMemo(() => {
    const result = new Map<string, { completed: Quantities; remaining: Quantities; active: number; singles: number; orders: ServiceOrder[] }>();
    const grouped = new Map<string, ServiceOrder[]>();
    for (const order of allOrders) { const items = grouped.get(order.boss_id) || []; items.push(order); grouped.set(order.boss_id, items); }
    for (const item of bosses) {
      const items = grouped.get(item.id) || [];
      result.set(item.id, { completed: sumOrders(items, 'completed_quantity'), remaining: sumOrders(items, 'remaining_quantity'), active: items.filter((order) => order.status === 'active').length, singles: items.filter((order) => order.kind === 'single_round' && order.status === 'active').length, orders: items });
    }
    return result;
  }, [allOrders, bosses]);
  const visibleBosses = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return bosses.filter((item) => (filter !== 'active' || (summaries.get(item.id)?.active || 0) > 0) && (!needle || [item.display_name, item.game_id, item.game_name, item.notes].some((value) => value.toLocaleLowerCase().includes(needle)))).sort((a, b) => Number((summaries.get(b.id)?.active || 0) > 0) - Number((summaries.get(a.id)?.active || 0) > 0) || b.updated_at.localeCompare(a.updated_at));
  }, [bosses, search, filter, summaries]);
  const currentBoss = boss?.id === selectedId ? boss : null;
  const completedByKind = useMemo(() => sumOrders(orders, 'completed_quantity'), [orders]);
  const activeOrders = orders.filter((order) => order.status === 'active');
  const completedOrders = orders.filter((order) => order.status === 'completed');
  const patchValues = (patch: Partial<FormValues>) => setValues((current) => ({ ...current, ...patch }));
  const captureOrder = (id: string) => {
    const node = orderNodes.current.get(id); const scroller = modeRef.current?.closest('.page-main');
    pendingAnchor.current = { id, ...(node && scroller ? { offset: node.getBoundingClientRect().top - scroller.getBoundingClientRect().top } : {}), focus: true };
  };
  const openEditor = (context: OrderEditor) => { if (navigationBusy) return; if (context.order) captureOrder(context.order.id); setOrderEditorState(cleanState); setOrderEditor(context); };
  const openEntry = (order: ServiceOrder, matchId?: string) => { if (navigationBusy) return; captureOrder(order.id); setEntryState(cleanState); setEntryTarget({ order, matchId }); };
  const openForm = (context: FormContext) => {
    if (navigationBusy) return;
    const next = emptyValues();
    if (context.type === 'boss-edit') Object.assign(next, { display_name: context.boss.display_name, game_id: context.boss.game_id, game_name: context.boss.game_name, notes: context.boss.notes });
    if (context.type === 'adjustment') captureOrder(context.order.id);
    initialValues.current = JSON.stringify(next); idempotencyKey.current = crypto.randomUUID();
    setValues(next); setFormError(''); setDiscardOpen(false); setForm(context);
  };
  const closeForm = () => { if (busy) return; if (dirty) setDiscardOpen(true); else setForm(null); };
  const selectBoss = (id: string) => {
    if (navigationBusy || selectedId === id) return;
    overviewScroll.current = modeRef.current?.closest('.page-main')?.scrollTop || 0;
    pendingAnchor.current = null; setHighlightId(null); setBoss(null); setOrders([]); setExpandedOrderId(null); setCompletedOpen(false); setSelectedId(id);
  };
  const refreshLedger = () => setRefresh((current) => current + 1);

  async function submitForm(event: React.FormEvent) {
    event.preventDefault();
    if (!form || busyRef.current) return;
    setFormError('');
    const bossInput: BossInput = { display_name: values.display_name.trim(), game_id: values.game_id.trim(), game_name: values.game_name.trim(), notes: values.notes.trim() };
    if (form.type !== 'adjustment' && !bossInput.display_name) { setFormError('请填写老板称呼。'); return; }
    if (form.type === 'adjustment' && (!Number.isSafeInteger(values.quantity) || values.quantity === 0 || Math.abs(values.quantity) > MAX_QUANTITY)) { setFormError('调整量须为非零整数。'); return; }
    if (form.type === 'adjustment' && !values.note.trim()) { setFormError('请填写调整原因。'); return; }
    const occurredAt = values.occurred_at ? new Date(`${values.occurred_at}:00+08:00`) : null;
    if (occurredAt && Number.isNaN(occurredAt.getTime())) { setFormError('填写有效的时间。'); return; }
    busyRef.current = true; setBusy(true);
    try {
      if (form.type === 'boss-create') {
        const created = await api.createBoss(bossInput);
        if (!mounted.current) return;
        setBoss(created); setSelectedId(created.id); setSearch(''); setFilter('all'); setOrders([]); setExpandedOrderId(null); setCompletedOpen(false);
      } else if (form.type === 'boss-edit') {
        const updated = await api.updateBoss(form.boss.id, bossInput);
        if (mounted.current && selectedId === updated.id) setBoss(updated);
      } else await api.addLedgerEntry(form.order.id, { kind: 'adjustment', quantity: values.quantity, idempotency_key: idempotencyKey.current, occurred_at: occurredAt?.toISOString() || null, note: values.note.trim() });
      if (!mounted.current) return;
      setForm(null); refreshLedger(); notifications.show({ message: form.type === 'adjustment' ? '约定已调整。' : '老板资料已保存。', color: 'cyan' });
    } catch (error: unknown) { if (mounted.current && !onError(error)) setFormError(errorInfo(error).message); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  async function confirmDelete() {
    if (!deletion || busyRef.current) return;
    busyRef.current = true; setBusy(true); setDeleteError(''); captureOrder(deletion.order.id);
    try {
      if (deletion.type === 'screenshot') await api.deleteMatch(deletion.matchId);
      else await api.deleteLedgerEntry(deletion.order.id, deletion.entry.id);
      if (!mounted.current) return;
      setDeletion(null); refreshLedger(); notifications.show({ message: '记录已删除。', color: 'cyan' });
    } catch (error: unknown) { if (mounted.current && !onError(error)) setDeleteError(errorInfo(error).message); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }

  function renderOrder(order: ServiceOrder) {
    const expanded = expandedOrderId === order.id;
    const summary = order.kind === 'single_round' ? `单场目标 ${quantityText(order.total_quantity, order.kind)}` : orderSummary(order);
    const progress = order.kind === 'single_round' ? `最佳单场 ${quantityText(order.best_round_quantity, order.kind)}` : `${order.status === 'completed' ? '约定' : '已完成'} ${quantityText(order.status === 'completed' ? order.total_quantity : order.completed_quantity, order.kind)}`;
    return <article className={`ledger-order ledger-order-compact ${order.status === 'completed' ? 'is-completed' : ''} ${highlightId === order.id ? 'is-highlighted' : ''}`} key={order.id} aria-label={`${order.title}订单`} ref={(node) => { if (node) orderNodes.current.set(order.id, node); else orderNodes.current.delete(order.id); }}>
      <div className="ledger-order-row"><button type="button" className="ledger-order-row-main" aria-label={`${order.title}场次账本`} aria-expanded={expanded} aria-controls={`ledger-history-${order.id}`} disabled={navigationBusy} onClick={() => setExpandedOrderId((current) => current === order.id ? null : order.id)}><span className={`ledger-order-kind ${order.kind}`}>{order.kind === 'hourly' ? <Clock3 size={14} /> : <ShieldCheck size={14} />}{orderLabels[order.kind]}</span><span className="ledger-order-row-copy"><span className="ledger-order-row-title"><strong>{order.title}</strong><span className={`ledger-order-status ${order.status}`}>{orderStateText(order)}</span></span><span className="ledger-order-row-meta">{progress}</span></span><span className="ledger-order-row-quantity">{summary}<ChevronDown size={14} className={expanded ? 'expanded' : ''} /></span></button><div className="ledger-order-row-actions"><Button size="xs" variant={order.status === 'completed' ? 'default' : 'filled'} disabled={navigationBusy || detailLoading} onClick={() => openEntry(order)}>记一场</Button><Menu position="bottom-end" shadow="md" withinPortal><Menu.Target><button type="button" className="ledger-more-button" aria-label={`${order.title}更多操作`} disabled={navigationBusy || detailLoading}><MoreHorizontal size={18} /></button></Menu.Target><Menu.Dropdown><Menu.Item leftSection={<SlidersHorizontal size={14} />} onClick={() => openEditor({ order })}>订单配置</Menu.Item>{(order.kind === 'hourly' || order.kind === 'escort') && <Menu.Item leftSection={<Pencil size={14} />} onClick={() => openForm({ type: 'adjustment', order })}>调整约定</Menu.Item>}<Menu.Item leftSection={<Plus size={14} />} onClick={() => openEditor({ order, saveAsTemplate: true })}>保存为个人模板</Menu.Item></Menu.Dropdown></Menu></div></div>
      <Collapse expanded={expanded}><div id={`ledger-history-${order.id}`} className="ledger-history-wrap">{expanded && <><OrderFacts order={order} /><LedgerHistory order={order} refresh={refresh} disabled={navigationBusy} onError={onError} onOpenMatch={(matchId) => openEntry(order, matchId)} onDeleteEntry={(entry) => { setDeleteError(''); setDeletion({ type: 'manual', order, entry }); }} onDeleteMatch={(matchId, label, confirmed) => { setDeleteError(''); setDeletion({ type: 'screenshot', order, matchId, label, confirmed }); }} /></>}</div></Collapse>
    </article>;
  }

  return <div className="boss-ledger">
    {!selectedId && <div className="ledger-overview"><div><BookOpen size={17} /><span>{listLoading && bosses.length === 0 ? '加载中…' : <><strong>{bosses.length}</strong> 位老板，<strong>{allOrders.filter((order) => order.status === 'active').length}</strong> 笔进行中订单</>}</span></div><div className="ledger-overview-actions"><Button variant="default" size="xs" aria-label="刷新老板账本" leftSection={<RefreshCw size={14} />} disabled={navigationBusy || listLoading} onClick={refreshLedger}>刷新</Button><Button size="xs" leftSection={<Plus size={15} />} disabled={navigationBusy} onClick={() => openForm({ type: 'boss-create' })}>添加老板</Button></div></div>}
    {listError && <Alert color="red" title="老板列表未加载">{listError}</Alert>}
    <div className="ledger-mode-content" ref={modeRef} key={selectedId || 'overview'}>
      {!selectedId ? <section className="ledger-all-bosses" aria-label="所有老板总览" aria-busy={listLoading}>
        <div className="ledger-all-heading"><div><h2>所有老板</h2></div>{(search.trim() || filter !== 'all') && <span>{visibleBosses.length} / {bosses.length} 位</span>}</div>
        <div className="ledger-all-filters"><TextInput aria-label="搜索老板" placeholder="搜索老板、ID 或备注" leftSection={<Search size={15} />} value={search} onChange={(event) => setSearch(event.currentTarget.value)} /><SegmentedControl value={filter} onChange={setFilter} data={[{ label: '全部老板', value: 'all' }, { label: '有进行中订单', value: 'active' }]} /></div>
        {listLoading && bosses.length === 0 ? <div className="ledger-loading" role="status"><Loader size="sm" /><span>加载中…</span></div> : bosses.length === 0 && !listError ? <div className="ledger-onboarding"><span className="ledger-onboarding-icon"><UsersRound size={35} strokeWidth={1.4} /></span><h2>还没有老板</h2><Button leftSection={<Plus size={16} />} onClick={() => openForm({ type: 'boss-create' })}>添加第一位老板</Button></div> : visibleBosses.length ? <table className="ledger-boss-table" aria-label="老板总览"><thead><tr><th>老板</th><th>累计完成</th><th>还欠老板</th><th>进行中</th><th>关键备注</th><th>订单</th></tr></thead><tbody>{visibleBosses.map((item) => {
          const summary = summaries.get(item.id); if (!summary) return null;
          return <tr key={item.id} aria-label={`${item.display_name}老板汇总`}><td data-label="老板"><button className="ledger-row-identity" aria-label={`查看${item.display_name}资料与订单`} disabled={navigationBusy} onClick={() => selectBoss(item.id)}><span className="ledger-row-avatar">{Array.from(item.display_name).slice(0, 1)}</span><strong>{item.display_name}</strong></button>{item.game_id && <span className="ledger-row-id">ID：{item.game_id}</span>}{item.game_name && <span className="ledger-row-game-name">昵称：{item.game_name}</span>}</td><td data-label="累计完成"><QuantityPair quantities={summary.completed} /></td><td className={`ledger-row-remaining ${summary.active ? 'has-debt' : ''}`} data-label="还欠老板"><QuantityPair quantities={summary.remaining} />{summary.singles > 0 && <div className="ledger-pending-orders"><span>单局待达标 <b>{summary.singles} 单</b></span></div>}{summary.orders.length === 0 && <small>尚未建单</small>}</td><td data-label="进行中"><span className={`ledger-row-active ${summary.active ? 'active' : ''}`}>{summary.active}<small> 笔</small></span><span className="ledger-row-total-orders">共 {summary.orders.length} 单</span></td><td data-label="关键备注"><button className={`ledger-row-note ${item.notes ? '' : 'empty'}`} title={item.notes || '添加老板备注'} aria-label={`编辑${item.display_name}备注`} disabled={navigationBusy} onClick={() => openForm({ type: 'boss-edit', boss: item })}><MessageSquare size={13} /><span>{item.notes || '添加备注'}</span></button></td><td data-label="订单"><div className="ledger-row-actions"><Button variant="default" size="xs" rightSection={<ChevronRight size={13} />} aria-label={`查看${item.display_name}订单`} disabled={navigationBusy} onClick={() => selectBoss(item.id)}>查看订单</Button></div></td></tr>;
        })}</tbody></table> : <div className="ledger-list-empty"><Search size={25} /><strong>{listError ? '老板数据暂时未加载' : '没有符合条件的老板'}</strong>{!listError && <button onClick={() => { setSearch(''); setFilter('all'); }}>查看全部老板</button>}</div>}

      </section> : <section className="ledger-detail" aria-label="老板详情与订单" aria-busy={detailLoading}>
        <div className="ledger-detail-navigation"><Button variant="subtle" size="xs" leftSection={<ArrowLeft size={14} />} disabled={navigationBusy} onClick={() => { pendingAnchor.current = null; setSelectedId(null); setExpandedOrderId(null); setCompletedOpen(false); }}>返回所有老板</Button><Button variant="subtle" size="xs" aria-label="刷新老板订单" leftSection={<RefreshCw size={13} />} disabled={navigationBusy || detailLoading} onClick={refreshLedger}>刷新</Button></div>
        {!currentBoss && detailLoading ? <div className="ledger-loading ledger-detail-loading" role="status"><Loader size="sm" /><span>加载中…</span></div> : <>
          {detailError && <Alert color="red" title="老板订单未加载">{detailError}<Button variant="subtle" color="red" size="xs" onClick={refreshLedger}>重新加载</Button></Alert>}
          {currentBoss && <>
            <header className="ledger-boss-header ledger-boss-header-compact"><div className="ledger-boss-identity"><Avatar size={36} radius="sm" styles={{ placeholder: { background: 'var(--blue-soft)', color: 'var(--blue)' } }}>{Array.from(currentBoss.display_name).slice(0, 2).join('')}</Avatar><div><h2>{currentBoss.display_name}</h2>{(currentBoss.game_id || currentBoss.game_name) && <div className="ledger-boss-identifiers">{currentBoss.game_id && <span>ID：{currentBoss.game_id}</span>}{currentBoss.game_name && <span>截图昵称：{currentBoss.game_name}</span>}</div>}{!detailLoading && <section className="ledger-boss-completion" aria-label="老板累计完成"><span>累计完成</span><span>陪玩 <strong>{completedByKind.hourly === null ? '请按订单查看' : minutesText(completedByKind.hourly)}</strong></span><span>护航 <strong>{completedByKind.escort === null ? '请按订单查看' : quantityText(completedByKind.escort, 'escort')}</strong></span></section>}</div></div><Button size="sm" leftSection={<Plus size={14} />} disabled={navigationBusy || detailLoading} onClick={() => openEditor({ boss: currentBoss })}>新建订单</Button></header>
            <section className={`ledger-boss-memo ledger-boss-memo-compact ${currentBoss.notes ? '' : 'is-empty'}`} aria-label="老板长期备注"><div><MessageSquare size={14} /><h3>老板备注</h3><button disabled={navigationBusy || detailLoading} onClick={() => openForm({ type: 'boss-edit', boss: currentBoss })}>编辑老板资料</button></div><p>{currentBoss.notes || '暂无备注'}</p></section>
            {orders.length === 0 ? <div className="ledger-order-empty"><BookOpen size={25} strokeWidth={1.4} /><h3>还没有订单</h3><Button size="sm" leftSection={<Plus size={14} />} disabled={navigationBusy || detailLoading} onClick={() => openEditor({ boss: currentBoss })}>建立第一笔订单</Button></div> : <>
              <section className="ledger-order-section" aria-label="进行中订单"><div className="ledger-orders-heading"><h3>进行中 <span>{activeOrders.length}</span></h3></div>{activeOrders.length ? <div className="ledger-orders ledger-orders-compact">{activeOrders.map(renderOrder)}</div> : <p className="ledger-no-active">暂无进行中订单</p>}</section>
              {completedOrders.length > 0 && <section className="ledger-completed-section"><button type="button" className="ledger-completed-toggle" aria-expanded={completedOpen} aria-controls="completed-order-list" onClick={() => setCompletedOpen((value) => !value)}>已完成 <span>{completedOrders.length}</span><ChevronDown size={14} className={completedOpen ? 'expanded' : ''} /></button><Collapse expanded={completedOpen}><div id="completed-order-list" className="ledger-orders ledger-orders-compact" aria-label="已完成订单">{completedOrders.map(renderOrder)}</div></Collapse></section>}
            </>}
          </>}
        </>}
      </section>}
    </div>

    {entryTarget && <RoundEntry order={entryTarget.order} matchId={entryTarget.matchId} onError={onError} onNavigationStateChange={setEntryState} onClose={() => { captureOrder(entryTarget.order.id); setEntryTarget(null); setEntryState(cleanState); refreshLedger(); }} onSaved={(id) => { captureOrder(id); setEntryTarget(null); setEntryState(cleanState); refreshLedger(); }} />}
    {orderEditor && <OrderSetup boss={orderEditor.boss} order={orderEditor.order} saveAsTemplate={orderEditor.saveAsTemplate} onError={onError} onNavigationStateChange={setOrderEditorState} onClose={() => { setOrderEditor(null); setOrderEditorState(cleanState); }} onSaved={(saved) => { if (saved) pendingAnchor.current = { id: saved.id, focus: true }; setOrderEditor(null); setOrderEditorState(cleanState); if (saved) refreshLedger(); }} />}
    <Modal opened={form !== null} onClose={closeForm} title={form?.type === 'boss-create' ? '添加老板' : form?.type === 'boss-edit' ? '编辑老板资料' : '调整订单约定'} centered size="md" classNames={{ content: 'ledger-form-modal-content', header: 'ledger-form-modal-header', body: 'ledger-form-modal-body' }} closeOnEscape={!busy} closeOnClickOutside={!busy} withCloseButton={!busy}>
      {form && <form className="ledger-form" onSubmit={submitForm}><div className="ledger-form-fields">{formError && <Alert color="red" title="尚未保存">{formError}</Alert>}{form.type === 'adjustment' ? <><div className="ledger-form-context"><span><strong>{form.order.boss_name}</strong> / {form.order.title}</span></div><NumberInput label={form.order.kind === 'hourly' ? '调整时长（分钟）' : '调整金额（哈夫币）'} description="正数增加，负数减少；总约定须 ≥ 0。" required min={-MAX_QUANTITY} max={MAX_QUANTITY} allowDecimal={false} thousandSeparator="," hideControls value={values.quantity} disabled={busy} onChange={(value) => patchValues({ quantity: typeof value === 'number' ? value : Number(value.replaceAll(',', '')) || 0 })} autoFocus /><TextInput label="调整时间" description="北京时间" type="datetime-local" value={values.occurred_at} disabled={busy} onChange={(event) => patchValues({ occurred_at: event.currentTarget.value })} /><Textarea label="调整原因" required maxLength={1000} minRows={2} value={values.note} disabled={busy} onChange={(event) => patchValues({ note: event.currentTarget.value })} /></> : <><TextInput label="老板称呼" required maxLength={80} value={values.display_name} disabled={busy} onChange={(event) => patchValues({ display_name: event.currentTarget.value })} autoFocus /><div className="ledger-form-two"><TextInput label="游戏 ID" maxLength={80} value={values.game_id} disabled={busy} onChange={(event) => patchValues({ game_id: event.currentTarget.value })} /><TextInput label="截图内昵称" placeholder="截图中的队员名" maxLength={80} value={values.game_name} disabled={busy} onChange={(event) => patchValues({ game_name: event.currentTarget.value })} /></div><Textarea label="老板备注" minRows={3} maxLength={2000} value={values.notes} disabled={busy} onChange={(event) => patchValues({ notes: event.currentTarget.value })} /></>}</div><div className="ledger-modal-actions"><span>{dirty ? '未保存' : ''}</span><Button type="button" variant="default" disabled={busy} onClick={closeForm}>取消</Button><Button type="submit" loading={busy} leftSection={<Check size={14} />}>保存</Button></div></form>}
    </Modal>
    <Modal opened={discardOpen} onClose={() => setDiscardOpen(false)} title="尚有未保存修改" centered size="sm"><div className="ledger-confirm-copy"><p>未保存的内容将丢失。</p><div className="ledger-confirm-actions"><Button variant="default" onClick={() => setDiscardOpen(false)}>继续填写</Button><Button color="orange" onClick={() => { setDiscardOpen(false); setForm(null); }}>放弃修改</Button></div></div></Modal>
    <Modal opened={deletion !== null} onClose={() => { if (!busy) setDeletion(null); }} title={deletion?.type === 'screenshot' ? '删除本场截图记录？' : '删除这条手工记录？'} centered size="sm" withCloseButton={!busy} closeOnEscape={!busy} closeOnClickOutside={!busy}>{deletion && <div className="ledger-confirm-copy"><p><strong>{deletion.order.title}</strong>：{deletion.type === 'screenshot' ? deletion.label : `${entryLabels[deletion.entry.kind]} ${quantityText(entryQuantity(deletion.entry), deletion.order.kind)}`}</p><p>{deletion.type === 'screenshot' ? deletion.confirmed ? '删除本场校对，撤销计入与追加，重新计算订单余额。' : '删除待确认截图和填写结果，不影响已入账金额。' : '撤销这条记录，重新计算订单进度与约定。'}</p>{deleteError && <Alert color="red" title="删除未完成">{deleteError}</Alert>}<div className="ledger-confirm-actions"><Button variant="default" disabled={busy} onClick={() => setDeletion(null)}>取消</Button><Button color="red" loading={busy} leftSection={<Trash2 size={14} />} onClick={() => void confirmDelete()}>删除记录</Button></div></div>}</Modal>
  </div>;
}

function QuantityPair({ quantities }: { quantities: Quantities }) {
  return <div className="ledger-quantity-pair"><span><Clock3 size={12} /><strong>{quantities.hourly === null ? '请按订单查看' : minutesText(quantities.hourly)}</strong></span><span><ShieldCheck size={12} /><strong>{quantities.escort === null ? '请按订单查看' : quantityText(quantities.escort, 'escort')}</strong></span></div>;
}
function OrderFacts({ order }: { order: ServiceOrder }) {
  return <div className="ledger-order-facts">{order.kind === 'single_round' ? <p>多场不累加，失败不追加。</p> : <div className="ledger-order-equation"><span>约定 <b>{quantityText(order.target_quantity, order.kind)}</b></span>{order.kind === 'escort' && order.failure_quantity > 0 && <span>追加 <b>+{quantityText(order.failure_quantity, order.kind)}</b></span>}{order.adjustment_quantity !== 0 && <span>调整 <b>{order.adjustment_quantity >= 0 ? '+' : ''}{quantityText(order.adjustment_quantity, order.kind)}</b></span>}{order.total_quantity !== order.target_quantity && <span>合计 <b>{quantityText(order.total_quantity, order.kind)}</b></span>}</div>}{order.kind === 'escort' && <p>{failureSummary(order)}</p>}{order.excess_quantity > 0 && <p className="ledger-excess">超额 {quantityText(order.excess_quantity, order.kind)}，不抵扣其他订单。</p>}{order.note && <p className="ledger-order-note">{order.note}</p>}</div>;
}
