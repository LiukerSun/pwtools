import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Boss, LedgerEntry, LedgerEntryInput, LedgerPage, MatchRecord, MatchUpdateInput, ServiceOrder } from '../../apps/desktop/src/shared/contracts';
import { confirmRound, openLedger, orderArticle, selectOption } from './ledger-helpers';

test('订单内识别重试失败、关闭保护、草稿恢复及删除失败反馈', async ({ page }) => {
  const ledger = await openLedger(page);
  const navigation = page.getByRole('navigation');
  await expect(navigation.getByRole('button', { name: '战绩记录', exact: true })).toHaveCount(0);
  await expect(navigation.getByRole('button')).toHaveCount(2);
  const boss = await ledger.post<Boss>('/bosses', {
    display_name: '校对测试老板', game_id: 'review-boss', game_name: '校对测试老板', notes: '订单内核对截图。',
  });
  const order = await ledger.post<ServiceOrder>('/bosses/' + boss.id + '/orders', {
    title: '校对故障护航单', kind: 'escort', target_quantity: 3000000,
    failure_default_quantity: 1000000, failure_trigger: 'failed', failure_mode: 'manual', note: '',
  });
  const records: MatchRecord[] = ['识别待恢复.png', '空白截图.png'].map((original_name, index) => ({
    id: randomUUID(), order_id: order.id, failure_extra_amount: 0, fake_amount: null,
    net_amount: null, credited_amount: null, boss_id: boss.id,
    boss_player_name: boss.game_name, original_name, image_content_type: 'image/png',
    image_sha256: 'a'.repeat(64), image_width: 1, image_height: 1, image_size: 68,
    players: [], raw_text: '', warnings: index === 0 ? ['识别服务繁忙，原图已保存，请稍后重新识别。'] : [],
    ocr_status: index === 0 ? 'failed' : 'completed', player_name: boss.game_name,
    outcome: 'unknown', amount: null, confirmed: false, played_at: null, note: '',
    created_at: '2026-10-03T14:00:00Z', updated_at: '2026-10-03T14:00:00Z',
  }));
  let manualEntries = 0;
  let successfulRetries = 0;
  const recognizedText = 'OCR 回归：校对测试老板 撤离成功 1,867,449';
  const currentOrder = (): ServiceOrder => {
    const confirmed = records.filter(record => record.confirmed);
    const completed = confirmed.reduce((total, record) => total + (record.credited_amount || 0), 0);
    const failure = confirmed.reduce((total, record) => total + record.failure_extra_amount, 0);
    return { ...order, completed_quantity: completed, failure_quantity: failure,
      total_quantity: order.target_quantity + failure, remaining_quantity: order.target_quantity + failure - completed,
      record_count: confirmed.length, configuration_locked: true, updated_at: records[0].updated_at };
  };
  await page.route('**/api/orders**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/orders') return route.fulfill({ json: { items: [currentOrder()] } });
    if (url.pathname === '/api/orders/' + order.id) return route.fulfill({ json: currentOrder() });
    if (url.pathname === '/api/orders/' + order.id + '/entries') {
      if (route.request().method() === 'POST') {
        manualEntries += 1;
        return route.fulfill({ status: 400, json: { error: { code: 'INVALID_INPUT', message: '已有原图应更新同场记录。' } } });
      }
      const items: LedgerEntry[] = records.filter(record => record.confirmed).map(record => ({
        id: record.id, order_id: order.id, kind: 'progress', quantity: record.amount || 0,
        amount: record.amount, fake_amount: record.fake_amount, net_amount: record.net_amount,
        credited_amount: record.credited_amount,
        outcome: record.outcome === 'unknown' ? null : record.outcome,
        failure_extra_amount: record.failure_extra_amount, occurred_at: record.played_at || record.created_at,
        note: record.note, source: 'screenshot', match_id: record.id,
      }));
      return route.fulfill({ json: { items, total: items.length, page: 1, page_size: 8 } });
    }
    await route.continue();
  });
  await page.route('**/api/matches**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/matches') {
      expect(url.searchParams.get('order_id')).toBe(order.id);
      expect(url.searchParams.get('confirmed')).toBe('false');
      const items = records.filter(record => !record.confirmed);
      return route.fulfill({ json: { items, total: items.length, page: 1, page_size: 8 } });
    }
    const record = records.find(item => url.pathname.startsWith('/api/matches/' + item.id));
    if (!record) return route.continue();
    if (route.request().method() === 'DELETE') return route.fulfill({
      status: 503, json: { error: { code: 'UNAVAILABLE', message: '服务暂时不可用，请稍后重试。' } },
    });
    if (url.pathname.endsWith('/image')) return route.fulfill({
      contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jqucAAAAASUVORK5CYII=', 'base64'),
    });
    if (url.pathname.endsWith('/recognize')) {
      if (record.id === records[0].id) return route.fulfill({
        status: 503, json: { error: { code: 'OCR_UNAVAILABLE', message: '识别服务仍不可用，请根据原图手工填写。' } },
      });
      successfulRetries += 1;
      Object.assign(record, {
        amount: 1867449, outcome: 'success', ocr_status: 'completed', warnings: [],
        players: [{ player_name: boss.game_name, amount: 1867449, outcome: 'success', confidence: 0.98 }],
        raw_text: recognizedText, updated_at: '2026-10-03T14:03:00Z',
      });
      return route.fulfill({ json: record });
    }
    if (route.request().method() === 'PATCH') {
      const input = route.request().postDataJSON() as MatchUpdateInput;
      const amount = input.amount;
      const fake = input.fake_amount ?? null;
      const net = amount !== null && fake !== null ? amount - fake : null;
      Object.assign(record, input, {
        net_amount: net, credited_amount: input.confirmed ? input.outcome === 'success' ? net : 0 : null,
        failure_extra_amount: input.failure_extra_amount ?? 0, updated_at: '2026-10-03T14:02:00Z',
      });
    }
    return route.fulfill({ json: record });
  });

  await page.getByRole('button', { name: '刷新老板账本', exact: true }).click();
  await page.getByRole('button', { name: '查看校对测试老板订单', exact: true }).click();
  const article = orderArticle(page, order.title);
  await article.getByRole('button', { name: order.title + '场次账本', exact: true }).click();
  const firstDraft = article.getByRole('article', { name: '识别待恢复.png待确认截图', exact: true });
  await firstDraft.getByRole('button', { name: '继续填写', exact: true }).click();
  let correction = page.getByRole('dialog', { name: '校对此场', exact: true });
  await expect(correction.getByText('识别服务繁忙，原图已保存，请稍后重新识别。', { exact: true })).toBeVisible();
  await expect(correction.getByLabel(/^带出金额/)).toHaveValue('');
  await correction.getByLabel(/^带出金额/).fill('1867449');
  await correction.getByLabel(/^假账扣除/).fill('200000');
  await selectOption(page, correction.getByRole('combobox', { name: '撤离结果', exact: true }), '撤离成功');
  await correction.locator('.round-supplement > summary').click();
  await correction.getByLabel('备注', { exact: true }).fill('手工校对仍保留');
  await correction.getByRole('button', { name: '重新识别', exact: true }).click();
  await expect(correction.getByText('识别服务仍不可用，请根据原图手工填写。', { exact: true })).toBeVisible();
  await expect(correction.getByRole('button', { name: '重新识别', exact: true })).toBeEnabled();
  await expect(correction.getByLabel(/^带出金额/)).toHaveValue('1,867,449');
  await expect(correction.getByLabel(/^假账扣除/)).toHaveValue('200,000');
  await expect(correction.getByLabel('备注', { exact: true })).toHaveValue('手工校对仍保留');
  await correction.getByRole('button', { name: '取消', exact: true }).click();
  const guard = page.getByRole('dialog', { name: '尚有未保存结果', exact: true });
  await expect(guard).toBeVisible();
  await guard.getByRole('button', { name: '继续填写', exact: true }).click();
  await expect(correction.getByLabel('备注', { exact: true })).toHaveValue('手工校对仍保留');

  const draftSaved = page.waitForResponse(response => response.url().endsWith('/api/matches/' + records[0].id) && response.request().method() === 'PATCH');
  await correction.getByRole('button', { name: '保存草稿', exact: true }).click();
  expect((await draftSaved).status()).toBe(200);
  await expect(correction).toHaveCount(0);
  expect(records[0].confirmed).toBe(false);
  await firstDraft.getByRole('button', { name: '继续填写', exact: true }).click();
  correction = page.getByRole('dialog', { name: '校对此场', exact: true });
  await expect(correction.getByLabel(/^带出金额/)).toHaveValue('1,867,449');
  await expect(correction.getByLabel(/^假账扣除/)).toHaveValue('200,000');
  await correction.locator('.round-supplement > summary').click();
  await expect(correction.getByLabel('备注', { exact: true })).toHaveValue('手工校对仍保留');
  const confirmed: MatchRecord = await confirmRound(page, correction);
  expect(confirmed.id).toBe(records[0].id);
  expect(confirmed.confirmed).toBe(true);
  expect(manualEntries).toBe(0);
  await expect(firstDraft).toHaveCount(0);
  await expect(article.getByRole('button', { name: '查看此场', exact: true })).toBeVisible();
  await article.getByRole('button', { name: '删除本场截图记录', exact: true }).click();
  const deletion = page.getByRole('dialog', { name: '删除本场截图记录？', exact: true });
  await deletion.getByRole('button', { name: '删除记录', exact: true }).click();
  await expect(deletion.getByText('服务暂时不可用，请稍后重试。', { exact: true })).toBeVisible();
  await expect(deletion.getByRole('button', { name: '删除记录', exact: true })).toBeEnabled();
  await deletion.getByRole('button', { name: '取消', exact: true }).click();
  await expect(article.getByRole('button', { name: '查看此场', exact: true })).toBeVisible();

  const blank = article.getByRole('article', { name: '空白截图.png待确认截图', exact: true });
  await blank.getByRole('button', { name: '继续填写', exact: true }).click();
  correction = page.getByRole('dialog', { name: '校对此场', exact: true });
  await expect(correction.getByLabel(/^带出金额/)).toHaveValue('');
  await expect(correction.getByLabel(/^假账扣除/)).toHaveValue('');
  await expect(correction.getByRole('img', { name: '本场原始战绩截图', exact: true })).toBeVisible();
  await correction.getByRole('button', { name: '确认入账', exact: true }).click();
  await expect(correction.getByText('明确选择撤离成功或失败。', { exact: true })).toBeVisible();
  expect(records[1].confirmed).toBe(false);
  expect(records[1].outcome).toBe('unknown');

  let retried = page.waitForResponse(response => response.url().endsWith('/api/matches/' + records[1].id + '/recognize'));
  await correction.getByRole('button', { name: '重新识别', exact: true }).click();
  expect((await retried).status()).toBe(200);
  await expect(correction.getByLabel(/^带出金额/)).toHaveValue('1,867,449');
  await expect(correction.getByLabel(/^带出金额/)).not.toHaveAttribute('aria-invalid', 'true');
  await expect(correction.getByRole('combobox', { name: '撤离结果', exact: true })).toHaveValue('撤离成功');
  await expect(correction.getByRole('combobox', { name: '撤离结果', exact: true })).not.toHaveAttribute('aria-invalid', 'true');
  await expect(correction.getByLabel(/^假账扣除/)).toHaveValue('');
  await expect(correction.getByLabel(/^假账扣除/)).toHaveAttribute('aria-invalid', 'true');
  await expect(correction.getByRole('img', { name: '本场原始战绩截图', exact: true })).toBeVisible();
  await expect(correction.getByText('识别详情', { exact: true })).toHaveCount(0);
  await expect(correction.getByText('识别文字', { exact: true })).toHaveCount(0);
  await expect(correction.getByText(recognizedText, { exact: true })).toHaveCount(0);

  await correction.getByLabel(/^带出金额/).fill('2000000');
  await correction.getByLabel(/^假账扣除/).fill('100000');
  await selectOption(page, correction.getByRole('combobox', { name: '撤离结果', exact: true }), '撤离失败');
  await correction.locator('.round-supplement > summary').click();
  await correction.getByLabel('备注', { exact: true }).fill('成功识别后保留手工结果');
  retried = page.waitForResponse(response => response.url().endsWith('/api/matches/' + records[1].id + '/recognize'));
  await correction.getByRole('button', { name: '重新识别', exact: true }).click();
  expect((await retried).status()).toBe(200);
  await expect(correction.getByRole('button', { name: '重新识别', exact: true })).toBeEnabled();
  await expect(correction.getByLabel(/^带出金额/)).toHaveValue('2,000,000');
  await expect(correction.getByRole('combobox', { name: '撤离结果', exact: true })).toHaveValue('撤离失败');
  await expect(correction.getByLabel(/^假账扣除/)).toHaveValue('100,000');
  await expect(correction.getByLabel('备注', { exact: true })).toHaveValue('成功识别后保留手工结果');
  expect(successfulRetries).toBe(2);
  expect(records[1].confirmed).toBe(false);
  expect(manualEntries).toBe(0);
  expect(ledger.errors).toEqual([]);
});

