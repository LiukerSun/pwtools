import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateHafuRate, emptyHafuRateInput } from '../../apps/desktop/src/renderer/hafuRate.ts';

const order = { orderPrice: 200, guaranteedWan: 2500, commissionPercent: 80 };

test('按万哈夫币换算每 1000W 的订单原价和陪玩到手汇率', () => {
  assert.deepEqual(calculateHafuRate(order), {
    errors: {},
    result: { receivedAmount: 160, orderRate: 80, receivedRate: 64 },
  });
});

test('百分比支持零抽成、全额抽成以及小数', () => {
  assert.equal(calculateHafuRate({ ...order, commissionPercent: 0 }).result?.receivedRate, 0);
  assert.equal(calculateHafuRate({ ...order, commissionPercent: 100 }).result?.receivedRate, 80);
  assert.equal(calculateHafuRate({ ...order, commissionPercent: 82.5 }).result?.receivedRate, 66);
});

test('接受输入框的十进制字符串并保留中间计算精度', () => {
  const decimalOrder = calculateHafuRate({ orderPrice: '99.99', guaranteedWan: '1500', commissionPercent: '70' });
  assert.ok(decimalOrder.result);
  assert.ok(Math.abs(decimalOrder.result.receivedRate - 46.662) < 1e-10);
  const smallOrder = calculateHafuRate({ orderPrice: 0.01, guaranteedWan: 0.5, commissionPercent: 50 });
  assert.equal(smallOrder.result?.receivedAmount, 0.005);
  assert.equal(smallOrder.result?.receivedRate, 10);
});

test('未填写的抽成不能当成零，空白输入不产生结果', () => {
  assert.equal(calculateHafuRate(emptyHafuRateInput).result, null);
  for (const commissionPercent of ['', '  ']) {
    const calculation = calculateHafuRate({ ...order, commissionPercent });
    assert.equal(calculation.result, null);
    assert.ok(calculation.errors.commissionPercent);
  }
});

test('拦截无效价格、保底、百分比以及非有限数值', () => {
  for (const field of ['orderPrice', 'guaranteedWan', 'commissionPercent'] as const) {
    const values = field === 'commissionPercent' ? [-1, 100.01, NaN, Infinity, 'abc'] : [0, -1, NaN, Infinity, 'abc'];
    for (const value of values) {
      const calculation = calculateHafuRate({ ...order, [field]: value });
      assert.equal(calculation.result, null, `${field}: ${value}`);
      assert.ok(calculation.errors[field], `${field}: ${value}`);
    }
  }
});

test('极端数值溢出时不显示无限大汇率', () => {
  const calculation = calculateHafuRate({ ...order, orderPrice: Number.MAX_VALUE, guaranteedWan: Number.MIN_VALUE });
  assert.equal(calculation.result, null);
  assert.ok(calculation.errors.guaranteedWan);
});
