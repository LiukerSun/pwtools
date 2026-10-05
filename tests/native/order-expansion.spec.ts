import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import type { AppInfo, Boss, DesktopBridge, OrderKind, ServiceOrder } from '../../apps/desktop/src/shared/contracts';
import { NativeApplication } from './native-helpers';

const bossId = '11111111-1111-4111-8111-111111111111';
const orderId = '22222222-2222-4222-8222-222222222222';
const followingId = '33333333-3333-4333-8333-333333333333';
const timestamp = '2026-10-04T02:00:00Z';

function emptyOrder(kind: OrderKind): ServiceOrder {
  const quantity = kind === 'hourly' ? 120 : 1000000;
  return {
    id: orderId, boss_id: bossId, boss_name: '未开局老板', boss_game_name: '未开局老板',
    title: '尚未开局订单', kind, target_quantity: quantity, failure_default_quantity: 0,
    failure_trigger: 'failed', failure_standard_quantity: 0, failure_mode: 'manual',
    note: '', configuration_locked: false, best_round_quantity: 0,
    completed_quantity: 0, failure_quantity: 0, adjustment_quantity: 0, total_quantity: quantity,
    remaining_quantity: quantity, excess_quantity: 0, status: 'active', record_count: 0,
    created_at: '2026-10-04T02:01:00Z', updated_at: timestamp,
  };
}

for (const kind of ['hourly', 'escort'] as const) {
  test(`打包版${kind === 'hourly' ? '小时单' : '护航单'}空历史展开不会回弹`, async ({}, testInfo) => {
    test.setTimeout(90_000);
    const directory = await mkdtemp(join(tmpdir(), 'pwtools-native-expansion-'));
    let app: NativeApplication | undefined;
    try {
      // A temporary profile and unreachable API prevent access to real accounts or data.
      app = await NativeApplication.launch(directory, 'http://127.0.0.1:1/api');
      const page = app.page;
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const runtime = await page.evaluate(() => window.pwtools!.appInfo()) as AppInfo & { runtime?: string };
      const expectedVersion = JSON.parse(await readFile(resolve('apps/desktop/package.json'), 'utf8')).version;
      expect(runtime.version).toBe(expectedVersion);
      expect(runtime.runtime).toBe('webview2');
      await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();

      const order = emptyOrder(kind);
      const following = { ...order, id: followingId, title: '后续订单', created_at: timestamp };
      const boss: Boss = {
        id: bossId, display_name: '未开局老板', game_id: 'empty-history', game_name: '未开局老板', notes: '',
        active_order_count: 2, remaining_minutes: kind === 'hourly' ? 240 : 0,
        remaining_amount: kind === 'escort' ? 2000000 : 0,
        pending_single_round_count: 0, created_at: timestamp, updated_at: timestamp,
      };
      await page.evaluate(({ boss, order, following, runtime, timestamp }) => {
        const bridge = window.pwtools!;
        const state = { unexpected: [] as string[], entries: [] as string[], matches: [] as string[] };
        (window as Window & { expansionRequests?: typeof state }).expansionRequests = state;
        // Preserve native window controls and read-only update status; guard every ledger method.
        for (const method of Object.keys(bridge)) {
          if (['windowControl', 'onCloseRequested', 'onExitRequested', 'onImportRequested', 'setImportHotkey', 'getUpdateState'].includes(method)) continue;
          (bridge as unknown as Record<string, unknown>)[method] = async () => {
            state.unexpected.push(method);
            throw new Error(`未配置的原生测试请求：${method}`);
          };
        }
        const user = { id: boss.id, email: 'layout@example.test', created_at: timestamp };
        const delay = () => new Promise<void>(done => setTimeout(done, 400));
        Object.assign(bridge, {
          health: async () => ({ status: 'ok', database: 'connected' }),
          me: async () => user,
          login: async () => user,
          appInfo: async () => runtime,
          listBosses: async () => ({ items: [boss] }),
          getBoss: async () => boss,
          listOrders: async () => ({ items: [order, following] }),
          listLedgerEntries: async (id: string) => {
            state.entries.push(id);
            await delay();
            return { items: [], total: 0, page: 1, page_size: 8 };
          },
          listMatches: async (_page?: number, _size?: number, id?: string) => {
            state.matches.push(id || '');
            await delay();
            return { items: [], total: 0, page: 1, page_size: 8 };
          },
        } satisfies Partial<DesktopBridge>);
      }, { boss, order, following, runtime, timestamp });
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.getByLabel(/^邮箱/).fill('layout@example.test');
      await page.getByLabel(/^密码/).fill('Layout-test-2026!');
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await page.getByRole('button', { name: '查看未开局老板订单', exact: true }).click();
      const article = page.getByRole('article', { name: `${order.title}订单`, exact: true });
      await expect(article).toBeVisible();
      await expect(page.getByRole('article', { name: `${following.title}订单`, exact: true })).toBeVisible();

      // Measure relative offsets so viewport scrolling cannot hide a content rebound.
      const samples = await page.evaluate(({ title, followingTitle }) => new Promise<{ time: number; offset: number }[]>(done => {
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
          if (performance.now() - start >= 1000) done(samples);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }), { title: order.title, followingTitle: following.title });
      await expect(article.getByText('暂无记录', { exact: true })).toBeVisible();
      await expect(article.getByRole('region', { name: '待确认截图', exact: true })).toHaveCount(0);
      let peak = samples[0].offset;
      let rebound = 0;
      for (const sample of samples) {
        peak = Math.max(peak, sample.offset);
        rebound = Math.max(rebound, peak - sample.offset);
      }
      const measurement = { version: runtime.version, runtime: runtime.runtime, kind, responseDelay: 400,
        initialOffset: samples[0].offset, peakOffset: peak, finalOffset: samples.at(-1)!.offset,
        rebound, frames: samples.length };
      const measurementPath = testInfo.outputPath('expansion-frames.json');
      await writeFile(measurementPath, JSON.stringify({ measurement, samples }, null, 2));
      await testInfo.attach('native-expansion-frames', { path: measurementPath, contentType: 'application/json' });
      expect(samples.length).toBeGreaterThan(15);
      expect(measurement.finalOffset).toBeGreaterThan(measurement.initialOffset + 20);
      expect(rebound, `打包版订单展开回弹像素数：${JSON.stringify(measurement)}`).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => (window as Window & {
        expansionRequests?: { unexpected: string[]; entries: string[]; matches: string[] };
      }).expansionRequests)).toEqual({ unexpected: [], entries: [orderId], matches: kind === 'escort' ? [orderId] : [] });
      expect(errors).toEqual([]);
    } finally {
      await app?.close().catch(() => {});
      const target = resolve(directory).toLowerCase();
      if (!target.startsWith(resolve(tmpdir()).toLowerCase() + sep) || !basename(target).startsWith('pwtools-native-expansion-')) {
        throw new Error('临时目录范围校验失败，未删除任何目录');
      }
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
  });
}
