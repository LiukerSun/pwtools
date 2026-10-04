import { useEffect, useLayoutEffect, useState } from 'react';
import { Alert, Button, Loader, Modal, Select } from '@mantine/core';
import type { MatchUploadInput, ServiceOrder } from '../shared/contracts';
import { api, errorInfo, isDesktop } from './api';
import { orderLabels } from './orderPresentation';

export default function ScreenshotImport({ onClose, onSelect, onError, onNavigationStateChange }: { onClose: () => void; onSelect: (order: ServiceOrder, image: MatchUploadInput | null) => void; onError: (error: unknown) => boolean; onNavigationStateChange: (state: { dirty: boolean; busy: boolean }) => void }) {
  const [orders, setOrders] = useState<ServiceOrder[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [image, setImage] = useState<MatchUploadInput | null>(null);
  const [imageUrl, setImageUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [clipboardError, setClipboardError] = useState('');
  const [retry, setRetry] = useState(0);
  useLayoutEffect(() => { onNavigationStateChange({ dirty: false, busy: loading }); }, [loading, onNavigationStateChange]);
  useLayoutEffect(() => () => onNavigationStateChange({ dirty: false, busy: false }), [onNavigationStateChange]);
  useEffect(() => {
    if (!image) { setImageUrl(''); return; }
    const url = URL.createObjectURL(new Blob([new Uint8Array(image.data).buffer], { type: image.content_type }));
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);
  useEffect(() => {
    let alive = true; setLoading(true); setError(''); setClipboardError(''); setImage(null);
    const loadOrders = api.listOrders().then(response => { if (alive) setOrders(response.items.filter(order => order.kind === 'escort' || order.kind === 'single_round')); }).catch((failure: unknown) => { if (alive && !onError(failure)) setError(errorInfo(failure).message); });
    const clipboard = isDesktop ? api.readClipboardImage().then(value => { if (alive) setImage(value); }).catch((failure: unknown) => { if (alive) setClipboardError(errorInfo(failure).message); }) : Promise.resolve();
    void Promise.all([loadOrders, clipboard]).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [retry, onError]);
  const order = orders.find(item => item.id === selected);
  return <Modal opened title="导入战绩" centered size="md" onClose={onClose} withCloseButton={!loading} closeOnEscape={!loading} closeOnClickOutside={!loading}>
    <div className="screenshot-import">
      <p>先选择要记入的订单，再核对本场结果。小时单记录陪玩时长，不支持战绩截图。</p>
      {error ? <Alert color="red" title="订单未加载">{error}<Button size="xs" variant="subtle" onClick={() => setRetry(value => value + 1)}>重新加载</Button></Alert> : loading ? <div className="screenshot-import-loading" role="status"><Loader size="sm" />读取订单和剪贴板…</div> : <>
        {orders.length ? <Select label="目标订单" placeholder="选择老板与订单" searchable allowDeselect={false} value={selected} onChange={setSelected} data={orders.map(item => ({ value: item.id, label: `${item.boss_name} / ${item.title} · ${orderLabels[item.kind]}${item.status === 'completed' ? ' · 已完成' : ''}${!item.boss_game_name.trim() ? ' · 缺少截图昵称' : ''}`, disabled: !item.boss_game_name.trim() }))} /> : <Alert color="blue">暂无可导入的订单。请先建立护航单或单局单，并填写老板的截图昵称。</Alert>}
        {imageUrl && <img className="screenshot-import-preview" src={imageUrl} alt="待导入剪贴板截图" />}
        {clipboardError ? <Alert color="orange" title="剪贴板图片未读取">{clipboardError} 选择订单后仍可上传文件或粘贴截图。</Alert> : <p className="screenshot-import-source">{image ? `已读取剪贴板截图：${image.name}。确认订单后开始识别。` : '剪贴板中暂无图片。选择订单后可上传文件或 Ctrl+V 粘贴截图。'}</p>}
      </>}
      <div className="screenshot-import-actions"><Button variant="default" disabled={loading} onClick={onClose}>取消</Button><Button disabled={loading || Boolean(error) || !order} onClick={() => { if (order) onSelect(order, image); }}>继续导入</Button></div>
    </div>
  </Modal>;
}
