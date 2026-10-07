import { expect, test, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Boss, OrderKind, RentalAccount, RentalAnalysis, RentalSession, ServiceOrder } from '../../apps/desktop/src/shared/contracts';
import { addBoss, openLedger, orderArticle } from './ledger-helpers';

// Every financial assertion below comes from the real API. Routes only simulate a lost
// response in the retry test; they never calculate or fabricate transfer amounts.
async function seedTransferOrder(page: Page, kind: OrderKind, title: string) {
  const ledger = await openLedger(page);
  const boss = await addBoss(page, `${title}老板`);
  const account = await ledger.post<RentalAccount>('/rental-accounts', { id: randomUUID(), name: `${title}账号`, note: '' });
  const rental = await ledger.post<RentalSession>('/rental-sessions', {
    id: randomUUID(), account_id: account.id, coin_per_yuan: 500000,
    aw_price: 1000, helmet_price: 1000, armor_price: 1000, initial_coins: 10000000,
    deposit_cents: 20000, started_at: new Date(Date.now() - 3600000).toISOString(), note: '',
  });
  const order = await ledger.post<ServiceOrder>(`/bosses/${boss.id}/orders`, {
    title, kind, target_quantity: kind === 'hourly' ? 120 : 1000000,
    failure_default_quantity: 0, failure_trigger: 'failed', failure_standard_quantity: 0,
    failure_mode: 'manual', note: '', price_cents: 99800, participant_count: 2, commission_bps: 2000,
    default_rental_session_id: rental.id,
  });
  if (kind === 'escort') await ledger.post(`/orders/${order.id}/entries`, {
    kind: 'failure', quantity: 200000, amount: 0, fake_amount: 0, outcome: 'failed', failure_extra_amount: 200000,
    occurred_at: null, note: '炸单追加二十万，整体约定变成一百二十万', idempotency_key: randomUUID(), rental_session_id: rental.id,
  });
  await ledger.post(`/orders/${order.id}/entries`, {
    kind: 'progress', quantity: kind === 'hourly' ? 60 : 600000,
    ...(kind === 'hourly' ? {} : { amount: 600000, fake_amount: 0, outcome: 'success', failure_extra_amount: 0 }),
    occurred_at: null, note: '实际打单记录', idempotency_key: randomUUID(), rental_session_id: rental.id,
  });
  await page.getByRole('button', { name: '刷新老板订单', exact: true }).click();
  await expect(orderArticle(page, title)).toBeVisible();
  const current = () => ledger.get<ServiceOrder>(`/orders/${order.id}`);
  const analysis = () => ledger.get<RentalAnalysis>(`/rental-sessions/${rental.id}/analysis`);
  return { ...ledger, boss, order, rental, current, analysis };
}

function transferOf(order: ServiceOrder) {
  expect(order.transfer_history?.length, '服务器应保留转单历史').toBeGreaterThan(0);
  return order.transfer_history!.at(-1)!;
}

