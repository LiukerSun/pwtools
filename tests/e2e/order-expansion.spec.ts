import { expect, test, type Page } from '@playwright/test';
import type { Boss, MatchRecord, OrderKind, ServiceOrder } from '../../apps/desktop/src/shared/contracts';
import { orderArticle } from './ledger-helpers';

const bossId = '11111111-1111-4111-8111-111111111111';
const orderId = '22222222-2222-4222-8222-222222222222';
const followingId = '33333333-3333-4333-8333-333333333333';
const timestamp = '2026-10-04T02:00:00Z';
const responseTimings: { name: string; delay: number; draftDelay?: number }[] = [
  { name: '响应立即返回', delay: 0 },
  { name: '响应在展开中返回', delay: 90 },
  { name: '响应在展开完成后返回', delay: 400 },
  { name: '流水先返回，截图在展开完成后返回', delay: 0, draftDelay: 400 },
];

function emptyOrder(kind: OrderKind): ServiceOrder {
  const quantity = kind === 'hourly' ? 120 : 1000000;
  return {
    id: orderId, boss_id: bossId, boss_name: '未开局老板', boss_game_name: '未开局老板',
    title: '尚未开局订单', kind, target_quantity: quantity, failure_default_quantity: 0,
    failure_trigger: 'failed', failure_standard_quantity: 0, failure_mode: 'manual',
    wager_item_id: null, wager_item_name: '', wager_expected: 'obtained', wager_condition: 'appearance',
    note: '', configuration_locked: false, best_round_quantity: 0, settlement_result: null,
    completed_quantity: 0, failure_quantity: 0, adjustment_quantity: 0, total_quantity: quantity,
    remaining_quantity: quantity, excess_quantity: 0, status: 'active', record_count: 0,
    created_at: '2026-10-04T02:01:00Z', updated_at: timestamp,
  };
}

async function openMockLedger(page: Page, kind: OrderKind, options: { drafts?: MatchRecord[]; failDraftsOnce?: boolean } = {}) {
  const order = emptyOrder(kind);
  const following = { ...order, id: followingId, title: '后续订单', created_at: timestamp };
  const boss: Boss = {
    id: bossId, display_name: '未开局老板', game_id: 'empty-history', game_name: '未开局老板', notes: '',
    active_order_count: 2, remaining_minutes: kind === 'hourly' ? 240 : 0,
    remaining_amount: kind === 'escort' ? 2000000 : 0,
    pending_single_round_count: 0, pending_wager_count: 0, created_at: timestamp, updated_at: timestamp,
  };
  const errors: string[] = [];
  const unexpectedRequests: string[] = [];
  const historyRequests = new Set<string>();
  const expectedHistoryRequests = kind === 'hourly' ? 1 : 2;
  let releaseEntries = () => {};
  const entriesGate = new Promise<void>(resolve => { releaseEntries = resolve; });
  let releaseDrafts = () => {};
  const draftsGate = new Promise<void>(resolve => { releaseDrafts = resolve; });
  const releaseHistory = () => { releaseEntries(); releaseDrafts(); };
  let draftRequests = 0;
  let historyRequested = () => {};
  const requested = new Promise<void>(resolve => { historyRequested = resolve; });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const { pathname } = new URL(route.request().url());
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const fulfill = (json: unknown) => route.fulfill({ json, headers });
    if (pathname === '/api/health') return fulfill({ status: 'ok', database: 'connected' });
    if (pathname === '/api/auth/login') return fulfill({
      token: 'mock-layout-session', user: { id: bossId, email: 'layout@example.test', created_at: timestamp },
    });
    if (pathname === '/api/bosses') return fulfill({ items: [boss] });
    if (pathname === `/api/bosses/${bossId}`) return fulfill(boss);
    if (pathname === '/api/orders') return fulfill({ items: [order, following] });
    if (pathname === `/api/orders/${orderId}/entries` || pathname === '/api/matches') {
      historyRequests.add(pathname);
      if (historyRequests.size === expectedHistoryRequests) historyRequested();
      if (pathname === '/api/matches') {
        draftRequests += 1;
        await draftsGate;
        if (options.failDraftsOnce && draftRequests === 1) return route.fulfill({
          status: 503, headers, json: { error: { code: 'UNAVAILABLE', message: '截图加载暂时失败，请重试。' } },
        });
        const items = options.drafts || [];
        return fulfill({ items, total: items.length, page: 1, page_size: 8 });
      }
      await entriesGate;
      return fulfill({ items: [], total: 0, page: 1, page_size: 8 });
    }
    unexpectedRequests.push(`${route.request().method()} ${pathname}`);
    return route.fulfill({ status: 500, headers, json: { error: { code: 'UNEXPECTED_REQUEST', message: '未配置的测试请求' } } });
  });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  await page.getByLabel(/^邮箱/).fill('layout@example.test');
  await page.getByLabel(/^密码/).fill('Layout-test-2026!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '查看未开局老板订单', exact: true }).click();
  await expect(orderArticle(page, order.title)).toBeVisible();
  await expect(orderArticle(page, following.title)).toBeVisible();
  return { order, following, releaseHistory, releaseEntries, releaseDrafts, requested, errors, unexpectedRequests };
}

async function waitAnimationFrames(page: Page, duration: number) {
  await page.evaluate(delay => new Promise<void>(resolve => {
    const start = performance.now();
    const tick = () => performance.now() - start >= delay ? resolve() : requestAnimationFrame(tick);
    requestAnimationFrame(tick);
  }), duration);
}

