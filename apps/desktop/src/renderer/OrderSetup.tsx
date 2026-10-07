import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, Button, Collapse, Loader, Modal, NumberInput, Select, Textarea, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Check, ChevronDown, Clock3, Pencil, Settings2, ShieldCheck, Target, Trash2 } from 'lucide-react';
import type { Boss, FailureMode, FailureTrigger, OrderInput, OrderKind, OrderTemplate, ServiceOrder } from '../shared/contracts';
import { api, errorInfo } from './api';
import OrderFinanceFields from './OrderFinanceFields';
import { MAX_CENTS } from './rentalPresentation';
import { MAX_QUANTITY, failureSummary, modeLabels, orderInput, orderLabels, quantityText, triggerLabels } from './orderPresentation';

type NavigationState = { dirty: boolean; busy: boolean };
interface OrderSetupProps {
  boss?: Boss;
  order?: ServiceOrder;
  template?: OrderTemplate;
  saveAsTemplate?: boolean;
  onClose: () => void;
  onSaved: (order?: ServiceOrder) => void;
  onError: (error: unknown) => boolean;
  onNavigationStateChange?: (state: NavigationState) => void;
}

const kinds: OrderKind[] = ['single_round', 'escort', 'hourly'];
const descriptions: Record<OrderKind, string> = { single_round: '单场达标，不累加', escort: '多场累计带出', hourly: '累计陪玩时长' };
const defaults = (kind: OrderKind): OrderInput => ({ title: '', kind, target_quantity: 0, failure_default_quantity: 0, failure_trigger: 'failed', failure_standard_quantity: 0, failure_mode: 'manual', note: '' });
const numeric = (value: string | number) => typeof value === 'number' ? value : Number(value.replaceAll(',', '')) || 0;

function suggestedTitle(input: OrderInput): string {
  return `${orderLabels[input.kind]} · ${input.target_quantity > 0 ? quantityText(input.target_quantity, input.kind) : '本次约定'}`;
}

function validation(input: OrderInput): string | null {
  if (!Number.isSafeInteger(input.target_quantity) || input.target_quantity <= 0 || input.target_quantity > MAX_QUANTITY) return '目标须为大于 0 的整数。';
  if (input.title.length > 120 || input.note.length > 2000) return '订单名称最多 120 字，备注最多 2000 字。';
  if (input.kind === 'escort') {
    if (!Number.isSafeInteger(input.failure_default_quantity) || input.failure_default_quantity < 0 || input.failure_default_quantity > MAX_QUANTITY) return '追加金额须为整数，不能小于 0。';
    const standard = input.failure_standard_quantity ?? 0;
    if (!Number.isSafeInteger(standard) || standard < 0 || standard > MAX_QUANTITY) return '净值标准须为整数，不能小于 0。';
  }
  return null;
}

function normalized(input: OrderInput): OrderInput {
  const copy = orderInput(input);
  copy.title = copy.title.trim() || suggestedTitle(copy);
  copy.note = copy.note.trim();
  if (copy.kind !== 'escort') Object.assign(copy, { failure_trigger: 'failed', failure_mode: 'manual', failure_standard_quantity: 0, failure_default_quantity: 0 });
  return copy;
}

