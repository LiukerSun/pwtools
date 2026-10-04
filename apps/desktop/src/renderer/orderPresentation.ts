import type { FailureMode, FailureTrigger, OrderInput, OrderKind, ServiceOrder } from '../shared/contracts';

export const orderLabels: Record<OrderKind, string> = { single_round: '单局单', escort: '护航单', hourly: '小时单', wager: '对赌单' };
export const triggerLabels: Record<FailureTrigger, string> = { failed: '仅撤离失败', failed_below_standard: '撤离失败且净值低于标准', below_standard: '任意结果净值低于标准' };
export const modeLabels: Record<FailureMode, string> = { manual: '每场手动填写', fixed: '追加固定金额', shortfall: '补足标准与净值的差额' };
export const amountFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
export const MAX_QUANTITY = 9_000_000_000_000;

export function minutesText(value: number): string {
  const hours = Math.floor(Math.abs(value) / 60);
  const minutes = Math.abs(value) % 60;
  return `${value < 0 ? '−' : ''}${hours ? `${amountFormat.format(hours)} 小时` : ''}${hours && minutes ? ' ' : ''}${minutes || !hours ? `${minutes} 分钟` : ''}`;
}

export function quantityText(value: number, kind: OrderKind): string {
  return kind === 'hourly' ? minutesText(value) : kind === 'wager' ? `${amountFormat.format(value)} 场` : `${amountFormat.format(value)} 哈夫币`;
}

export function orderStateText(order: ServiceOrder): string {
  if (order.kind === 'single_round') return order.status === 'completed' ? '已达标' : '待单场达标';
  if (order.kind === 'wager') return order.settlement_result === 'won' ? '已赢' : order.settlement_result === 'lost' ? '已输' : '待结算';
  return order.status === 'completed' ? '已完成' : '进行中';
}

export function orderSummary(order: ServiceOrder): string {
  if (order.kind === 'single_round') return `${orderStateText(order)} · 单场目标 ${quantityText(order.total_quantity, order.kind)}`;
  if (order.kind === 'wager') return `${orderStateText(order)} · ${order.wager_item_name}`;
  return order.status === 'completed' ? `已完成 ${quantityText(order.completed_quantity, order.kind)}` : `还欠 ${quantityText(order.remaining_quantity, order.kind)}`;
}

export function failureSummary(order: Pick<OrderInput, 'kind' | 'failure_trigger' | 'failure_mode' | 'failure_standard_quantity' | 'failure_default_quantity'>): string {
  if (order.kind !== 'escort') return '';
  const trigger = order.failure_trigger || 'failed';
  const mode = order.failure_mode || 'manual';
  const standard = order.failure_standard_quantity || 0;
  return `${triggerLabels[trigger]}${trigger !== 'failed' || mode === 'shortfall' ? `（净值标准 ${amountFormat.format(standard)}）` : ''}；${modeLabels[mode]}${mode === 'shortfall' ? '' : `，默认 ${amountFormat.format(order.failure_default_quantity)} 哈夫币`}`;
}

export function ruleTriggered(order: ServiceOrder, outcome: 'unknown' | 'success' | 'failed', net: number | null): boolean {
  if (order.kind !== 'escort' || outcome === 'unknown') return false;
  if (order.failure_mode === 'shortfall' && net === null) return false;
  if (order.failure_trigger === 'failed') return outcome === 'failed';
  return net !== null && net < order.failure_standard_quantity && (order.failure_trigger === 'below_standard' || outcome === 'failed');
}

export function automaticExtra(order: ServiceOrder, net: number | null): number {
  return order.failure_mode === 'shortfall' ? Math.max(0, order.failure_standard_quantity - (net || 0)) : order.failure_default_quantity;
}

export function orderInput(order: OrderInput): OrderInput {
  return { title: order.title, kind: order.kind, target_quantity: order.target_quantity, failure_default_quantity: order.failure_default_quantity, failure_trigger: order.failure_trigger || 'failed', failure_standard_quantity: order.failure_standard_quantity || 0, failure_mode: order.failure_mode || 'manual', wager_item_id: order.wager_item_id || null, wager_item_name: order.wager_item_name || '', wager_expected: order.wager_expected || 'obtained', wager_condition: order.wager_condition || 'appearance', note: order.note };
}
