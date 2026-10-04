import { expect, test } from '@playwright/test';
import type { ServiceOrder } from '../../apps/desktop/src/shared/contracts';
import { addBoss, createOrder, openLedger, openRound } from './ledger-helpers';

test('服务器已保存但响应丢失时，保留同一结果与幂等键，拒绝切换并安全重试', async ({ page }) => {
  const ledger = await openLedger(page);
  await addBoss(page, '网络核实老板');
  const order = await createOrder(page, '核实一小时', 'hourly', async form => {
    await form.getByLabel('约定陪玩时长小时', { exact: true }).fill('1');
  });
  let attempt = 0;
  const bodies: unknown[] = [];
  await page.route(`**/api/orders/${order.id}/entries`, async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    bodies.push(route.request().postDataJSON());
    attempt += 1;
    if (attempt === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      await route.abort('failed');
    } else if (attempt === 2) {
      await route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: { code: 'RATE_LIMITED', message: '请稍后核实。' } }) });
    } else await route.continue();
  });
  const form = await openRound(page, order.title);
  await form.getByLabel('本次陪玩时长分钟', { exact: true }).fill('15');
  await form.getByRole('button', { name: '确认入账', exact: true }).click();
  await expect(form.getByText('本场保存结果待核实', { exact: true })).toBeVisible();
  await expect(form.getByLabel('本次陪玩时长分钟', { exact: true })).toBeDisabled();
  await expect(form.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
  await page.getByRole('navigation').getByRole('button', { name: '设置', exact: true }).evaluate((element: HTMLButtonElement) => element.click());
  await expect(form).toBeVisible();
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toHaveCount(0);
  await form.getByRole('button', { name: '重试核实本场', exact: true }).click();
  await expect(form.getByText('请稍后核实。', { exact: true })).toBeVisible();
  await expect(form.getByLabel('本次陪玩时长分钟', { exact: true })).toBeDisabled();
  await form.getByRole('button', { name: '重试核实本场', exact: true }).click();
  await expect(form).toHaveCount(0);
  const saved = await ledger.get<ServiceOrder>(`/orders/${order.id}`);
  expect(saved.record_count).toBe(1);
  expect(saved.completed_quantity).toBe(15);
  expect(saved.remaining_quantity).toBe(45);
  expect(bodies).toHaveLength(3);
  expect(bodies[0]).toEqual(bodies[1]);
  expect(bodies[0]).toEqual(bodies[2]);
  expect(ledger.errors).toEqual([]);
});