export default function OrderSetup({ boss, order, template, saveAsTemplate, onClose, onSaved, onError, onNavigationStateChange }: OrderSetupProps) {
  const isTemplate = Boolean(template || saveAsTemplate);
  const locked = Boolean(order?.configuration_locked && !isTemplate);
  const initial = useRef<OrderInput>(order || template ? orderInput(order || template!) : defaults('single_round'));
  const [input, setInput] = useState(initial.current);
  const [templateName, setTemplateName] = useState(template?.name || (saveAsTemplate && order ? `${order.title}模板`.slice(0, 80) : ''));
  const initialName = useRef(templateName);
  const [chosen, setChosen] = useState<string | null>(order || template ? 'existing' : null);
  const initialChosen = useRef(chosen);
  const [templates, setTemplates] = useState<OrderTemplate[]>([]);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [templateError, setTemplateError] = useState('');
  const [reload, setReload] = useState(0);
  const [advanced, setAdvanced] = useState(locked);
  const [managerOpen, setManagerOpen] = useState(false);
  const [managerState, setManagerState] = useState<NavigationState>({ dirty: false, busy: false });
  const [busy, setBusy] = useState(false);
  const [rentalReady, setRentalReady] = useState(false);
  const [error, setError] = useState('');
  const [discardOpen, setDiscardOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const pendingAction = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  const submitting = useRef(false);
  const dirty = JSON.stringify(input) !== JSON.stringify(initial.current) || templateName !== initialName.current || chosen !== initialChosen.current;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { onNavigationStateChange?.({ dirty: dirty || managerState.dirty, busy: busy || managerState.busy }); }, [dirty, busy, managerState, onNavigationStateChange]);
  useLayoutEffect(() => () => onNavigationStateChange?.({ dirty: false, busy: false }), [onNavigationStateChange]);
  useEffect(() => {
    if (order || isTemplate) return;
    let alive = true;
    setTemplateLoading(true); setTemplateError('');
    void api.listOrderTemplates().then((response) => { if (alive) setTemplates(response.items); }).catch((failure: unknown) => { if (alive && !onError(failure)) setTemplateError(errorInfo(failure).message); }).finally(() => { if (alive) setTemplateLoading(false); });
    return () => { alive = false; };
  }, [order, isTemplate, reload, onError]);

  const patch = (values: Partial<OrderInput>) => setInput((current) => ({ ...current, ...values }));
  const guard = (action: () => void) => {
    if (busy || managerState.busy) return;
    if (dirty) { pendingAction.current = action; setDiscardOpen(true); }
    else action();
  };
  const choose = (value: string) => {
    if (value === chosen) return;
    const apply = () => {
      const personal = templates.find((item) => item.id === value);
      const next = personal ? orderInput(personal) : defaults(value as OrderKind);
      initial.current = next;
      initialChosen.current = value;
      setInput(next);
      setChosen(value); setError(''); setAdvanced(false);
    };
    // Picking the first template starts a new form; later changes protect entered values.
    if (!chosen) apply(); else guard(apply);
  };
  const save = async () => {
    if (submitting.current) return;
    if (!isTemplate && !rentalReady) { setError('请先读取账号状态，读取失败时请重试。'); return; }
    const values = normalized(input);
    if (isTemplate) {
      delete values.price_cents; delete values.participant_count; delete values.commission_bps; delete values.default_rental_session_id;
    } else if (values.price_cents != null) {
      values.participant_count ??= 1; values.commission_bps ??= 0;
      if (!Number.isSafeInteger(values.price_cents) || values.price_cents < 0 || values.price_cents > MAX_CENTS || !Number.isInteger(values.participant_count) || values.participant_count < 1 || values.participant_count > 100 || !Number.isInteger(values.commission_bps) || values.commission_bps < 0 || values.commission_bps > 10_000) { setError('请填写有效的订单总价、接单人数（1–100）和抽成（0–100%）。'); return; }
    } else if (!order || order.price_cents != null) { setError('请填写订单总价；免费订单填写 0。'); return; }
    else { values.price_cents = null; values.participant_count = null; values.commission_bps = null; }
    const message = validation(values);
    if (message) { setError(message); return; }
    if (isTemplate && (!templateName.trim() || templateName.trim().length > 80)) { setError('模板名称须为 1–80 字。'); return; }
    if (!isTemplate && !order && (values.kind === 'escort' || values.kind === 'single_round') && !boss?.game_name.trim()) { setError('请先填写老板的截图昵称。'); return; }
    if (!isTemplate && !order && !boss) { setError('请先选择老板。'); return; }
    submitting.current = true; setBusy(true); setError(''); setRenameOpen(false);
    try {
      let saved: ServiceOrder | undefined;
      if (isTemplate) {
        const payload = { ...values, name: templateName.trim() };
        if (template) await api.updateOrderTemplate(template.id, payload); else await api.createOrderTemplate(payload);
      } else if (order) saved = await api.updateOrder(order.id, values);
      else if (boss) saved = await api.createOrder(boss.id, values);
      if (!mounted.current) return;
      notifications.show({ message: isTemplate ? '模板已保存' : order ? '订单已保存' : '订单已创建', color: 'cyan' });
      onSaved(saved);
    } catch (failure: unknown) { if (mounted.current && !onError(failure)) setError(errorInfo(failure).message); }
    finally { submitting.current = false; if (mounted.current) setBusy(false); }
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (template && templateName.trim() !== template.name) setRenameOpen(true);
    else void save();
  };
  const title = isTemplate ? template ? '编辑个人模板' : '保存为个人模板' : order ? '订单配置' : '新建订单';
  return <>
    <Modal opened onClose={() => guard(onClose)} title={title} centered size="lg" classNames={{ content: 'ledger-form-modal-content', header: 'ledger-form-modal-header', body: 'ledger-form-modal-body' }} closeOnEscape={!busy && !managerOpen} closeOnClickOutside={!busy && !managerOpen} withCloseButton={!busy}>
      <form className="ledger-form" onSubmit={submit}>
        <div className="ledger-form-fields ledger-setup-fields">
          {error && <Alert color="red" title="尚未保存">{error}</Alert>}
          {!order && !isTemplate && <section className="ledger-template-chooser" aria-label="选择订单模板">
            <div className="ledger-setup-heading"><span>选择模板</span><Button variant="subtle" size="xs" aria-label="管理个人模板" leftSection={<Settings2 size={13} />} disabled={busy} onClick={() => setManagerOpen(true)}>管理模板</Button></div>
            <fieldset className="ledger-kind-options ledger-template-options" aria-label="基础订单模板" disabled={busy}>{kinds.map((kind) => <label key={kind} className={chosen === kind ? 'selected' : ''}><input type="radio" aria-label={`使用${orderLabels[kind]}模板`} name="order-template" value={kind} checked={chosen === kind} onChange={() => choose(kind)} /><span className={`template-kind-icon ${kind}`} aria-hidden="true">{kind === 'hourly' ? <Clock3 size={22} /> : kind === 'escort' ? <ShieldCheck size={22} /> : <Target size={22} />}</span><span><strong>{orderLabels[kind]}</strong><small>{descriptions[kind]}</small></span></label>)}</fieldset>
            {templateLoading ? <p className="ledger-rule-copy" role="status">加载模板…</p> : templateError ? <Alert color="orange">{templateError}<Button variant="subtle" size="xs" onClick={() => setReload((value) => value + 1)}>重试</Button></Alert> : templates.length > 0 && <Select label="个人模板" placeholder="选择已保存的模板" searchable allowDeselect={false} value={templates.some((item) => item.id === chosen) ? chosen : null} data={templates.map((item) => ({ value: item.id, label: `${item.name} · ${orderLabels[item.kind]}` }))} disabled={busy} onChange={(value) => { if (value) choose(value); }} />}
          </section>}
          {(chosen || isTemplate) && <>
            {!order && !isTemplate && <div className="ledger-setup-heading"><span>本次约定</span><small>{boss?.display_name}</small></div>}
            {isTemplate && <TextInput label="模板名称" required maxLength={80} value={templateName} disabled={busy} onChange={(event) => setTemplateName(event.currentTarget.value)} autoFocus />}
            {locked && <Alert color="blue" title="约定已锁定">已有记录，可改收入、默认用号、名称、备注{input.kind === 'escort' && input.failure_mode !== 'shortfall' ? '和后续追加金额' : ''}。</Alert>}
            {(order || isTemplate) && <fieldset className="ledger-kind-options" aria-label="订单类型" disabled={busy || locked}><legend>订单类型</legend>{kinds.map((kind) => <label key={kind} className={input.kind === kind ? 'selected' : ''}><input type="radio" aria-label={orderLabels[kind]} name="edit-order-kind" value={kind} checked={input.kind === kind} onChange={() => { if (kind !== input.kind) guard(() => { setInput({ ...input, ...defaults(kind), title: input.title, note: input.note }); setError(''); }); }} /><span><strong>{orderLabels[kind]}</strong><small>{descriptions[kind]}</small></span></label>)}</fieldset>}
            {input.kind === 'hourly' ? <fieldset className="ledger-time-fields"><legend>约定陪玩时长 <span>*</span></legend><div className="ledger-form-two"><NumberInput label="小时" aria-label="约定陪玩时长小时" min={0} max={150_000_000_000} allowDecimal={false} hideControls disabled={busy || locked} value={Math.floor(input.target_quantity / 60) || ''} onChange={(value) => patch({ target_quantity: numeric(value) * 60 + input.target_quantity % 60 })} /><NumberInput label="分钟" aria-label="约定陪玩时长分钟" min={0} max={59} allowDecimal={false} hideControls disabled={busy || locked} value={input.target_quantity % 60} onChange={(value) => patch({ target_quantity: Math.floor(input.target_quantity / 60) * 60 + numeric(value) })} /></div></fieldset> : <>
              {!isTemplate && !order && !boss?.game_name && <Alert color="orange">请先填写老板的截图昵称。</Alert>}
              <NumberInput label={input.kind === 'single_round' ? '单场净带出目标（哈夫币）' : '约定带出金额（哈夫币）'} required min={0} max={MAX_QUANTITY} allowDecimal={false} thousandSeparator="," hideControls disabled={busy || locked} value={input.target_quantity || ''} onChange={(value) => patch({ target_quantity: numeric(value) })} />
              <div className="ledger-amount-presets" aria-label="约定金额快捷填写">{[1, 3, 5, 10].map((amount) => <button type="button" key={amount} disabled={busy || locked} onClick={() => patch({ target_quantity: amount * 1_000_000 })}>{amount * 100} 万</button>)}</div>
            </>}
            <TextInput label="订单名称" placeholder={suggestedTitle(input)} maxLength={120} value={input.title} disabled={busy} onChange={(event) => patch({ title: event.currentTarget.value })} />
            {!isTemplate && <OrderFinanceFields input={input} onChange={patch} disabled={busy} required={!order || order.price_cents != null} onError={onError} onRentalReadyChange={setRentalReady} />}
            {input.kind === 'escort' && <section className="ledger-setup-summary" aria-label="本次订单约定"><strong>{failureSummary(input)}</strong></section>}
            <button type="button" className="ledger-advanced-toggle" aria-label={`高级约定与备注${locked ? ' · 部分已锁定' : ''}`} aria-expanded={advanced} aria-controls="order-advanced-fields" onClick={() => setAdvanced((value) => !value)}><ChevronDown size={14} />更多设置</button>
            <Collapse expanded={advanced}><div className="ledger-advanced-fields" id="order-advanced-fields">
              {input.kind === 'escort' && <>
                <Select label="追加触发条件" value={input.failure_trigger || 'failed'} data={Object.entries(triggerLabels).map(([value, label]) => ({ value, label }))} allowDeselect={false} disabled={busy || locked} onChange={(value) => { if (value) patch({ failure_trigger: value as FailureTrigger }); }} />
                {((input.failure_trigger || 'failed') !== 'failed' || input.failure_mode === 'shortfall') && <NumberInput label="追加触发净值标准（哈夫币）" min={0} max={MAX_QUANTITY} allowDecimal={false} thousandSeparator="," hideControls disabled={busy || locked} value={input.failure_standard_quantity || 0} onChange={(value) => patch({ failure_standard_quantity: numeric(value) })} />}
                <Select label="追加计算方式" value={input.failure_mode || 'manual'} data={Object.entries(modeLabels).map(([value, label]) => ({ value, label }))} allowDeselect={false} disabled={busy || locked} onChange={(value) => { if (value) patch({ failure_mode: value as FailureMode }); }} />
                {input.failure_mode !== 'shortfall' && <NumberInput label={input.failure_mode === 'fixed' ? '触发后固定追加（哈夫币）' : '未来场次默认追加（哈夫币）'} description={order ? '仅影响后续场次，已记金额不变。' : undefined} min={0} max={MAX_QUANTITY} allowDecimal={false} thousandSeparator="," hideControls disabled={busy} value={input.failure_default_quantity} onChange={(value) => patch({ failure_default_quantity: numeric(value) })} />}
              </>}
              <Textarea label="订单备注" maxLength={2000} minRows={2} value={input.note} disabled={busy} onChange={(event) => patch({ note: event.currentTarget.value })} />
            </div></Collapse>
            {isTemplate && <p className="ledger-rule-copy">模板修改不影响已有订单。</p>}
          </>}
        </div>
        <div className="ledger-modal-actions"><span>{dirty ? '未保存' : ''}</span><Button type="button" variant="default" disabled={busy || managerState.busy} onClick={() => guard(onClose)}>取消</Button><Button type="submit" leftSection={<Check size={14} />} loading={busy} disabled={(!chosen && !isTemplate) || (!isTemplate && !rentalReady)}>{isTemplate ? '保存模板' : order ? '保存配置' : '创建订单'}</Button></div>
      </form>
    </Modal>
    <Modal opened={discardOpen} onClose={() => { pendingAction.current = null; setDiscardOpen(false); }} title="尚有未保存修改" centered size="sm"><div className="ledger-confirm-copy"><p>放弃本次未保存的修改？</p><div className="ledger-confirm-actions"><Button variant="default" onClick={() => { pendingAction.current = null; setDiscardOpen(false); }}>继续填写</Button><Button color="orange" onClick={() => { const action = pendingAction.current; pendingAction.current = null; setDiscardOpen(false); action?.(); }}>放弃修改</Button></div></div></Modal>
    <Modal opened={renameOpen} onClose={() => setRenameOpen(false)} title="确认修改模板名称？" centered size="sm"><div className="ledger-confirm-copy"><p>将「{template?.name}」改为「{templateName.trim()}」，已有订单不变。</p><div className="ledger-confirm-actions"><Button variant="default" onClick={() => setRenameOpen(false)}>继续编辑</Button><Button onClick={() => void save()}>确认修改</Button></div></div></Modal>
    {managerOpen && <TemplateManager onClose={() => { setManagerOpen(false); setManagerState({ dirty: false, busy: false }); setReload((value) => value + 1); }} onError={onError} onNavigationStateChange={setManagerState} />}
  </>;
}

