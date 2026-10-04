import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Boss, LedgerEntry, ServiceOrder } from '../../apps/desktop/src/shared/contracts';
import { addBoss, confirmRound, createOrder, openLedger, openOrderAction, openRound, orderArticle, selectOption } from './ledger-helpers';

async function openPrivateLedger(page: Page) {
  const ledger = await openLedger(page);
  const boss = await addBoss(page, '四类订单老板');
  await expect(page.getByRole('region', { name: '老板详情与订单', exact: true })).toBeVisible();
  return { ...ledger, boss };
}

async function showCompletedOrders(page: Page) {
  const completed = page.getByRole('button', { name: /^已完成\s*\d+/ });
  await expect(completed).toBeVisible();
  if (await completed.getAttribute('aria-expanded') !== 'true') await completed.click();
}

test('四种订单配置、目录和手填物品、人工对赌结算分别保存', async ({ page }) => {
  test.setTimeout(150_000);
  const ledger = await openPrivateLedger(page);
  const hourly = await createOrder(page, '两小时十五分钟陪玩', 'hourly', async (form) => {
    await form.getByLabel('约定陪玩时长小时').fill('2');
    await form.getByLabel('约定陪玩时长分钟').fill('15');
  });
  expect(hourly.kind).toBe('hourly');
  expect(hourly.remaining_quantity).toBe(135);
  const escort = await createOrder(page, '累计护航', 'escort', async (form) => {
    await form.getByLabel('约定带出金额（哈夫币）').fill('2000000');
    await form.getByRole('button', { name: /^高级约定与备注/ }).click();
    await selectOption(page, form.getByRole('combobox', { name: '追加触发条件', exact: true }), '撤离失败且净值低于标准');
    await form.getByLabel('追加触发净值标准（哈夫币）').fill('500000');
    await selectOption(page, form.getByRole('combobox', { name: '追加计算方式', exact: true }), '补足标准与净值的差额');
  });
  expect(escort.failure_trigger).toBe('failed_below_standard');
  expect(escort.failure_mode).toBe('shortfall');
  const single = await createOrder(page, '单场一百万', 'single_round', async (form) => {
    await form.getByLabel('单场净带出目标（哈夫币）').fill('1000000');
    await expect(form.getByRole('combobox', { name: '追加计算方式', exact: true })).toHaveCount(0);
  });
  expect(single.kind).toBe('single_round');
  const wager = await createOrder(page, '海洋之泪没出我赢', 'wager', async (form) => {
    await form.getByLabel('搜索对赌物品').fill('海洋之泪');
    await selectOption(page, form.getByRole('combobox', { name: '物品分类', exact: true }), '收集品');
    await form.getByRole('button', { name: /^海洋之泪/ }).click();
    await expect(form).toContainText('已选：海洋之泪');
    await selectOption(page, form.getByRole('combobox', { name: '我方获胜条件', exact: true }), '物品未出现');
  });
  expect(wager.wager_item_id).toBe('15080050142');
  expect(wager.wager_item_name).toBe('海洋之泪');
  expect(wager.wager_expected).toBe('not_obtained');
  const custom = await createOrder(page, '手填对赌物品', 'wager', async (form) => {
    await form.locator('label').filter({ hasText: '手动填写物品' }).click();
    await form.getByLabel('自定义物品名称').fill('目录之外的指定物品');
    await selectOption(page, form.getByRole('combobox', { name: '对赌判断依据', exact: true }), '本场物品是否成功带出');
    await selectOption(page, form.getByRole('combobox', { name: '我方获胜条件', exact: true }), '未成功带出物品');
  });
  expect(custom.wager_item_id).toBeNull();
  expect(custom.wager_item_name).toBe('目录之外的指定物品');
  expect(custom.wager_condition).toBe('extracted');
  expect(custom.wager_expected).toBe('not_obtained');

  const before = await ledger.get<Boss>(`/bosses/${ledger.boss.id}`);
  const form = await openRound(page, wager.title);
  await expect(form.getByLabel('假账扣除（哈夫币）')).toHaveCount(0);
  await expect(form.getByRole('combobox', { name: /^本场物品是否出现/ })).toHaveValue('');
  await selectOption(page, form.getByRole('combobox', { name: /^本场物品是否出现/ }), '未出现');
  const result: LedgerEntry = await confirmRound(page, form);
  expect(result.item_obtained).toBe(false);
  const settled = await ledger.get<ServiceOrder>(`/orders/${wager.id}`);
  expect(settled.status).toBe('completed');
  expect(settled.settlement_result).toBe('won');
  await showCompletedOrders(page);
  const article = orderArticle(page, wager.title);
  await expect(article).toContainText('已赢');
  await expect(article.getByRole('button', { name: '记一场', exact: true })).toBeDisabled();
  const after = await ledger.get<Boss>(`/bosses/${ledger.boss.id}`);
  expect(after.remaining_amount).toBe(before.remaining_amount);
  expect(after.remaining_minutes).toBe(before.remaining_minutes);
  expect(after.pending_wager_count).toBe(before.pending_wager_count - 1);
  await page.getByRole('button', { name: '返回所有老板', exact: true }).click();
  const row = page.getByRole('row', { name: '四类订单老板老板汇总', exact: true });
  await expect(row).toContainText('2,000,000 哈夫币');
  await expect(row).toContainText('2 小时 15 分钟');
  await expect(row).toContainText('单局待达标');
  expect(ledger.errors).toEqual([]);
});

