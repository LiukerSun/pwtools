import type { OrderTransfer, ServiceOrder } from '../shared/contracts';
import { orderNetCents } from './rentalPresentation';

export function currentTransfer(order: Pick<ServiceOrder, 'transfer_history'>): OrderTransfer | null {
  const last = order.transfer_history?.at(-1);
  return last && !last.cancelled_at ? last : null;
}

export function automaticTransferRatio(order: Pick<ServiceOrder, 'kind' | 'completed_quantity' | 'total_quantity'>): { numerator: number; denominator: number } {
  if (order.kind === 'single_round') return { numerator: 0, denominator: 1 };
  if (order.total_quantity === 0) return { numerator: 1, denominator: 1 };
  return { numerator: Math.min(order.completed_quantity, order.total_quantity), denominator: order.total_quantity };
}

export function transferPreview(order: ServiceOrder, progressBps: number | null, prepaid: boolean) {
  if (order.price_cents == null || order.participant_count == null || order.commission_bps == null) return null;
  const ratio = progressBps === null ? automaticTransferRatio(order) : { numerator: progressBps, denominator: 10_000 };
  if (!Number.isSafeInteger(ratio.numerator) || !Number.isSafeInteger(ratio.denominator) || ratio.denominator <= 0) return null;
  const original = orderNetCents(order.price_cents, order.participant_count, order.commission_bps);
  const denominator = BigInt(ratio.denominator);
  const expected = Number((BigInt(original) * BigInt(ratio.numerator) + denominator / 2n) / denominator);
  return { original, expected, cash: prepaid ? original - expected : expected, ...ratio };
}

export function transferPercent(numerator: number, denominator: number): string {
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(denominator > 0 ? numerator / denominator * 100 : 0)}%`;
}

export function transferStatus(transfer: OrderTransfer): string {
  if (transfer.cancelled_at) return '已撤销';
  if (transfer.pending_refund_cents > 0) return '待退款';
  if (transfer.status === 'waived') return '已免单';
  if (transfer.status === 'settled') return '已结账';
  return transfer.prepaid ? '待付下家' : '待收下家';
}

export function canCancelTransfer(transfer: OrderTransfer): boolean {
  return !transfer.cancelled_at && transfer.settled_at === null && transfer.cash_events.length === 0;
}

export function refundedTransferCash(transfer: OrderTransfer): number {
  return transfer.cash_events.reduce((total, event) => total + (event.kind === 'refund' ? event.amount_cents : 0), 0);
}
