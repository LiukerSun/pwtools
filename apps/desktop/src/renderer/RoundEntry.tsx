import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent } from 'react';
import { Alert, Button, Loader, Modal, NumberInput, SegmentedControl, Select, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Check, ChevronDown, Clock3, FileImage, Maximize2, ScanLine, Upload } from 'lucide-react';
import type { LedgerEntryInput, MatchOutcome, MatchRecord, MatchUpdateInput, MatchUploadInput, ServiceOrder } from '../shared/contracts';
import { api, errorInfo } from './api';
import RentalSelect from './RentalSelect';
import { amountFormat, automaticExtra, MAX_QUANTITY, orderSummary, ruleTriggered } from './orderPresentation';
import DateTimeField from './DateTimeField';
import './round-entry.css';

export interface RoundDraft {
  amount: number | '';
  fake_amount: number | '';
  hours: number | '';
  minutes: number | '';
  outcome: MatchOutcome;
  failure_extra_amount: number | '';
  played_at: string;
  note: string;
}

type RoundErrors = Partial<Record<keyof RoundDraft, string>>;
type DraftKey = keyof RoundDraft;
type Action = 'upload' | 'recognize' | 'save' | null;
type PendingSave = { kind: 'image'; file: File; record: MatchRecord; input: MatchUpdateInput; confirmed: true } | { kind: 'match'; id: string; input: MatchUpdateInput; confirmed: boolean } | { kind: 'manual'; input: LedgerEntryInput; confirmed: true };
const uncertainFailure = (code: string) => /TIMEOUT|NETWORK|UNKNOWN|API_ERROR|INTERNAL|SERVER|DATABASE|HTTP_5|INVALID_RESPONSE|RESPONSE_TOO_LARGE|IMAGE_INTEGRITY_ERROR|IMAGE_STORAGE_UNAVAILABLE/.test(code.toUpperCase());

interface RoundEntryProps {
  order: ServiceOrder;
  matchId?: string;
  initialImage?: MatchUploadInput;
  onClose: () => void;
  onSaved: (orderId: string) => void;
  onError: (error: unknown) => boolean;
  onNavigationStateChange?: (state: { dirty: boolean; busy: boolean }) => void;
}

function localTime(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === name)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

const initialDraft = (): RoundDraft => ({ amount: '', fake_amount: '', hours: 0, minutes: 0, outcome: 'success', failure_extra_amount: '', played_at: '', note: '' });
const integer = (value: string | number): number | '' => value === '' ? '' : Number(value);
const validAmount = (value: number | ''): value is number => value !== '' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_QUANTITY;

export function roundNet(draft: RoundDraft): number | null {
  return validAmount(draft.amount) && validAmount(draft.fake_amount) && draft.fake_amount <= draft.amount ? draft.amount - draft.fake_amount : null;
}

export function validateRoundDraft(order: ServiceOrder, draft: RoundDraft, confirmed: boolean): RoundErrors {
  const errors: RoundErrors = {};
  if (order.kind === 'hourly') {
    if (!validAmount(draft.hours)) errors.hours = '小时填写非负整数。';
    if (!validAmount(draft.minutes) || draft.minutes > 59) errors.minutes = '分钟填写 0–59 之间的整数。';
    if (!Object.keys(errors).length && (Number(draft.hours) * 60 + Number(draft.minutes) <= 0 || Number(draft.hours) * 60 + Number(draft.minutes) > MAX_QUANTITY)) errors.minutes = '本次陪玩时长需要大于 0，且不超过允许范围。';
  } else {
    if (confirmed && draft.outcome === 'unknown') errors.outcome = '明确选择撤离成功或失败。';
    if ((confirmed || draft.amount !== '') && !validAmount(draft.amount)) errors.amount = '明确填写 0–9 万亿之间的带出原值整数。';
    if ((confirmed || draft.fake_amount !== '') && (!validAmount(draft.fake_amount) || (validAmount(draft.amount) && draft.fake_amount > draft.amount))) errors.fake_amount = '明确填写假账扣除，0 表示没有假账，扣除不能大于原值。';
    if (ruleTriggered(order, draft.outcome, roundNet(draft)) && order.failure_mode === 'manual' && (confirmed || draft.failure_extra_amount !== '') && !validAmount(draft.failure_extra_amount)) errors.failure_extra_amount = '本场触发追加规则，请明确填写追加金额，0 表示不追加。';
  }
  if (draft.note.length > 1000) errors.note = '备注最多 1000 个字符。';
  if (draft.played_at && Number.isNaN(new Date(`${draft.played_at}:00+08:00`).getTime())) errors.played_at = '填写有效的场次时间，或留空。';
  return errors;
}

