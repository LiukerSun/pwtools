import { useEffect, useState } from 'react';
import { Alert, Button, Loader, Pagination } from '@mantine/core';
import { ArrowDownToLine, Check, FileImage, ShieldCheck, SlidersHorizontal, Trash2 } from 'lucide-react';
import type { LedgerEntry, LedgerEntryKind, MatchRecord, ServiceOrder } from '../shared/contracts';
import { api, errorInfo } from './api';
import { amountFormat, quantityText } from './orderPresentation';

interface LedgerHistoryProps {
  order: ServiceOrder;
  refresh: number;
  disabled: boolean;
  onError: (error: unknown) => boolean;
  onOpenMatch: (matchId: string) => void;
  onDeleteEntry: (entry: LedgerEntry) => void;
  onDeleteMatch: (matchId: string, label: string, confirmed: boolean) => void;
}

const PAGE_SIZE = 8;
const labels: Record<LedgerEntryKind, string> = { progress: '完成一场', failure: '失败追加', adjustment: '调整约定' };
const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' });
const timestamp = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '时间未填写' : dateFormat.format(date); };
const quantity = (entry: LedgerEntry, kind: ServiceOrder['kind']) => entry.kind === 'failure' ? entry.failure_extra_amount || entry.quantity : kind === 'hourly' ? entry.quantity : entry.credited_amount ?? entry.quantity;