test('假账必须明确填写，护航按净值追加，已有流水锁规则但保留备注修改', async ({ page }) => {
  test.setTimeout(120_000);
  const ledger = await openPrivateLedger(page);
  const order = await createOrder(page, '条件护航', 'escort', async (form) => {
    await form.getByLabel('约定带出金额（哈夫币）').fill('1000000');
    await form.getByRole('button', { name: /^高级约定与备注/ }).click();
    await selectOption(page, form.getByRole('combobox', { name: '追加触发条件', exact: true }), '任意结果净值低于标准');
    await form.getByLabel('追加触发净值标准（哈夫币）').fill('500000');
    await selectOption(page, form.getByRole('combobox', { name: '追加计算方式', exact: true }), '追加固定金额');
    await form.getByLabel('触发后固定追加（哈夫币）').fill('100000');
  });
  let form = await openRound(page, order.title);
  await form.getByLabel('带出金额（哈夫币）').fill('400000');
  const fake = form.getByLabel('假账扣除（哈夫币）');
  await expect(fake).toHaveValue('');
  await expect(fake).toHaveAttribute('required', '');
  await form.getByRole('button', { name: '确认入账', exact: true }).click();
  await expect(form).toBeVisible();
  await expect(form.getByText('明确填写假账扣除，0 表示没有假账，扣除不能大于原值。', { exact: true })).toBeVisible();
  expect((await ledger.get<ServiceOrder>(`/orders/${order.id}`)).record_count).toBe(0);
  await fake.fill('400001');
  await form.getByRole('button', { name: '确认入账', exact: true }).click();
  await expect(form.getByText('明确填写假账扣除，0 表示没有假账，扣除不能大于原值。', { exact: true })).toBeVisible();
  await fake.fill('100000');
  const preview = form.getByRole('region', { name: '本场净值', exact: true });
  await expect(preview.locator('strong').last()).toHaveText('300,000');
  await expect(form).toContainText('本场预计追加 100,000 哈夫币');
  const success: LedgerEntry = await confirmRound(page, form);
  expect(success.amount).toBe(400000);
  expect(success.fake_amount).toBe(100000);
  expect(success.net_amount).toBe(300000);
  expect(success.credited_amount).toBe(300000);
  expect(success.failure_extra_amount).toBe(100000);
  let current = await ledger.get<ServiceOrder>(`/orders/${order.id}`);
  expect(current.remaining_quantity).toBe(800000);

  form = await openRound(page, order.title);
  await selectOption(page, form.getByRole('combobox', { name: '撤离结果', exact: true }), '撤离失败');
  await form.getByLabel('带出金额（哈夫币）').fill('700000');
  await form.getByLabel('假账扣除（哈夫币）').fill('300000');
  const failed: LedgerEntry = await confirmRound(page, form);
  expect(failed.amount).toBe(700000);
  expect(failed.net_amount).toBe(400000);
  expect(failed.credited_amount).toBe(0);
  expect(failed.failure_extra_amount).toBe(100000);
  current = await ledger.get<ServiceOrder>(`/orders/${order.id}`);
  expect(current.completed_quantity).toBe(300000);
  expect(current.failure_quantity).toBe(200000);
  expect(current.remaining_quantity).toBe(900000);

  await openOrderAction(page, order.title, '订单配置');
  const config = page.getByRole('dialog', { name: '订单配置', exact: true });
  await expect(config.getByText('约定已锁定', { exact: true })).toBeVisible();
  for (const kind of ['小时单', '护航单', '单局单', '对赌单']) await expect(config.getByRole('radio', { name: kind, exact: true })).toBeDisabled();
  await expect(config.getByLabel('约定带出金额（哈夫币）')).toBeDisabled();
  const advanced = config.getByRole('button', { name: /^高级约定与备注/ });
  if (await advanced.getAttribute('aria-expanded') !== 'true') await advanced.click();
  await expect(config.getByRole('combobox', { name: '追加触发条件', exact: true })).toBeDisabled();
  await expect(config.getByRole('combobox', { name: '追加计算方式', exact: true })).toBeDisabled();
  await expect(config.getByLabel('追加触发净值标准（哈夫币）')).toBeDisabled();
  await expect(config.getByLabel('触发后固定追加（哈夫币）')).toBeEnabled();
  await config.getByLabel('订单名称').fill('条件护航备注已改');
  await config.getByLabel('订单备注').fill('历史两场的追加量保持不变。');
  await config.getByLabel('触发后固定追加（哈夫币）').fill('200000');
  await config.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(config).toHaveCount(0);
  current = await ledger.get<ServiceOrder>(`/orders/${order.id}`);
  expect(current.title).toBe('条件护航备注已改');
  expect(current.note).toBe('历史两场的追加量保持不变。');
  expect(current.configuration_locked).toBe(true);
  expect(current.failure_default_quantity).toBe(200000);
  expect(current.failure_quantity).toBe(200000);
  expect(current.remaining_quantity).toBe(900000);
  const article = orderArticle(page, '条件护航备注已改');
  await expect(article).toContainText('900,000 哈夫币');
  const history = article.getByRole('button', { name: '条件护航备注已改场次账本', exact: true });
  if (await history.getAttribute('aria-expanded') !== 'true') await history.click();
  await expect(article).toContainText('原值 400,000 − 假账 100,000 = 净值 300,000');
  await expect(article).toContainText('原值 700,000 − 假账 300,000 = 净值 400,000');
  expect(ledger.errors).toEqual([]);
});

