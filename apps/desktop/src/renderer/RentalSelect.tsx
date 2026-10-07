import { useEffect, useLayoutEffect, useState } from 'react';
import { Button, Select } from '@mantine/core';
import type { RentalSession } from '../shared/contracts';
import { api, errorInfo } from './api';
import { rentalDate } from './rentalPresentation';

export default function RentalSelect({ value, onChange, disabled, label = '本场使用账号', onError, activeOnly = false, retainedSessionId, onReadyChange }: { value: string | null; onChange: (id: string | null, reason: 'select' | 'unavailable') => void; disabled?: boolean; label?: string; onError: (error: unknown) => boolean; activeOnly?: boolean; retainedSessionId?: string | null; onReadyChange?: (ready: boolean) => void }) {
  const [sessions, setSessions] = useState<RentalSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true; setLoading(true); setError('');
    void api.listRentalSessions().then(result => { if (alive) setSessions(result.items); }).catch(failure => { if (alive && !onError(failure)) setError(errorInfo(failure).message); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [retry, onError]);
  const selected = sessions.find(session => session.id === value);
  const unavailable = Boolean(activeOnly && selected?.returned_at && selected.id !== retainedSessionId);
  const ready = !loading && !error && !unavailable && (!value || Boolean(selected));
  useLayoutEffect(() => { onReadyChange?.(Boolean(ready)); }, [ready, onReadyChange]);
  useEffect(() => {
    if (!loading && !error && !disabled && unavailable) onChange(null, 'unavailable');
  }, [loading, error, disabled, unavailable, onChange]);
  const choices = sessions.filter(session => !activeOnly || !session.returned_at || session.id === retainedSessionId).map(session => ({ value: session.id, label: `${session.account_name} · ${rentalDate(session.started_at)}${session.returned_at ? ' · 已还号' : ' · 租用中'}` }));
  if (value && !selected) choices.unshift({ value, label: loading ? '正在读取账号…' : '账号信息未读取' });
  return <div className="rental-account-select"><Select label={label} value={unavailable ? 'own' : value ?? 'own'} data={[{ value: 'own', label: '自己账号' }, ...choices]} searchable allowDeselect={false} disabled={disabled || loading || Boolean(error)} error={error || undefined} description={!unavailable && selected?.returned_at ? activeOnly ? '保留此场原有的租用账号。' : '已还号，记一场时将默认使用自己账号。' : undefined} onChange={next => { if (next) onChange(next === 'own' ? null : next, 'select'); }} />{error && <Button size="xs" variant="subtle" onClick={() => setRetry(n => n + 1)}>重新读取账号</Button>}</div>;
}
