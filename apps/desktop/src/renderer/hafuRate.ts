export interface HafuRateInput {
  orderPrice: number | string;
  guaranteedWan: number | string;
  commissionPercent: number | string;
}

export const emptyHafuRateInput: HafuRateInput = {
  orderPrice: '',
  guaranteedWan: '',
  commissionPercent: '',
};

export function calculateHafuRate(input: HafuRateInput) {
  const errors: Partial<Record<keyof HafuRateInput, string>> = {};
  const parse = (value: number | string) => typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
  const orderPrice = parse(input.orderPrice);
  const guaranteedWan = parse(input.guaranteedWan);
  const commissionPercent = parse(input.commissionPercent);

  if (!Number.isFinite(orderPrice) || orderPrice <= 0) errors.orderPrice = '订单价格需大于 0 元';
  if (!Number.isFinite(guaranteedWan) || guaranteedWan <= 0) errors.guaranteedWan = '保底金额需大于 0 W';
  if (!Number.isFinite(commissionPercent) || commissionPercent < 0 || commissionPercent > 100) errors.commissionPercent = '陪玩抽成需在 0% 到 100% 之间';
  if (Object.keys(errors).length > 0) return { errors, result: null };

  // Preserve fractional cents until the final display so small orders stay accurate.
  const receivedAmount = orderPrice * (commissionPercent / 100);
  const orderRate = orderPrice / guaranteedWan * 1000;
  const receivedRate = receivedAmount / guaranteedWan * 1000;
  if (![receivedAmount, orderRate, receivedRate].every(Number.isFinite)) {
    errors.guaranteedWan = '数值超出计算范围，请调整订单价格或保底金额';
    return { errors, result: null };
  }
  return { errors, result: { receivedAmount, orderRate, receivedRate } };
}