function TemplateManager({ onClose, onError, onNavigationStateChange }: { onClose: () => void; onError: (error: unknown) => boolean; onNavigationStateChange: (state: NavigationState) => void }) {
  const [items, setItems] = useState<OrderTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [editing, setEditing] = useState<OrderTemplate | null>(null);
  const [deleting, setDeleting] = useState<OrderTemplate | null>(null);
  const [busy, setBusy] = useState(false);
  const [editorState, setEditorState] = useState<NavigationState>({ dirty: false, busy: false });
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { onNavigationStateChange({ dirty: editorState.dirty, busy: busy || editorState.busy }); }, [editorState, busy, onNavigationStateChange]);
  useEffect(() => {
    let alive = true; setLoading(true); setError('');
    void api.listOrderTemplates().then((response) => { if (alive) setItems(response.items); }).catch((failure: unknown) => { if (alive && !onError(failure)) setError(errorInfo(failure).message); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [refresh, onError]);
  const remove = async () => {
    if (!deleting || busy) return;
    setBusy(true); setError('');
    try { await api.deleteOrderTemplate(deleting.id); if (mounted.current) { setDeleting(null); setRefresh((value) => value + 1); } }
    catch (failure: unknown) { if (mounted.current && !onError(failure)) setError(errorInfo(failure).message); }
    finally { if (mounted.current) setBusy(false); }
  };
  return <>
    <Modal opened onClose={onClose} title="管理个人模板" size="md" centered closeOnEscape={!busy && !editing && !deleting} closeOnClickOutside={!busy && !editing && !deleting} withCloseButton={!busy && !editing && !deleting}>
      <div className="ledger-template-manager"><p className="ledger-rule-copy">修改或删除模板不影响已有订单。</p>{error && !deleting && <Alert color="red">{error}</Alert>}{loading ? <div className="ledger-loading" role="status"><Loader size="xs" />加载模板…</div> : items.length ? <div className="ledger-template-list">{items.map((item) => <article aria-label={`${item.name}个人模板`} key={item.id}><div><strong>{item.name}</strong><span>{orderLabels[item.kind]} · {quantityText(item.target_quantity, item.kind)}</span></div><Button size="xs" variant="subtle" aria-label={`编辑${item.name}模板`} leftSection={<Pencil size={13} />} onClick={() => { setEditing(item); setEditorState({ dirty: false, busy: false }); }}>编辑</Button><button type="button" className="ledger-entry-action delete" aria-label={`删除${item.name}模板`} onClick={() => { setDeleting(item); setError(''); }}><Trash2 size={14} /></button></article>)}</div> : <p className="ledger-template-empty">暂无模板。可在订单的“更多”菜单中保存。</p>}<div className="ledger-confirm-actions"><Button variant="default" disabled={busy || !!editing} onClick={onClose}>完成</Button></div></div>
    </Modal>
    {editing && <OrderSetup template={editing} onError={onError} onClose={() => { setEditing(null); setEditorState({ dirty: false, busy: false }); }} onSaved={() => { setEditing(null); setEditorState({ dirty: false, busy: false }); setRefresh((value) => value + 1); }} onNavigationStateChange={setEditorState} />}
    <Modal opened={deleting !== null} onClose={() => { if (!busy) setDeleting(null); }} title="删除个人模板？" centered size="sm" closeOnEscape={!busy} closeOnClickOutside={!busy} withCloseButton={!busy}><div className="ledger-confirm-copy"><p>删除「{deleting?.name}」？已有订单不变。</p>{error && <Alert color="red" title="删除未完成">{error}</Alert>}<div className="ledger-confirm-actions"><Button variant="default" disabled={busy} onClick={() => setDeleting(null)}>取消</Button><Button color="red" loading={busy} onClick={() => void remove()}>删除模板</Button></div></div></Modal>
  </>;
}