export function RoundResultFields({ order, draft, record, disabled, errors, onChange, onDatePickerOpenChange }: { order: ServiceOrder; draft: RoundDraft; record: MatchRecord | null; disabled: boolean; errors: RoundErrors; onChange: (patch: Partial<RoundDraft>) => void; onDatePickerOpenChange?: (opened: boolean) => void }) {
  const net = roundNet(draft);
  const triggered = ruleTriggered(order, draft.outcome, net);
  const unchangedResult = record?.confirmed && draft.amount === record.amount && draft.fake_amount === record.fake_amount && draft.outcome === record.outcome;
  const netNotice = net === null ? '' : draft.outcome === 'failed' ? '失败不计入进度' : draft.outcome === 'success' && order.kind === 'single_round' ? net >= order.total_quantity ? '本场达标' : '本场未达标，需单场达标' : '';
  return <div className="round-result-fields">
    {order.kind === 'hourly' ? <fieldset className="round-time-fields"><legend>本次陪玩时长</legend><div className="round-two-fields"><NumberInput label="小时" aria-label="本次陪玩时长小时" value={draft.hours} min={0} max={Math.floor(MAX_QUANTITY / 60)} allowDecimal={false} hideControls disabled={disabled} error={errors.hours} onChange={(value) => onChange({ hours: integer(value) })} /><NumberInput label="分钟" aria-label="本次陪玩时长分钟" value={draft.minutes} min={0} max={59} allowDecimal={false} hideControls disabled={disabled} error={errors.minutes} onChange={(value) => onChange({ minutes: integer(value) })} /></div><div className="round-duration-presets" role="group" aria-label="常用陪玩时长">{[30, 60, 120, 180].map(minutes => <button type="button" key={minutes} disabled={disabled} aria-pressed={Number(draft.hours) * 60 + Number(draft.minutes) === minutes} onClick={() => onChange({ hours: Math.floor(minutes / 60), minutes: minutes % 60 })}>{minutes < 60 ? `${minutes} 分钟` : `${minutes / 60} 小时`}</button>)}</div></fieldset> : <>
      <Select label="撤离结果" value={draft.outcome} data={[{ value: 'success', label: '撤离成功' }, { value: 'failed', label: '撤离失败' }, { value: 'unknown', label: '待核对' }]} allowDeselect={false} disabled={disabled} error={errors.outcome} onChange={(value) => { if (value) onChange({ outcome: value as MatchOutcome }); }} />
      <NumberInput label="带出金额（哈夫币）" required placeholder="输入金额" value={draft.amount} min={0} max={MAX_QUANTITY} allowDecimal={false} thousandSeparator="," hideControls disabled={disabled} error={errors.amount} onChange={(value) => onChange({ amount: integer(value) })} />
      <div className="round-fake-field"><NumberInput label="假账扣除（哈夫币）" required placeholder="没有则填 0" value={draft.fake_amount} min={0} max={MAX_QUANTITY} allowDecimal={false} thousandSeparator="," hideControls disabled={disabled} error={errors.fake_amount} onChange={(value) => onChange({ fake_amount: integer(value) })} /><Button type="button" variant="subtle" size="xs" disabled={disabled} onClick={() => onChange({ fake_amount: 0 })}>无假账，填 0</Button></div>
      <section className="round-net-preview" aria-label="本场净值" aria-live="polite"><div><span>带出</span><strong>{draft.amount === '' ? '—' : amountFormat.format(draft.amount)}</strong></div><i>−</i><div><span>假账</span><strong>{draft.fake_amount === '' ? '—' : amountFormat.format(draft.fake_amount)}</strong></div><i>=</i><div><span>净带出</span><strong>{net === null ? '—' : amountFormat.format(net)}</strong></div>{netNotice && <p>{netNotice}</p>}</section>
      {order.kind === 'escort' && triggered && <div className="round-extra-rule">{order.failure_mode === 'manual' ? <><NumberInput label="追加金额（哈夫币）" required placeholder="不追加则填 0" value={draft.failure_extra_amount} min={0} max={MAX_QUANTITY} allowDecimal={false} thousandSeparator="," hideControls disabled={disabled} error={errors.failure_extra_amount} onChange={(value) => onChange({ failure_extra_amount: integer(value) })} /><Button type="button" size="xs" variant="subtle" disabled={disabled} onClick={() => onChange({ failure_extra_amount: order.failure_default_quantity })}>使用默认值 {amountFormat.format(order.failure_default_quantity)}</Button></> : order.failure_mode === 'fixed' && record ? <span>{unchangedResult ? `本场追加 ${amountFormat.format(record.failure_extra_amount)} 哈夫币` : '按本场原有约定追加，保存后核对金额'}</span> : <strong>本场预计追加 {amountFormat.format(automaticExtra(order, net))} 哈夫币</strong>}</div>}
    </>}
    <details className="round-supplement"><summary>补充信息{(draft.played_at || draft.note) && <span>已填写</span>}<ChevronDown size={15} /></summary><div><DateTimeField label="场次时间" value={draft.played_at} disabled={disabled} error={errors.played_at} onChange={(played_at) => onChange({ played_at })} onOpenChange={onDatePickerOpenChange} /><Textarea label="备注" minRows={2} maxLength={1000} value={draft.note} disabled={disabled} error={errors.note} onChange={(event) => onChange({ note: event.currentTarget.value })} /></div></details>
  </div>;
}