async function openTransfer(page: Page, title: string) {
  await orderArticle(page, title).getByRole('button', { name: '转单', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '转单', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function submitTransfer(page: Page, dialog: Locator, orderId: string, button: string, action = false) {
  const response = page.waitForResponse(item => item.request().method() === 'POST'
    && item.url().endsWith(`/api/orders/${orderId}/${action ? 'transfer-action' : 'transfer'}`));
  await dialog.getByRole('button', { name: button, exact: true }).click();
  const saved = await response;
  expect(saved.status(), await saved.text()).toBe(200);
  await expect(dialog).toHaveCount(0);
  return saved.json() as Promise<ServiceOrder>;
}

async function openAction(page: Page, title: string, action: string, dialogName = action) {
  await orderArticle(page, title).getByRole('button', { name: action, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: dialogName, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function settle(page: Page, order: ServiceOrder, amount: string, prepaid = false) {
  const dialog = await openAction(page, order.title, '确认结账');
  await dialog.getByLabel(prepaid ? '实际付给下家（元）' : '实际收到金额（元）').fill(amount);
  return submitTransfer(page, dialog, order.id, prepaid ? '确认付款并结账' : '确认收款并结账', true);
}

async function refund(page: Page, order: ServiceOrder, amount: string | null) {
  const dialog = await openAction(page, order.title, amount === null ? '免单' : '部分退款', amount === null ? '转单免单' : '转单部分退款');
  if (amount !== null) await dialog.getByLabel('最终保留本人收入（元）').fill(amount);
  return submitTransfer(page, dialog, order.id, '确认退款方案', true);
}

async function confirmRefund(page: Page, order: ServiceOrder) {
  const dialog = await openAction(page, order.title, '确认退款');
  return submitTransfer(page, dialog, order.id, '确认已退款', true);
}

async function captureOrder(page: Page, title: string, name: string) {
  const viewport = page.viewportSize()!;
  // The work area scrolls independently. A taller capture keeps the complete expanded
  // transfer record inside that area instead of clipping it at the window's bottom.
  await page.setViewportSize({ width: viewport.width, height: 1800 });
  await orderArticle(page, title).screenshot({ path: `.artifacts/transfer-tests/${name}.png` });
  await page.setViewportSize(viewport);
}

test('护航含炸单进度按50%转出，确认收款前只有预计，撤销后恢复待打', async ({ page }, testInfo) => {
  const fixture = await seedTransferOrder(page, 'escort', '含追加五成护航');
  const before = await fixture.current();
  expect(before.completed_quantity).toBe(600000);
  expect(before.failure_quantity).toBe(200000);
  expect(before.total_quantity).toBe(1200000);
  const dialog = await openTransfer(page, before.title);
  const preview = dialog.getByRole('region', { name: '转单金额预览', exact: true });
  await expect(preview).toContainText('199.60');
  await expect(preview).toContainText('待收下家');
  await testInfo.attach('transfer-preview', { body: await dialog.screenshot({ path: '.artifacts/transfer-tests/preview-dark-desktop.png' }), contentType: 'image/png' });
  const transferred = await submitTransfer(page, dialog, before.id, '确认转单');
  const transfer = transferOf(transferred);
  expect(transferred.status).toBe('archived');
  expect(transfer).toMatchObject({ original_income_cents: 39920, expected_income_cents: 19960, expected_cash_cents: 19960,
    agreed_income_cents: 19960, amount_due_cents: 19960, final_income_cents: null, status: 'pending', cash_events: [] });
  await expect(page.getByRole('region', { name: '进行中订单', exact: true }).getByRole('article')).toHaveCount(0);
  await expect(orderArticle(page, before.title)).toContainText('待收');
  await captureOrder(page, before.title, 'transferred-dark-desktop');
  expect(await fixture.get<Boss>(`/bosses/${fixture.boss.id}`)).toMatchObject({ active_order_count: 0, remaining_amount: 0 });
  const pending = await fixture.analysis();
  expect(pending.income_cents).toBe(0);
  expect(pending.orders).toEqual([expect.objectContaining({ order_id: before.id, income_status: 'pending', income_cents: null })]);

  const cancel = await openAction(page, before.title, '撤销转单');
  const restored = await submitTransfer(page, cancel, before.id, '确认撤销转单', true);
  expect(restored).toMatchObject({ status: 'active', completed_quantity: 600000, failure_quantity: 200000, remaining_quantity: 600000, record_count: 2 });
  expect(transferOf(restored).status).toBe('cancelled');
  await expect(page.getByRole('region', { name: '进行中订单', exact: true }).getByRole('article', { name: `${before.title}订单`, exact: true })).toBeVisible();
  expect(await fixture.get<Boss>(`/bosses/${fixture.boss.id}`)).toMatchObject({ active_order_count: 1, remaining_amount: 600000 });
  expect(fixture.errors).toEqual([]);
});

test('转单弹窗在明暗主题和窄窗口中保持金额与操作可见', async ({ page }) => {
  const fixture = await seedTransferOrder(page, 'escort', '窄窗转单计算');
  await expect(page.getByText('老板资料已保存。', { exact: true })).toHaveCount(0);
  for (const theme of ['dark', 'light'] as const) {
    if (theme === 'light') await page.getByRole('button', { name: '切换至浅色', exact: true }).click();
    for (const width of [960, 375]) {
      await page.setViewportSize({ width: 960, height: 880 });
      const dialog = await openTransfer(page, fixture.order.title);
      await page.setViewportSize({ width, height: 880 });
      await expect(dialog.getByRole('region', { name: '转单金额预览', exact: true })).toContainText('199.60');
      const bounds = await dialog.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
      const overflow = await dialog.evaluate(element => element.scrollWidth - element.clientWidth);
      expect(overflow, `${theme}主题 ${width}px 弹窗横向溢出`).toBeLessThanOrEqual(1);
      if (width === 375) await dialog.screenshot({ path: `.artifacts/transfer-tests/preview-${theme}-${width}-top.png` });
      await dialog.getByRole('button', { name: '确认转单', exact: true }).scrollIntoViewIfNeeded();
      await expect(dialog.getByRole('button', { name: '确认转单', exact: true })).toBeInViewport();
      await dialog.screenshot({ path: `.artifacts/transfer-tests/preview-${theme}-${width}.png` });
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      await expect(dialog).toHaveCount(0);
    }
    await page.setViewportSize({ width: 960, height: 880 });
  }
  const dialog = await openTransfer(page, fixture.order.title);
  await submitTransfer(page, dialog, fixture.order.id, '确认转单');
  await captureOrder(page, fixture.order.title, 'transferred-light-960');
  expect(fixture.errors).toEqual([]);
});

test('单局已有最佳成绩仍默认全转出，协商进度独立于实际打单记录', async ({ page }) => {
  const fixture = await seedTransferOrder(page, 'single_round', '单局协商转出');
  const before = await fixture.current();
  const dialog = await openTransfer(page, before.title);
  const preview = dialog.getByRole('region', { name: '转单金额预览', exact: true });
  await expect(preview).toContainText('0.00');
  await dialog.getByText('协商进度', { exact: true }).click();
  await expect(dialog.getByRole('radio', { name: '协商进度', exact: true })).toBeChecked();
  await dialog.getByLabel('协商进度（%）').fill('25');
  await expect(preview).toContainText('99.80');
  const transferred = await submitTransfer(page, dialog, before.id, '确认转单');
  expect(transferOf(transferred)).toMatchObject({ expected_income_cents: 9980, expected_cash_cents: 9980, status: 'pending', final_income_cents: null });
  expect(transferred).toMatchObject({ best_round_quantity: 600000, completed_quantity: 600000, total_quantity: 1000000, record_count: 1 });
  const settled = await settle(page, before, '80');
  expect(transferOf(settled)).toMatchObject({ final_income_cents: 8000, status: 'settled', amount_due_cents: 0 });
  expect(transferOf(settled).cash_events).toEqual([expect.objectContaining({ kind: 'settlement', direction: 'receipt', amount_cents: 8000 })]);
  expect((await fixture.analysis()).income_cents).toBe(8000);
  await expect(orderArticle(page, before.title).getByRole('button', { name: '撤销转单', exact: true })).toHaveCount(0);
  expect(fixture.errors).toEqual([]);
});

test('未预收款结账后确认收入，部分退款及免单先冲回收入、确认退款才记现金支出', async ({ page }) => {
  const fixture = await seedTransferOrder(page, 'hourly', '转单退款账目');
  const order = fixture.order;
  await submitTransfer(page, await openTransfer(page, order.title), order.id, '确认转单');
  const settled = await settle(page, order, '199.60');
  expect(transferOf(settled).final_income_cents).toBe(19960);
  expect((await fixture.analysis()).income_cents).toBe(19960);
  const reduced = await refund(page, order, '150');
  expect(transferOf(reduced)).toMatchObject({ final_income_cents: 15000, pending_refund_cents: 4960 });
  expect(transferOf(reduced).cash_events).toHaveLength(1);
  expect((await fixture.analysis()).income_cents).toBe(15000);
  const refunded = await confirmRefund(page, order);
  expect(transferOf(refunded).pending_refund_cents).toBe(0);
  expect(transferOf(refunded).cash_events).toEqual([
    expect.objectContaining({ kind: 'settlement', direction: 'receipt', amount_cents: 19960 }),
    expect.objectContaining({ kind: 'refund', direction: 'payment', amount_cents: 4960 }),
  ]);
  expect((await fixture.analysis()).income_cents).toBe(15000);
  const waived = await refund(page, order, null);
  expect(transferOf(waived)).toMatchObject({ final_income_cents: 0, pending_refund_cents: 15000 });
  expect(transferOf(waived).cash_events).toHaveLength(2);
  expect((await fixture.analysis()).income_cents).toBe(0);
  const returned = await confirmRefund(page, order);
  expect(transferOf(returned).pending_refund_cents).toBe(0);
  expect(transferOf(returned).cash_events).toHaveLength(3);
  expect(transferOf(returned).cash_events.at(-1)).toMatchObject({ kind: 'refund', direction: 'payment', amount_cents: 15000 });
  expect(fixture.errors).toEqual([]);
});

test('已预收整份款项按剩余部分付款，少赚只减少本人收益，免单各退自己留下的款', async ({ page }) => {
  const fixture = await seedTransferOrder(page, 'hourly', '预收转单结账');
  const order = fixture.order;
  const dialog = await openTransfer(page, order.title);
  await dialog.getByRole('switch', { name: /^已预收本人整份款项/ }).check();
  await expect(dialog.getByRole('region', { name: '转单金额预览', exact: true })).toContainText('待付下家');
  const transferred = await submitTransfer(page, dialog, order.id, '确认转单');
  expect(transferOf(transferred)).toMatchObject({ original_income_cents: 39920, expected_income_cents: 19960, expected_cash_cents: 19960, final_income_cents: null });
  expect((await fixture.analysis()).income_cents).toBe(0);
  const settled = await settle(page, order, '240', true);
  expect(transferOf(settled)).toMatchObject({ final_income_cents: 15920, pending_refund_cents: 0 });
  expect(transferOf(settled).cash_events).toEqual([expect.objectContaining({ kind: 'settlement', direction: 'payment', amount_cents: 24000 })]);
  expect((await fixture.analysis()).income_cents).toBe(15920);
  const waived = await refund(page, order, null);
  expect(transferOf(waived)).toMatchObject({ final_income_cents: 0, pending_refund_cents: 15920 });
  expect(transferOf(waived).cash_events).toHaveLength(1);
  expect((await fixture.analysis()).income_cents).toBe(0);
  const returned = await confirmRefund(page, order);
  expect(transferOf(returned).cash_events).toEqual([
    expect.objectContaining({ kind: 'settlement', direction: 'payment', amount_cents: 24000 }),
    expect.objectContaining({ kind: 'refund', direction: 'payment', amount_cents: 15920 }),
  ]);
  expect(fixture.errors).toEqual([]);
});

for (const prepaid of [false, true]) {
  test(`${prepaid ? '已预收' : '未预收'}转单未结账即免单，取消应收应付且不会虚记现金`, async ({ page }) => {
    const fixture = await seedTransferOrder(page, 'hourly', prepaid ? '预收未付免单' : '未收转单免单');
    const order = fixture.order;
    const dialog = await openTransfer(page, order.title);
    if (prepaid) await dialog.getByRole('switch', { name: /^已预收本人整份款项/ }).check();
    await submitTransfer(page, dialog, order.id, '确认转单');
    const waived = await refund(page, order, null);
    expect(transferOf(waived)).toMatchObject({ amount_due_cents: 0, final_income_cents: 0, pending_refund_cents: prepaid ? 39920 : 0, cash_events: [] });
    expect((await fixture.analysis()).income_cents).toBe(0);
    await expect(orderArticle(page, order.title).getByRole('button', { name: '确认结账', exact: true })).toHaveCount(0);
    if (prepaid) {
      const returned = await confirmRefund(page, order);
      expect(transferOf(returned).cash_events).toEqual([expect.objectContaining({ kind: 'refund', direction: 'payment', amount_cents: 39920 })]);
    } else {
      await expect(orderArticle(page, order.title).getByRole('button', { name: '确认退款', exact: true })).toHaveCount(0);
    }
    expect(fixture.errors).toEqual([]);
  });
}

for (const ending of ['settle', 'waiver'] as const) {
  test(`已预收未付下家时部分退款分别记欠款，先退后${ending === 'settle' ? '结账不重复扣收益' : '免单只退剩余持款'}`, async ({ page }) => {
    const fixture = await seedTransferOrder(page, 'hourly', ending === 'settle' ? '预收先退后结' : '预收先退后免');
    const order = fixture.order;
    const dialog = await openTransfer(page, order.title);
    await dialog.getByRole('switch', { name: /^已预收本人整份款项/ }).check();
    await submitTransfer(page, dialog, order.id, '确认转单');
    const reduced = await refund(page, order, '150');
    expect(transferOf(reduced)).toMatchObject({ amount_due_cents: 19960, agreed_income_cents: 15000,
      final_income_cents: null, pending_refund_cents: 4960, cash_events: [], status: 'pending' });
    const partiallyReturned = await confirmRefund(page, order);
    expect(transferOf(partiallyReturned)).toMatchObject({ amount_due_cents: 19960, final_income_cents: null, pending_refund_cents: 0, status: 'pending' });
    expect(transferOf(partiallyReturned).cash_events).toEqual([
      expect.objectContaining({ kind: 'refund', direction: 'payment', amount_cents: 4960 }),
    ]);
    const pending = await fixture.analysis();
    expect(pending.income_cents).toBe(0);
    expect(pending.orders).toEqual([expect.objectContaining({ income_status: 'pending', income_cents: null })]);
    if (ending === 'settle') {
      const settled = await settle(page, order, '199.60', true);
      expect(transferOf(settled)).toMatchObject({ amount_due_cents: 0, final_income_cents: 15000, pending_refund_cents: 0 });
      expect(transferOf(settled).cash_events).toEqual([
        expect.objectContaining({ kind: 'refund', direction: 'payment', amount_cents: 4960 }),
        expect.objectContaining({ kind: 'settlement', direction: 'payment', amount_cents: 19960 }),
      ]);
      expect((await fixture.analysis()).income_cents).toBe(15000);
    } else {
      const waived = await refund(page, order, null);
      expect(transferOf(waived)).toMatchObject({ amount_due_cents: 0, final_income_cents: 0, pending_refund_cents: 34960 });
      expect(transferOf(waived).cash_events).toHaveLength(1);
      const returned = await confirmRefund(page, order);
      expect(transferOf(returned).cash_events).toEqual([
        expect.objectContaining({ kind: 'refund', direction: 'payment', amount_cents: 4960 }),
        expect.objectContaining({ kind: 'refund', direction: 'payment', amount_cents: 34960 }),
      ]);
      expect((await fixture.analysis()).income_cents).toBe(0);
    }
    expect(fixture.errors).toEqual([]);
  });
}

test('结账已保存但响应丢失时锁住输入，重试核实沿用同一操作且不重复入账', async ({ page }) => {
  const fixture = await seedTransferOrder(page, 'hourly', '转单结账响应丢失');
  const order = fixture.order;
  await submitTransfer(page, await openTransfer(page, order.title), order.id, '确认转单');
  let attempts = 0;
  const bodies: unknown[] = [];
  await page.route(`**/api/orders/${order.id}/transfer-action`, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    bodies.push(route.request().postDataJSON());
    attempts += 1;
    if (attempts === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      return route.abort('failed');
    }
    if (attempts === 2) return route.fulfill({
      status: 429, json: { error: { code: 'RATE_LIMITED', message: '请稍后核实转单结账。' } },
    });
    return route.continue();
  });
  const dialog = await openAction(page, order.title, '确认结账');
  const amount = dialog.getByLabel('实际收到金额（元）');
  await amount.fill('150');
  await dialog.getByRole('button', { name: '确认收款并结账', exact: true }).click();
  await expect(amount).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  const saved = await fixture.current();
  expect(transferOf(saved).cash_events).toHaveLength(1);
  expect(transferOf(saved).final_income_cents).toBe(15000);
  await dialog.getByRole('button', { name: /重试核实/ }).click();
  await expect(dialog.getByText('请稍后核实转单结账。', { exact: true })).toBeVisible();
  await expect(amount).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: /重试核实/ }).click();
  await expect(dialog).toHaveCount(0);
  expect(bodies).toHaveLength(3);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[2]).toEqual(bodies[0]);
  expect(transferOf(await fixture.current()).cash_events).toHaveLength(1);
  expect((await fixture.analysis()).income_cents).toBe(15000);
  expect(fixture.errors).toEqual([]);
});

test('转单成功后列表刷新尚未返回，立即部分退款仍使用新转单记录', async ({ page }) => {
  const fixture = await seedTransferOrder(page, 'hourly', '刷新延迟转单');
  const order = fixture.order;
  let holdListReads = false;
  let heldReads = 0;
  let releaseReads = () => {};
  const readsGate = new Promise<void>(resolve => { releaseReads = resolve; });
  await page.route('**/api/orders**', async route => {
    const request = route.request();
    if (holdListReads && request.method() === 'GET' && new URL(request.url()).pathname === '/api/orders') {
      heldReads += 1;
      // Keep the real list refresh in flight: the saved order returned by POST must
      // determine the next action, without an old ordinary-refund button resurfacing.
      await readsGate;
    }
    await route.continue();
  });
  try {
    const form = await openTransfer(page, order.title);
    await form.getByRole('switch', { name: /^已预收本人整份款项/ }).check();
    holdListReads = true;
    const saved = await submitTransfer(page, form, order.id, '确认转单');
    expect(transferOf(saved)).toMatchObject({ prepaid: true, expected_income_cents: 19960, status: 'pending' });
    await expect.poll(() => heldReads).toBeGreaterThan(0);
    const partial = await openAction(page, order.title, '部分退款', '转单部分退款');
    await expect(partial.getByRole('region', { name: '转单时约定', exact: true })).toContainText('199.60');
    await expect(page.getByRole('dialog', { name: '部分退款并归档', exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: '已转单订单', exact: true }).getByRole('article', { name: `${order.title}订单`, exact: true })).toBeVisible();
    await partial.getByRole('button', { name: '取消', exact: true }).click();
    await expect(partial).toHaveCount(0);
    expect(fixture.errors).toEqual([]);
  } finally {
    holdListReads = false;
    releaseReads();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
