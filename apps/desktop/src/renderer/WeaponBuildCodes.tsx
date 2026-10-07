import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Loader, Modal, Select, Textarea, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Copy, Crosshair, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import type { BuildCodeAttributes, BuildCodeLookup, WeaponBuildCode, WeaponBuildCodeInput } from '../shared/contracts';
import { api, errorInfo } from './api';
import { parseBuildCode, type BuildMode } from './buildCode';
import './build-codes.css';

type Props = { onError: (error: unknown) => boolean; onNavigationStateChange: (state: { dirty: boolean; busy: boolean }) => void };
const emptyDraft = (): WeaponBuildCodeInput => ({ code: '', weapon_name: '', mode: '烽火地带', note: '' });
const statusText = { matched: '已匹配属性', unmatched: '未收录此方案', unavailable: '属性查询暂不可用，可稍后重试', not_configured: '属性服务尚未配置' };

function Attributes({ value }: { value: BuildCodeAttributes }) {
  return <div className="build-attributes"><dl>{value.properties.map(p => <div key={p.name}><dt>{p.name}</dt><dd>{p.value}<small>{p.change !== '-' ? p.change : ''}</small></dd></div>)}</dl><div className="build-source"><span>{value.source} · {new Date(value.fetched_at).toLocaleString('zh-CN')}</span>{value.price !== null && <span>参考价 {(value.price / 10000).toFixed(1)} 万</span>}</div></div>;
}

