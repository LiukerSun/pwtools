import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Loader, Modal } from '@mantine/core';
import { FileImage, ZoomIn } from 'lucide-react';
import { api, errorInfo } from './api';

function useMatchImage(matchId: string, kind: 'thumbnail' | 'original', enabled: boolean, onError: (error: unknown) => boolean) {
  const [sourceUrl, setSourceUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let url = '';
    setLoading(true); setError(''); setSourceUrl('');
    const request = kind === 'thumbnail' ? api.matchThumbnail(matchId) : api.matchImage(matchId);
    void request.then(image => {
      if (!alive) return;
      url = URL.createObjectURL(new Blob([new Uint8Array(image.data).buffer], { type: image.content_type }));
      setSourceUrl(url);
    }).catch(failure => {
      if (alive && !onError(failure)) setError(errorInfo(failure).message);
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [matchId, kind, enabled, retry, onError]);
  return { sourceUrl, loading, error, reload: () => setRetry(value => value + 1), failed: () => setError('截图未能显示，请重新加载。') };
}

export default function MatchScreenshot({ matchId, label, disabled, onError }: {
  matchId: string;
  label: string;
  disabled: boolean;
  onError: (error: unknown) => boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [opened, setOpened] = useState(false);
  const [loadOriginal, setLoadOriginal] = useState(false);
  const thumbnail = useMatchImage(matchId, 'thumbnail', visible, onError);
  const original = useMatchImage(matchId, 'original', loadOriginal, onError);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '120px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return <div className="ledger-entry-media" ref={container}>
    <button type="button" className="ledger-screenshot" disabled={disabled} aria-label={`查看对局截图 · ${label}`} title="查看对局截图" onClick={() => { setVisible(true); setLoadOriginal(true); setOpened(true); }}>
      {thumbnail.sourceUrl && !thumbnail.error ? <><img src={thumbnail.sourceUrl} alt="对局截图缩略图" width={108} height={61} decoding="async" onError={thumbnail.failed} /><span className="ledger-screenshot-zoom"><ZoomIn size={13} aria-hidden="true" />查看截图</span></>
        : <span className="ledger-screenshot-placeholder">{visible && thumbnail.loading ? <Loader size={16} /> : <FileImage size={18} aria-hidden="true" />}<span>{thumbnail.error ? '查看原图' : visible && thumbnail.loading ? '加载中' : '截图预览'}</span></span>}
    </button>
    {thumbnail.error && <button type="button" className="ledger-entry-view ledger-screenshot-retry" disabled={disabled} onClick={thumbnail.reload}>重新加载缩略图</button>}
    <Modal opened={opened} onClose={() => setOpened(false)} title={`对局截图 · ${label}`} centered size="90%" closeButtonProps={{ 'aria-label': '关闭对局截图' }}>
      {original.error ? <Alert color="red" title="截图未加载">{original.error}<Button variant="subtle" size="xs" onClick={original.reload}>重新加载截图</Button></Alert>
        : original.loading || !original.sourceUrl ? <div className="ledger-screenshot-loading" role="status"><Loader size="sm" />正在读取原图…</div>
        : <div className="ledger-screenshot-large"><img src={original.sourceUrl} alt="对局截图原图" onError={original.failed} /></div>}
    </Modal>
  </div>;
}
