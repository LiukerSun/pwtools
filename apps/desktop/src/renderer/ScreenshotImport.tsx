import { useEffect, useLayoutEffect, useState } from 'react';
import { Alert, Button, Loader, Modal, Select } from '@mantine/core';
import { Check } from 'lucide-react';
import type { MatchUploadInput, ServiceOrder } from '../shared/contracts';
import { api, errorInfo } from './api';
import { orderLabels, orderStateText, quantityText } from './orderPresentation';

export default function ScreenshotImport({ image, onClose, onSelect, onError, onNavigationStateChange }: { image: MatchUploadInput | null; onClose: () => void; onSelect: (order: ServiceOrder, image: MatchUploadInput | null) => void; onError: (error: unknown) => boolean; onNavigationStateChange: (state: { dirty: boolean; busy: boolean }) => void }) {
  const [orders, setOrders] = useState<ServiceOrder[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
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
    let alive = true; setLoading(true); setError('');
    void api.listOrders().then(response => { if (alive) setOrders(response.items.filter(order => order.status === 'active' && (order.kind === 'escort' || order.kind === 'single_round'))); }).catch((failure: unknown) => { if (alive && !onError(failure)) setError(errorInfo(failure).message); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [retry, onError]);
  const ordersById = new Map(orders.map(item => [item.id, item]));
  const order = selected ? ordersById.get(selected) : undefined;
  return <Modal opened title="导入战绩" centered size="md" onClose={onClose} withCloseButton={!loading} closeOnEscape={!loading} closeOnClickOutside={!loading}>
    <div className="screenshot-import">
      <p>先选择要记入的订单，再核对本场结果。小时单记录陪玩时长，不支持战绩截图。</p>
      {error ? <Alert color="red" title="订单未加载">{error}<Button size="xs" variant="subtle" onClick={() => setRetry(value => value + 1)}>重新加载</Button></Alert> : loading ? <div className="screenshot-import-loading" role="status"><Loader size="sm" />读取订单…</div> : <>
        {orders.length ? <Select label="目标订单" placeholder="选择老板与订单" searchable allowDeselect={false} value={selected} onChange={setSelected} nothingFoundMessage="没有匹配的老板或订单" maxDropdownHeight={320} data={orders.map(item => ({ value: item.id, label: `${item.boss_name} / ${item.title} · ${orderLabels[item.kind]}${!item.boss_game_name.trim() ? ' · 缺少截图昵称' : ''}`, disabled: !item.boss_game_name.trim() }))} renderOption={({ option, checked }) => {
          const item = ordersById.get(option.value)!;
          return <div className="screenshot-import-option" data-disabled={option.disabled || undefined}>
            <div className="screenshot-import-option-heading"><strong>{item.boss_name} / {item.title}</strong>{checked && <Check size={16} aria-hidden="true" />}</div>
            <span className="screenshot-import-order-meta">{orderLabels[item.kind]} · {orderStateText(item)}{!item.boss_game_name.trim() && ' · 缺少截图昵称'}</span>
            <ImportOrderProgress order={item} />
          </div>;
        }} /> : <Alert color="blue">暂无进行中的护航单或单局单。请先建立订单，并填写老板的截图昵称。</Alert>}
        {order && <section className="screenshot-import-selected" aria-label="已选订单进度"><span className="screenshot-import-order-meta">{orderLabels[order.kind]} · {orderStateText(order)}</span><ImportOrderProgress order={order} /></section>}
        {imageUrl && <img className="screenshot-import-preview" src={imageUrl} alt="待导入战绩截图" />}
        <p className="screenshot-import-source">{image ? `已截取屏幕：${image.name}。确认订单后开始识别。` : '选择订单后可上传文件或 Ctrl+V 粘贴截图。'}</p>
      </>}
      <div className="screenshot-import-actions"><Button variant="default" disabled={loading} onClick={onClose}>取消</Button><Button disabled={loading || Boolean(error) || !order} onClick={() => { if (order) onSelect(order, image); }}>继续导入</Button></div>
    </div>
  </Modal>;
}

function ImportOrderProgress({ order }: { order: ServiceOrder }) {
  const singleRound = order.kind === 'single_round';
  return <div className="screenshot-import-progress">
    <span>{singleRound ? '单场最佳' : '已完成'} {quantityText(singleRound ? order.best_round_quantity : order.completed_quantity, order.kind)}</span>
    <span>{singleRound ? '单场目标' : '总目标'} {quantityText(order.total_quantity, order.kind)}</span>
    {!singleRound && <span>{order.excess_quantity > 0 ? `超额 ${quantityText(order.excess_quantity, order.kind)}` : `还欠 ${quantityText(order.remaining_quantity, order.kind)}`}</span>}
  </div>;
}