export default function LedgerHistory({ order, refresh, disabled, onError, onOpenMatch, onDeleteEntry, onDeleteMatch }: LedgerHistoryProps) {
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<LedgerEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [draftPage, setDraftPage] = useState(1);
  const [drafts, setDrafts] = useState<MatchRecord[]>([]);
  const [draftTotal, setDraftTotal] = useState(0);
  const [draftLoading, setDraftLoading] = useState(order.kind !== 'hourly');
  const [draftError, setDraftError] = useState('');
  const [draftRetry, setDraftRetry] = useState(0);

  useEffect(() => {
    let alive = true; setLoading(true); setError('');
    void api.listLedgerEntries(order.id, page, PAGE_SIZE).then((response) => {
      if (!alive) return;
      if (page > 1 && response.items.length === 0 && response.total > 0) { setPage(Math.max(1, Math.ceil(response.total / PAGE_SIZE))); return; }
      setItems(response.items); setTotal(response.total);
    }).catch((failure: unknown) => { if (alive && !onError(failure)) setError(errorInfo(failure).message); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [order.id, order.updated_at, page, refresh, retry, onError]);

  useEffect(() => {
    if (order.kind === 'hourly') { setDrafts([]); setDraftTotal(0); setDraftLoading(false); setDraftError(''); return; }
    let alive = true; setDraftLoading(true); setDraftError('');
    void api.listMatches(draftPage, PAGE_SIZE, order.id, false).then((response) => {
      if (!alive) return;
      if (response.items.some((record) => record.confirmed || record.order_id !== order.id)) { setDraftError('截图列表与当前订单不一致，请刷新后重试。'); return; }
      if (draftPage > 1 && response.items.length === 0 && response.total > 0) { setDraftPage(Math.max(1, Math.ceil(response.total / PAGE_SIZE))); return; }
      setDrafts(response.items); setDraftTotal(response.total);
    }).catch((failure: unknown) => { if (alive && !onError(failure)) setDraftError(errorInfo(failure).message); }).finally(() => { if (alive) setDraftLoading(false); });
    return () => { alive = false; };
  }, [order.id, order.kind, order.updated_at, draftPage, refresh, draftRetry, onError]);

  return <div className="ledger-history">
    {(draftError || draftTotal > 0) && <section className="ledger-drafts" aria-label="待确认截图" aria-busy={draftLoading}>
      <div className="ledger-history-heading"><h5>待确认截图{!draftLoading && !draftError && <span> · {draftTotal}</span>}</h5><span>未入账</span></div>
      {draftError ? <Alert color="orange" title="待确认截图未加载">{draftError}<Button variant="subtle" size="xs" onClick={() => setDraftRetry((value) => value + 1)}>重新加载截图</Button></Alert> : draftLoading ? <div className="ledger-draft-loading" role="status"><Loader size="xs" /><span>加载中…</span></div> : <>
        <div className="ledger-draft-list">{drafts.map((record) => <article className="ledger-draft-row" key={record.id} aria-label={`${record.original_name}待确认截图`}>
          <FileImage size={15} /><div className="ledger-draft-copy"><strong>{record.original_name || '未命名截图'}</strong><span>{timestamp(record.played_at || record.created_at)}{record.ocr_status === 'failed' && <small>识别失败</small>}</span></div>
          <Button variant="default" size="xs" disabled={disabled} onClick={() => onOpenMatch(record.id)}>继续填写</Button><button type="button" className="ledger-entry-action delete" disabled={disabled} aria-label={`删除${record.original_name}待确认截图`} onClick={() => onDeleteMatch(record.id, record.original_name || '未命名截图', false)}><Trash2 size={14} /></button>
        </article>)}</div>
        {draftTotal > PAGE_SIZE && <nav className="ledger-history-pagination" aria-label="待确认截图分页"><Pagination size="xs" total={Math.ceil(draftTotal / PAGE_SIZE)} value={draftPage} onChange={setDraftPage} disabled={disabled || draftLoading} /></nav>}
      </>}
    </section>}
    <section aria-label="场次流水" aria-busy={loading}>
      <div className="ledger-history-heading"><h5>记录{!loading && !error && total > 0 && <span> · {total}</span>}</h5></div>
      {error ? <Alert color="red" title="场次账本未加载">{error}<Button variant="subtle" color="red" size="xs" onClick={() => setRetry((value) => value + 1)}>重新加载</Button></Alert> : loading ? <div className="ledger-history-empty" role="status"><Loader size={16} /><span>加载中…</span></div> : items.length ? <>
        <div className="ledger-entry-list">{items.map((entry) => <div className={`ledger-entry ${entry.kind}`} key={entry.id}>
          <span className="ledger-entry-icon">{entry.kind === 'progress' ? <Check size={14} /> : entry.kind === 'failure' ? <ShieldCheck size={14} /> : <SlidersHorizontal size={14} />}</span>
          <div className="ledger-entry-copy"><div><strong>{entry.kind === 'adjustment' ? '调整约定' : entry.outcome === 'failed' ? '撤离失败' : entry.outcome === 'success' ? '撤离成功' : labels[entry.kind]}</strong><span>{timestamp(entry.occurred_at)}</span></div>
            {entry.amount !== null && order.kind !== 'hourly' && <p className="ledger-entry-amounts">原值 {amountFormat.format(entry.amount)} − 假账 {entry.fake_amount === null ? '待核对' : amountFormat.format(entry.fake_amount)} = 净值 {entry.net_amount === null ? '待核对' : amountFormat.format(entry.net_amount)}<span>计入 {amountFormat.format(entry.credited_amount || 0)}{entry.failure_extra_amount > 0 ? ` · 追加 +${amountFormat.format(entry.failure_extra_amount)}` : ''} 哈夫币</span></p>}
            {entry.note && <p>{entry.note}</p>}
          </div>
          {(entry.amount === null || order.kind === 'hourly' || entry.kind === 'adjustment') && <strong className="ledger-entry-quantity">{`${entry.kind === 'adjustment' && entry.quantity >= 0 ? '+' : ''}${quantityText(quantity(entry, order.kind), order.kind)}`}</strong>}
          <div className="ledger-entry-actions">{entry.source === 'screenshot' ? <><button type="button" className="ledger-entry-view" disabled={disabled || !entry.match_id} title={!entry.match_id ? '这条历史记录没有关联截图' : undefined} onClick={() => { if (entry.match_id) onOpenMatch(entry.match_id); }}>查看此场</button><button type="button" className="ledger-entry-action delete" disabled={disabled || !entry.match_id} aria-label="删除本场截图记录" onClick={() => { if (entry.match_id) onDeleteMatch(entry.match_id, `截图校对 · ${timestamp(entry.occurred_at)}`, true); }}><Trash2 size={14} /></button></> : <button type="button" className="ledger-entry-action delete" disabled={disabled} onClick={() => onDeleteEntry(entry)} aria-label={`删除${labels[entry.kind]}记录`}><Trash2 size={14} /></button>}</div>
        </div>)}</div>
        {total > PAGE_SIZE && <nav className="ledger-history-pagination" aria-label="场次流水分页"><Pagination size="xs" total={Math.ceil(total / PAGE_SIZE)} value={page} onChange={setPage} disabled={disabled || loading} /></nav>}
      </> : <div className="ledger-history-empty"><ArrowDownToLine size={16} /><span>暂无记录</span></div>}
    </section>
  </div>;
}