export default function WeaponBuildCodes({ onError, onNavigationStateChange }: Props) {
  const [items, setItems] = useState<WeaponBuildCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState('全部');
  const [editor, setEditor] = useState<WeaponBuildCode | 'new' | null>(null);
  const [draft, setDraft] = useState<WeaponBuildCodeInput>(emptyDraft);
  const [lookup, setLookup] = useState<BuildCodeLookup | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<WeaponBuildCode | null>(null);
  const [discard, setDiscard] = useState(false);
  const baseline = useRef('');
  const inFlight = useRef(false);
  const alive = useRef(true);
  const parsed = parseBuildCode(draft.code);
  const dirty = editor !== null && JSON.stringify(draft) !== baseline.current;
  useLayoutEffect(() => { onNavigationStateChange({ dirty, busy }); }, [dirty, busy, onNavigationStateChange]);
  useEffect(() => {
    alive.current = true;
    void api.listBuildCodes().then(result => { if (alive.current) setItems(result.items); }).catch(err => { if (alive.current && !onError(err)) setError(errorInfo(err).message); }).finally(() => { if (alive.current) setLoading(false); });
    return () => { alive.current = false; };
  }, [onError]);
  const open = (item: WeaponBuildCode | 'new') => {
    const next = item === 'new' ? emptyDraft() : { code: item.code, weapon_name: item.weapon_name, mode: item.mode, note: item.note };
    baseline.current = JSON.stringify(next); setDraft(next); setEditor(item); setError(''); setLookup(null);
  };
  const close = () => { if (!inFlight.current) { if (dirty) setDiscard(true); else setEditor(null); } };
  const patch = (values: Partial<WeaponBuildCodeInput>) => { setDraft(current => ({ ...current, ...values })); setLookup(null); setError(''); };
  const codeChanged = (value: string) => {
    const result = parseBuildCode(value);
    patch({ code: value, ...(result.weapon ? { weapon_name: result.weapon, mode: result.mode as BuildMode } : {}) });
  };
  const valid = !parsed.error && !!draft.code.trim() && !!draft.weapon_name.trim();
  const save = async () => {
    if (inFlight.current || !editor || !valid) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      const item = editor === 'new' ? await api.createBuildCode(draft) : await api.updateBuildCode(editor.id, draft);
      if (!alive.current) return;
      setItems(current => [item, ...current.filter(other => other.id !== item.id)]); setEditor(null);
      notifications.show({ message: '改枪码已保存', color: 'teal' });
    } catch (err) { if (alive.current && !onError(err)) setError(errorInfo(err).message); }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  };
  const check = async () => {
    if (inFlight.current || !valid) return;
    inFlight.current = true; setBusy(true); setError('');
    try { const result = await api.lookupBuildCode(draft); if (alive.current) setLookup(result); }
    catch (err) { if (alive.current && !onError(err)) setError(errorInfo(err).message); }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  };
  const remove = async () => {
    if (!deleting || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try { await api.deleteBuildCode(deleting.id); if (alive.current) { setItems(current => current.filter(item => item.id !== deleting.id)); setDeleting(null); } }
    catch (err) { if (alive.current && !onError(err)) setError(errorInfo(err).message); }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  };
  const copy = async (item: WeaponBuildCode) => {
    try { await navigator.clipboard.writeText(item.code); notifications.show({ message: '改枪码已复制', color: 'teal' }); }
    catch { notifications.show({ title: '复制失败', message: '请选中方案码，按 Ctrl+C 手动复制。', color: 'orange' }); }
  };
  const search = query.trim().toLocaleLowerCase();
  const visible = items.filter(item => (mode === '全部' || item.mode === mode) && `${item.weapon_name} ${item.note}`.toLocaleLowerCase().includes(search));
  return <section className="build-codes">
    <div className="page-heading build-heading"><div><h1>改枪码管理</h1><p>{items.length} 套配装方案</p></div><Button leftSection={<Plus size={16} />} onClick={() => open('new')}>添加改枪码</Button></div>
    <div className="build-toolbar"><TextInput aria-label="搜索改枪码" placeholder="搜索武器或备注" leftSection={<Search size={16} />} value={query} onChange={event => setQuery(event.currentTarget.value)} /><Select aria-label="筛选模式" data={['全部', '烽火地带', '全面战场']} value={mode} onChange={value => setMode(value || '全部')} allowDeselect={false} /></div>
    {error && !editor && !deleting && <Alert color="red" role="alert">{error}<Button variant="subtle" onClick={() => { setLoading(true); setError(''); void api.listBuildCodes().then(result => setItems(result.items)).catch(err => { if (!onError(err)) setError(errorInfo(err).message); }).finally(() => setLoading(false)); }}>重试</Button></Alert>}
    {loading ? <div className="build-empty"><Loader size="sm" /></div> : visible.length === 0 ? <div className="panel build-empty"><Crosshair size={30} aria-hidden="true" /><h2>{items.length ? '没有匹配的方案' : '保存你的第一套配装'}</h2><p>{items.length ? '试试其他关键词或模式。' : '粘贴改枪码，随时查找并复制使用。'}</p></div> : <div className="build-list">{visible.map(item => <article className="panel build-card" key={item.id} aria-label={`${item.weapon_name}改枪方案`}><div className="build-card-heading"><div><h2>{item.weapon_name}</h2><Badge variant="light">{item.mode}</Badge></div><div className="build-actions"><Button size="xs" variant="light" leftSection={<Copy size={14} />} onClick={() => void copy(item)}>复制</Button><Button size="xs" variant="subtle" aria-label={`编辑${item.weapon_name}`} onClick={() => open(item)}><Pencil size={15} /></Button><Button size="xs" variant="subtle" color="red" aria-label={`删除${item.weapon_name}`} onClick={() => { setError(''); setDeleting(item); }}><Trash2 size={15} /></Button></div></div><code className="build-code-text">{item.code}</code>{item.note && <p className="build-note">{item.note}</p>}{item.attributes ? <Attributes value={item.attributes} /> : <p className="build-status">{statusText[item.lookup_status]}</p>}</article>)}</div>}
    <Modal opened={editor !== null} onClose={close} title={editor === 'new' ? '添加改枪码' : '编辑改枪码'} centered size="lg" closeOnEscape={!busy} closeOnClickOutside={!busy} withCloseButton={!busy}>
      <form className="build-form" onSubmit={event => { event.preventDefault(); void save(); }}>
        <Textarea label="改枪码" required autosize minRows={2} maxRows={4} placeholder="完整改枪码或核心码" value={draft.code} onChange={event => codeChanged(event.currentTarget.value)} error={draft.code ? parsed.error : undefined} disabled={busy} />
        <div className="build-form-row"><TextInput label="武器名称" required maxLength={100} placeholder="核心码需补充武器名称" value={draft.weapon_name} onChange={event => patch({ weapon_name: event.currentTarget.value })} readOnly={!!parsed.weapon} disabled={busy} /><Select label="适用模式" required allowDeselect={false} data={['烽火地带', '全面战场']} value={draft.mode} onChange={value => patch({ mode: value as BuildMode })} disabled={busy || !!parsed.mode} /></div>
        <Textarea label="备注" maxLength={2000} autosize minRows={2} maxRows={5} placeholder="用途、配装特点或精校说明" value={draft.note} onChange={event => patch({ note: event.currentTarget.value })} disabled={busy} />
        {lookup && (lookup.attributes ? <Attributes value={lookup.attributes} /> : <Alert color="blue">{statusText[lookup.status]}，仍可保存改枪码。</Alert>)}
        {error && <Alert color="red" role="alert">{error}</Alert>}
        <div className="build-form-actions"><Button variant="light" disabled={!valid || busy} onClick={() => void check()}>查询属性</Button><div><Button variant="default" disabled={busy} onClick={close}>取消</Button><Button type="submit" loading={busy} disabled={!valid}>保存</Button></div></div>
      </form>
    </Modal>
    <Modal opened={deleting !== null} onClose={() => !busy && setDeleting(null)} title="删除改枪码" centered size="sm" closeOnEscape={!busy} closeOnClickOutside={!busy} withCloseButton={!busy}><p>确认删除「{deleting?.weapon_name}」的方案？删除后无法恢复。</p>{error && <Alert color="red" role="alert">{error}</Alert>}<div className="build-dialog-actions"><Button variant="default" disabled={busy} onClick={() => setDeleting(null)}>取消</Button><Button color="red" loading={busy} onClick={() => void remove()}>确认删除</Button></div></Modal>
    <Modal opened={discard} onClose={() => setDiscard(false)} title="放弃未保存修改" centered size="sm"><p>关闭将丢弃当前填写内容。</p><div className="build-dialog-actions"><Button variant="default" onClick={() => setDiscard(false)}>继续填写</Button><Button onClick={() => { setDiscard(false); setEditor(null); }}>放弃修改</Button></div></Modal>
  </section>;
}