export default function RoundEntry({ order, matchId, initialImage, onClose, onSaved, onError, onNavigationStateChange }: RoundEntryProps) {
  const readOnly = order.status === 'archived';
  const [mode, setMode] = useState(order.kind === 'hourly' ? 'manual' : 'screenshot');
  const [draft, setDraft] = useState<RoundDraft>(initialDraft);
  const [record, setRecord] = useState<MatchRecord | null>(null);
  const [rentalSessionId, setRentalSessionId] = useState<string | null>(order.default_rental_session_id ?? null);
  const [rentalReady, setRentalReady] = useState(false);
  const rentalTouched = useRef(false);
  const [action, setAction] = useState<Action>(null);
  const [loading, setLoading] = useState(Boolean(matchId));
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<RoundErrors>({});
  const [error, setError] = useState('');
  const [discardOpen, setDiscardOpen] = useState(false);
  const [sourceUrl, setSourceUrl] = useState('');
  const [imageError, setImageError] = useState('');
  const [imageLoading, setImageLoading] = useState(false);
  const [imageRetry, setImageRetry] = useState(0);
  const [loadRetry, setLoadRetry] = useState(0);
  const [imageOpen, setImageOpen] = useState(false);
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadUncertain, setUploadUncertain] = useState(false);
  const [saveUncertain, setSaveUncertain] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const touched = useRef(new Set<DraftKey>());
  const mounted = useRef(true);
  const actionRef = useRef<Action>(null);
  const idempotencyKey = useRef(crypto.randomUUID());
  const pendingSave = useRef<PendingSave | null>(null);
  const initialImageConsumed = useRef(false);
  const busy = loading || action !== null;
  const saving = action === 'save';
  const nicknameReady = Boolean(order.boss_game_name.trim());

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { onNavigationStateChange?.({ dirty, busy: busy || uploadUncertain || saveUncertain }); }, [dirty, busy, uploadUncertain, saveUncertain, onNavigationStateChange]);
  useLayoutEffect(() => () => onNavigationStateChange?.({ dirty: false, busy: false }), [onNavigationStateChange]);
  useEffect(() => {
    if (action !== 'upload' && action !== 'recognize') return;
    const started = Date.now(); setElapsed(0);
    const interval = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(interval);
  }, [action]);

  function mergeRecord(next: MatchRecord, initial: boolean) {
    setRecord(next);
    if (initial && !rentalTouched.current) setRentalSessionId(next.rental_session_id ?? null);
    const patch: Partial<RoundDraft> = { amount: next.amount ?? '', outcome: next.outcome };
    if (initial) Object.assign(patch, { fake_amount: next.fake_amount ?? '', failure_extra_amount: next.failure_extra_amount, played_at: localTime(next.played_at), note: next.note });
    setDraft((current) => {
      const merged = { ...current };
      for (const key of Object.keys(patch) as DraftKey[]) if (!touched.current.has(key)) Object.assign(merged, { [key]: patch[key] });
      return merged;
    });
    setErrors((current) => {
      const next = { ...current };
      for (const key of Object.keys(patch) as DraftKey[]) if (!touched.current.has(key)) delete next[key];
      return next;
    });
  }

  useEffect(() => {
    if (!matchId) return;
    let alive = true;
    setLoading(true); setError('');
    void api.getMatch(matchId).then((next) => {
      if (!alive || !mounted.current) return;
      if (next.order_id && next.order_id !== order.id) { setError('这张截图属于另一笔订单，请从原订单打开。'); return; }
      mergeRecord(next, true);
    }).catch((failure: unknown) => { if (alive && mounted.current && !onError(failure)) setError(errorInfo(failure).message); }).finally(() => { if (alive && mounted.current) setLoading(false); });
    return () => { alive = false; };
  }, [matchId, order.id, loadRetry, onError]);

  useEffect(() => {
    let alive = true;
    let url = '';
    setImageError(''); setSourceUrl('');
    if (record?.confirmed) {
      setImageLoading(true);
      void api.matchImage(record.id).then((image) => {
        if (!alive) return;
        url = URL.createObjectURL(new Blob([new Uint8Array(image.data).buffer], { type: image.content_type }));
        setSourceUrl(url);
      }).catch((failure: unknown) => { if (alive && !onError(failure)) setImageError(errorInfo(failure).message); }).finally(() => { if (alive) setImageLoading(false); });
    } else if (selectedFile) {
      url = URL.createObjectURL(selectedFile); setSourceUrl(url); setImageLoading(false);
    } else { setSourceUrl(''); setImageLoading(false); }
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [record?.id, selectedFile, imageRetry, onError]);

  const patchDraft = (patch: Partial<RoundDraft>) => {
    if (saving || saveUncertain) return;
    for (const key of Object.keys(patch) as DraftKey[]) touched.current.add(key);
    setDraft((current) => ({ ...current, ...patch }));
    setDirty(true); setErrors((current) => { const next = { ...current }; for (const key of Object.keys(patch) as DraftKey[]) delete next[key]; return next; });
  };
  const close = () => { if (busy || actionRef.current || uploadUncertain || saveUncertain) return; if (dirty) setDiscardOpen(true); else onClose(); };
  const run = async (type: Exclude<Action, null>, operation: () => Promise<void>) => {
    if (actionRef.current || loading) return;
    actionRef.current = type; setAction(type); setError('');
    try { await operation(); }
    catch (failure) {
      if (!mounted.current) return;
      const info = errorInfo(failure);
      // A rejected retry cannot prove that the original request did not save.
      // Preview failure cannot persist a record; cancelling is always safe.
      if (type === 'upload') setUploadUncertain(false);
      if (type === 'save') {
        if (saveUncertain || uncertainFailure(info.code)) setSaveUncertain(true);
        else { setSaveUncertain(false); pendingSave.current = null; }
      }
      if (!onError(failure)) setError(info.message);
    }
    finally { actionRef.current = null; if (mounted.current) setAction(null); }
  };

  const upload = (file: File) => {
    if (busy || actionRef.current || saveUncertain || record || matchId || !nicknameReady || order.kind === 'hourly' || (uploadUncertain && file !== selectedFile)) return;
    const contentType = ['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ? file.type : !file.type && /\.png$/i.test(file.name) ? 'image/png' : !file.type && /\.jpe?g$/i.test(file.name) ? 'image/jpeg' : !file.type && /\.webp$/i.test(file.name) ? 'image/webp' : null;
    if (!contentType || !file.size || file.size > 12 * 1024 * 1024) { setError(!contentType ? '只支持 PNG、JPEG 和 WebP 图片。' : !file.size ? '图片文件为空。' : '图片超过 12 MiB，请先缩小截图。'); return; }
    setSelectedFile(file); setDirty(true);
    void run('upload', async () => {
      const data = new Uint8Array(await file.arrayBuffer());
      const result = await api.uploadMatch({ name: file.name, content_type: contentType, data, order_id: order.id });
      if (!mounted.current) return;
      setUploadUncertain(false);
      if (result.record.order_id && result.record.order_id !== order.id) { setError('原图已存在于另一笔订单，请从原订单打开。'); return; }
      mergeRecord(result.record, result.duplicate);
      if (result.duplicate) notifications.show({ message: result.record.confirmed ? '此场已入账，可继续校对' : '请核对后确认入账', color: 'blue' });
    });
  };

  useEffect(() => {
    if (!initialImage || initialImageConsumed.current) return;
    initialImageConsumed.current = true;
    upload(new File([new Uint8Array(initialImage.data).buffer], initialImage.name, { type: initialImage.content_type }));
  }, [initialImage]);

  const pasteScreenshot = (event: ClipboardEvent<HTMLDivElement>) => {
    if (mode !== 'screenshot' || order.kind === 'hourly' || record || matchId || discardOpen || imageOpen || datePickerOpen) return;
    const file = Array.from(event.clipboardData.files).find((item) => item.type.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(item.name))
      ?? Array.from(event.clipboardData.items).find((item) => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile();
    if (!file) return;
    event.preventDefault();
    if (uploadUncertain) return;
    upload(file);
  };

  const recognize = () => {
    if (!record || saveUncertain || uploadUncertain) return;
    void run('recognize', async () => {
      const next = record.confirmed ? await api.recognizeMatch(record.id) : selectedFile
        ? (await api.uploadMatch({ name: selectedFile.name, content_type: record.image_content_type, data: new Uint8Array(await selectedFile.arrayBuffer()), order_id: order.id })).record : record;
      if (mounted.current) mergeRecord(next, false);
    });
  };

  const submitSnapshot = (snapshot: PendingSave) => {
    pendingSave.current = snapshot;
    void run('save', async () => {
      if (snapshot.kind === 'image') await api.confirmMatch({ name: snapshot.file.name, content_type: snapshot.record.image_content_type, data: new Uint8Array(await snapshot.file.arrayBuffer()), order_id: order.id }, snapshot.input, snapshot.record);
      else if (snapshot.kind === 'match') await api.updateMatch(snapshot.id, snapshot.input);
      else await api.addLedgerEntry(order.id, snapshot.input);
      if (!mounted.current) return;
      pendingSave.current = null; setSaveUncertain(false); setDirty(false);
      notifications.show({ message: record?.confirmed ? '校对已保存' : '已入账', color: 'teal' });
      onNavigationStateChange?.({ dirty: false, busy: false });
      onSaved(order.id);
    });
  };

  const save = (confirmed: boolean) => {
    if (readOnly || !confirmed || busy || actionRef.current || (matchId && !record)) return;
    if (saveUncertain && pendingSave.current) { submitSnapshot(pendingSave.current); return; }
    if (!rentalReady) return;
    if (uploadUncertain) { setError('上传结果尚未确认，请重试同一张截图后保存本场。已填写的结果会保留。'); return; }
    if (order.kind !== 'hourly' && mode === 'screenshot' && !record) { setError('先上传本场截图，或切换为手工填写后保存。'); return; }
    const validation = validateRoundDraft(order, draft, confirmed);
    setErrors(validation);
    if (Object.keys(validation).length) return;
    const playedAt = draft.played_at ? new Date(`${draft.played_at}:00+08:00`).toISOString() : null;
    if (record) {
      submitSnapshot({ ...(record.confirmed || !selectedFile ? { kind: 'match' as const, id: record.id } : { kind: 'image' as const, file: selectedFile, record }), confirmed: true, input: { player_name: record.boss_player_name, outcome: draft.outcome, amount: draft.amount === '' ? null : draft.amount, fake_amount: draft.fake_amount === '' ? null : draft.fake_amount, ...(order.failure_mode === 'manual' && (!ruleTriggered(order, draft.outcome, roundNet(draft)) || draft.failure_extra_amount !== '') ? { failure_extra_amount: ruleTriggered(order, draft.outcome, roundNet(draft)) ? Number(draft.failure_extra_amount) : 0 } : {}), confirmed, order_id: order.id, rental_session_id: rentalSessionId, played_at: playedAt, note: draft.note.trim() } });
    } else {
      const quantity = order.kind === 'hourly' ? Number(draft.hours) * 60 + Number(draft.minutes) : Number(draft.amount);
      const input: LedgerEntryInput = { kind: 'progress', quantity, occurred_at: playedAt, note: draft.note.trim(), idempotency_key: idempotencyKey.current, rental_session_id: rentalSessionId };
      if (order.kind !== 'hourly') Object.assign(input, { outcome: draft.outcome, amount: draft.amount, fake_amount: draft.fake_amount, ...(order.failure_mode === 'manual' ? { failure_extra_amount: ruleTriggered(order, draft.outcome, roundNet(draft)) ? draft.failure_extra_amount : 0 } : {}) });
      submitSnapshot({ kind: 'manual', confirmed: true, input });
    }
  };

  return <>
    <Modal opened onClose={close} onPaste={pasteScreenshot} title={matchId ? '校对此场' : '记一场'} centered size={order.kind === 'hourly' || (mode === 'manual' && !record) ? 620 : 1040} classNames={{ content: 'round-modal-content', body: 'round-modal-body' }} closeOnClickOutside={!busy && !uploadUncertain && !saveUncertain && !imageOpen && !discardOpen && !datePickerOpen} closeOnEscape={!busy && !uploadUncertain && !saveUncertain && !imageOpen && !discardOpen && !datePickerOpen} withCloseButton={!busy && !uploadUncertain && !saveUncertain}>
      <div className="round-context"><div><strong>{order.boss_name} / {order.title}</strong><p>{orderSummary(order)}</p></div>{order.kind !== 'hourly' && <SegmentedControl aria-label="本场录入方式" value={mode} disabled={readOnly || saving || saveUncertain} onChange={setMode} data={[{ value: 'screenshot', label: '截图录入' }, { value: 'manual', label: '手工填写' }]} />}</div>
      {error && <Alert color="red" title="本场尚未保存" className="round-alert">{error}{selectedFile && !record && !busy && <Button size="xs" variant="subtle" onClick={() => upload(selectedFile)}>重试上传</Button>}{matchId && !record && !busy && <Button size="xs" variant="subtle" onClick={() => setLoadRetry((current) => current + 1)}>重新读取本场</Button>}</Alert>}
      {uploadUncertain && <Alert color="orange" title="上传结果待核实" className="round-alert">请重试同一张截图，已填写内容会保留。</Alert>}
      {saveUncertain && <Alert color="orange" title="本场保存结果待核实" className="round-alert">可能已保存，请重试核实后再离开。</Alert>}
      {loading && <div className="round-operation" role="status"><Loader size="sm" />加载中…</div>}
      {(action === 'upload' || action === 'recognize') && <div className="round-operation" role="status"><Loader size="sm" /><strong>{window.pwtools ? '本地识别中' : '识别中'} · {elapsed} 秒</strong></div>}
      <form className={`round-workspace ${order.kind === 'hourly' || (mode === 'manual' && !record) ? 'round-hourly' : ''}`} onSubmit={(event) => { event.preventDefault(); save(true); }} noValidate>
        {order.kind !== 'hourly' && (mode === 'screenshot' || record) && <section className="round-source" aria-label="本场原图"><div className="round-pane-heading"><h3><FileImage size={16} />原图</h3>{record && <Button size="xs" variant="subtle" leftSection={<ScanLine size={14} />} disabled={readOnly || busy || saveUncertain} onClick={recognize}>重新识别</Button>}</div>
          {sourceUrl && !imageError ? <button type="button" className="round-image" aria-label="放大本场原图" onClick={() => setImageOpen(true)}><img src={sourceUrl} alt="本场原始战绩截图" onError={() => setImageError('原图无法显示，请重试')} /><span><Maximize2 size={14} />放大</span></button> : <div className="round-image-empty" tabIndex={!record && !matchId && mode === 'screenshot' ? 0 : undefined} aria-label={!record && !matchId && mode === 'screenshot' ? '截图上传区域' : undefined} data-autofocus={!record && !matchId && mode === 'screenshot' ? true : undefined}>{imageLoading ? <Loader size="sm" /> : <FileImage size={34} strokeWidth={1.3} />}{imageError && <p>{imageError}</p>}{imageError && record && <Button size="xs" variant="default" onClick={() => setImageRetry((current) => current + 1)}>重试</Button>}{!record && !matchId && mode === 'screenshot' && <><Button component="label" size="sm" leftSection={<Upload size={15} />} disabled={busy || saveUncertain || uploadUncertain || !nicknameReady}>上传截图<input type="file" accept="image/png,image/jpeg,image/webp" aria-label="导入本场截图" hidden disabled={busy || saveUncertain || uploadUncertain || !nicknameReady} onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) upload(file); }} /></Button><p>也可 Ctrl+V 粘贴截图</p></>}</div>}
          {!record && mode === 'screenshot' && !nicknameReady && <Alert color="orange">请补充老板的截图昵称，或手工填写。<Button size="xs" variant="subtle" onClick={() => setMode('manual')}>手工填写</Button></Alert>}
          {record && <><p className="round-source-caption">{record.original_name}{!record.confirmed && ' · 确认入账后保存原图'}</p>{(record.ocr_status === 'failed' || record.warnings.length > 0) && <Alert color="orange" title={record.ocr_status === 'failed' ? '识别失败，可手工填写' : '请核对结果'}>{record.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</Alert>}</>}
        </section>}
        <section className="round-results" aria-label="本场结果"><div className="round-pane-heading"><h3>{order.kind === 'hourly' ? <Clock3 size={16} /> : <Check size={16} />}结果</h3></div><RentalSelect value={rentalSessionId} activeOnly retainedSessionId={record?.rental_session_id} onReadyChange={setRentalReady} onChange={(id, reason) => { setRentalSessionId(id); if (reason === 'select') { rentalTouched.current = true; setDirty(true); } }} disabled={readOnly || saving || saveUncertain || loading} onError={onError} /><RoundResultFields order={order} draft={draft} record={record} disabled={readOnly || saving || saveUncertain} errors={errors} onChange={patchDraft} onDatePickerOpenChange={setDatePickerOpen} /></section>
        <div className="round-actions"><span>{readOnly ? '已归档；恢复订单后可修改' : record && !record.confirmed ? '确认入账成功后才保留截图' : ''}</span><Button type="button" variant="default" disabled={busy || saveUncertain} onClick={close}>{readOnly ? '关闭' : '取消'}</Button>{!readOnly && <Button type="submit" leftSection={<Check size={15} />} loading={saving} disabled={busy || uploadUncertain || (!saveUncertain && (!rentalReady || (Boolean(matchId) && !record)))}>{saveUncertain ? '重试核实本场' : record?.confirmed ? '保存校对' : '确认入账'}</Button>}</div>
      </form>
    </Modal>
    <Modal opened={discardOpen} onClose={() => setDiscardOpen(false)} title="尚有未保存结果" centered size="sm"><p className="round-discard-copy">{record?.confirmed ? '放弃本次修改，原有已入账记录和截图保持不变。' : '放弃本次录入，未确认的内容和截图不会保留。'}</p><div className="round-discard-actions"><Button variant="default" onClick={() => setDiscardOpen(false)}>继续填写</Button><Button color="orange" onClick={() => { setDiscardOpen(false); onClose(); }}>放弃修改</Button></div></Modal>
    <Modal opened={imageOpen} onClose={() => setImageOpen(false)} title="本场原图" centered size="90%">{sourceUrl && <div className="round-image-large"><img src={sourceUrl} alt="本场原图放大查看" /></div>}</Modal>
  </>;
}