for (const kind of ['hourly', 'escort'] as const) {
  for (const timing of responseTimings) {
    if (kind === 'hourly' && timing.draftDelay !== undefined) continue;
    test(`${kind === 'hourly' ? '小时单' : '护航单'}无场次展开不会回弹：${timing.name}`, async ({ page }, testInfo) => {
      const ledger = await openMockLedger(page, kind);
      const draftDelay = timing.draftDelay ?? timing.delay;
      if (timing.delay === 0) ledger.releaseEntries();
      if (draftDelay === 0) ledger.releaseDrafts();
      // Sampling and clicking in the same browser task captures every rendered frame,
      // including the frame where an empty response replaces its loading state.
      const sampling = page.evaluate(({ title, followingTitle }) => new Promise<{ time: number; offset: number }[]>(resolve => {
        const article = document.querySelector<HTMLElement>(`article[aria-label="${title}订单"]`)!;
        const following = document.querySelector<HTMLElement>(`article[aria-label="${followingTitle}订单"]`)!;
        const button = article.querySelector<HTMLButtonElement>('.ledger-order-row-main')!;
        const start = performance.now();
        const samples: { time: number; offset: number }[] = [];
        const sample = () => samples.push({
          time: performance.now() - start,
          offset: following.getBoundingClientRect().top - article.getBoundingClientRect().top,
        });
        sample();
        button.click();
        const tick = () => {
          sample();
          if (performance.now() - start >= 1000) resolve(samples);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }), { title: ledger.order.title, followingTitle: ledger.following.title });
      await ledger.requested;
      await Promise.all([
        timing.delay > 0 ? waitAnimationFrames(page, timing.delay).then(ledger.releaseEntries) : Promise.resolve(),
        draftDelay > 0 ? waitAnimationFrames(page, draftDelay).then(ledger.releaseDrafts) : Promise.resolve(),
      ]);
      const samples = await sampling;
      const article = orderArticle(page, ledger.order.title);
      await expect(article.getByText('暂无记录', { exact: true })).toBeVisible();
      await expect(article.getByRole('region', { name: '待确认截图', exact: true })).toHaveCount(0);
      let peak = samples[0].offset;
      let rebound = 0;
      for (const sample of samples) {
        peak = Math.max(peak, sample.offset);
        rebound = Math.max(rebound, peak - sample.offset);
      }
      const measurement = { kind, responseDelay: timing.delay, draftResponseDelay: draftDelay, initialOffset: samples[0].offset,
        peakOffset: peak, finalOffset: samples.at(-1)!.offset, rebound, frames: samples.length };
      await testInfo.attach('expansion-frames', { body: JSON.stringify({ measurement, samples }, null, 2), contentType: 'application/json' });
      expect(samples.length).toBeGreaterThan(15);
      expect(measurement.finalOffset).toBeGreaterThan(measurement.initialOffset + 20);
      expect(rebound, `订单展开后回弹的像素数：${JSON.stringify(measurement)}`).toBeLessThanOrEqual(1);
      expect(ledger.errors).toEqual([]);
      expect(ledger.unexpectedRequests).toEqual([]);
    });
  }
}

test('护航订单展开后显示已有待确认截图和继续填写入口', async ({ page }) => {
  const draft: MatchRecord = {
    id: '44444444-4444-4444-8444-444444444444', order_id: orderId, boss_id: bossId,
    boss_player_name: '未开局老板', original_name: '尚未确认.png', image_content_type: 'image/png',
    image_sha256: 'a'.repeat(64), image_width: 1, image_height: 1, image_size: 68,
    players: [], raw_text: '', warnings: [], ocr_status: 'completed', player_name: '未开局老板',
    outcome: 'unknown', amount: null, fake_amount: null, net_amount: null, credited_amount: null,
    item_obtained: null, failure_extra_amount: 0, confirmed: false, played_at: null, note: '',
    created_at: timestamp, updated_at: timestamp,
  };
  const ledger = await openMockLedger(page, 'escort', { drafts: [draft] });
  ledger.releaseHistory();
  const article = orderArticle(page, ledger.order.title);
  await article.getByRole('button', { name: `${ledger.order.title}场次账本`, exact: true }).click();
  const drafts = article.getByRole('region', { name: '待确认截图', exact: true });
  await expect(drafts).toBeVisible();
  await expect(drafts.getByRole('article', { name: '尚未确认.png待确认截图', exact: true })).toBeVisible();
  await expect(drafts.getByRole('button', { name: '继续填写', exact: true })).toBeVisible();
  await expect(drafts.getByRole('button', { name: '继续填写', exact: true })).toBeEnabled();
  await expect(article.getByText('暂无记录', { exact: true })).toBeVisible();
  expect(ledger.errors).toEqual([]);
  expect(ledger.unexpectedRequests).toEqual([]);
});

test('待确认截图失败可重试，空结果移除错误区并保留暂无记录', async ({ page }) => {
  const ledger = await openMockLedger(page, 'escort', { failDraftsOnce: true });
  ledger.releaseHistory();
  const article = orderArticle(page, ledger.order.title);
  await article.getByRole('button', { name: `${ledger.order.title}场次账本`, exact: true }).click();
  const drafts = article.getByRole('region', { name: '待确认截图', exact: true });
  await expect(drafts.getByText('待确认截图未加载', { exact: true })).toBeVisible();
  await expect(drafts).toContainText('截图加载暂时失败，请重试。');
  const retry = drafts.getByRole('button', { name: '重新加载截图', exact: true });
  await expect(retry).toBeVisible();
  await expect(article.getByText('暂无记录', { exact: true })).toBeVisible();
  await retry.click();
  await expect(drafts).toHaveCount(0);
  await expect(article.getByText('暂无记录', { exact: true })).toBeVisible();
  expect(ledger.errors).toEqual([]);
  expect(ledger.unexpectedRequests).toEqual([]);
});