test('单局两场六十万保留完整目标，只有一场净值达标才完成', async ({ page }) => {
  test.setTimeout(90_000);
  const ledger = await openPrivateLedger(page);
  const order = await createOrder(page, '单局独立达标', 'single_round', async (form) => {
    await form.getByLabel('单场净带出目标（哈夫币）').fill('1000000');
  });
  for (let index = 0; index < 2; index++) {
    await ledger.post<LedgerEntry>(`/orders/${order.id}/entries`, {
      kind: 'progress', quantity: 600000, amount: 600000, fake_amount: 0, outcome: 'success',
      failure_extra_amount: 0, occurred_at: null, note: `第 ${index + 1} 场六十万`, idempotency_key: randomUUID(),
    });
  }
  await page.getByRole('button', { name: '刷新老板订单', exact: true }).click();
  const article = orderArticle(page, order.title);
  await expect(article).toContainText('待单场达标');
  await expect(article).toContainText('单场目标 1,000,000 哈夫币');
  await expect(article).toContainText('最佳单场 600,000 哈夫币');
  const twoRounds = await ledger.get<ServiceOrder>(`/orders/${order.id}`);
  expect(twoRounds.status).toBe('active');
  expect(twoRounds.record_count).toBe(2);
  expect(twoRounds.best_round_quantity).toBe(600000);
  expect(twoRounds.completed_quantity).toBe(600000);
  expect(twoRounds.remaining_quantity).toBe(1000000);
  await article.getByRole('button', { name: `${order.title}更多操作`, exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '调整约定', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  const form = await openRound(page, order.title);
  await form.getByLabel('带出金额（哈夫币）').fill('1200000');
  await form.getByLabel('假账扣除（哈夫币）').fill('100000');
  await expect(form).toContainText('本场达标');
  await confirmRound(page, form);
  await showCompletedOrders(page);
  await expect(article).toContainText('已达标');
  await expect(article).toContainText('最佳单场 1,100,000 哈夫币');
  const completed = await ledger.get<ServiceOrder>(`/orders/${order.id}`);
  expect(completed.status).toBe('completed');
  expect(completed.best_round_quantity).toBe(1100000);
  expect(completed.completed_quantity).toBe(1100000);
  expect(completed.remaining_quantity).toBe(0);
  expect((await ledger.get<Boss>(`/bosses/${ledger.boss.id}`)).remaining_amount).toBe(0);
  expect(ledger.errors).toEqual([]);
});