test.describe('中文日期与时间选择', () => {
  test.use({ timezoneId: 'UTC' });

  test('点击场次时间文字区域打开日期和时间面板并保存北京时间', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-04T02:00:00Z'));
    const ledger = await openLedger(page);
    const boss = await ledger.post<Boss>('/bosses', {
      display_name: '时间测试老板', game_id: 'date-time-boss', game_name: '', notes: '',
    });
    const order = await ledger.post<ServiceOrder>('/bosses/' + boss.id + '/orders', {
      title: '时间选择小时单', kind: 'hourly', target_quantity: 180,
      failure_default_quantity: 0, note: '',
    });
    await page.getByRole('button', { name: '刷新老板账本', exact: true }).click();
    await page.getByRole('button', { name: '查看时间测试老板订单', exact: true }).click();
    await orderArticle(page, order.title).getByRole('button', { name: '记一场', exact: true }).click();
    const round = page.getByRole('dialog', { name: '记一场', exact: true });
    await round.getByLabel('本次陪玩时长小时', { exact: true }).fill('1');
    await round.getByLabel('本次陪玩时长分钟', { exact: true }).fill('15');
    await round.locator('.round-supplement > summary').click();
    const timeField = round.getByLabel('场次时间', { exact: true });
    const openPicker = async () => {
      const bounds = await timeField.boundingBox();
      expect(bounds).not.toBeNull();
      // Click the text area, away from both the calendar icon and the clear control.
      await timeField.click({ position: { x: bounds!.width / 2, y: bounds!.height / 2 } });
    };
    await openPicker();
    const picker = page.getByRole('dialog', { name: '选择场次时间', exact: true });
    await expect(picker).toBeVisible();
    await expect(picker.getByRole('button', { name: '确定时间', exact: true })).toBeVisible();
    const chooseTime = async () => {
      await picker.getByRole('button', { name: '2026年10月3日', exact: true }).click();
      await picker.getByLabel('小时', { exact: true }).fill('22');
      await picker.getByLabel('分钟', { exact: true }).fill('00');
      await picker.getByRole('button', { name: '确定时间', exact: true }).click();
      await expect(picker).toBeHidden();
      await expect(timeField).toHaveText(/2026.+10.+0?3.+22:00/);
    };
    await chooseTime();

    await openPicker();
    await expect(picker).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();
    await expect(round).toBeVisible();
    await expect(page.getByRole('dialog', { name: '尚有未保存结果', exact: true })).toHaveCount(0);
    await expect(round.getByLabel('本次陪玩时长分钟', { exact: true })).toHaveValue('15');

    await round.getByRole('button', { name: '清空场次时间', exact: true }).click();
    await expect(timeField).not.toContainText('2026');
    await expect(round.getByRole('button', { name: '清空场次时间', exact: true })).toBeHidden();
    await openPicker();
    await expect(picker).toBeVisible();
    await chooseTime();
    await round.getByLabel('备注', { exact: true }).fill('北京时间 10 月 3 日 22 点，75 分钟');

    let releaseSave!: () => void;
    const heldResponse = new Promise<void>(resolve => { releaseSave = resolve; });
    const entryPath = '/api/orders/' + order.id + '/entries';
    await page.route('**' + entryPath, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const input = route.request().postDataJSON() as LedgerEntryInput;
      expect(input.quantity).toBe(75);
      expect(input.occurred_at).toBe('2026-10-03T14:00:00.000Z');
      const response = await route.fetch();
      await heldResponse;
      await route.fulfill({ response });
    });
    const saved = page.waitForResponse(response => response.url().endsWith(entryPath) && response.request().method() === 'POST');
    await round.getByRole('button', { name: '确认入账', exact: true }).click();
    try {
      await expect(round.getByRole('button', { name: '确认入账', exact: true })).toBeDisabled();
      await expect(round.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
      await expect(timeField).toBeDisabled();
      await expect(round.getByLabel('本次陪玩时长分钟', { exact: true })).toBeDisabled();
    } finally {
      releaseSave();
    }
    const response = await saved;
    expect(response.status()).toBe(201);
    const entry: LedgerEntry = await response.json();
    expect(entry.quantity).toBe(75);
    expect(new Date(entry.occurred_at).toISOString()).toBe('2026-10-03T14:00:00.000Z');
    await expect(round).toHaveCount(0);
    const stored = await ledger.get<LedgerPage>('/orders/' + order.id + '/entries');
    expect(stored.items).toHaveLength(1);
    expect(stored.items[0].id).toBe(entry.id);
    expect(new Date(stored.items[0].occurred_at).toISOString()).toBe('2026-10-03T14:00:00.000Z');
    expect((await ledger.get<ServiceOrder>('/orders/' + order.id)).remaining_quantity).toBe(105);
    expect(ledger.errors).toEqual([]);
  });
});
