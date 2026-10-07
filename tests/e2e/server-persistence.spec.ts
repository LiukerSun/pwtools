import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AuthResponse, Boss, LedgerEntry, LedgerPage, OrderTemplate, ServiceOrder, User } from '../../apps/desktop/src/shared/contracts';
import { addBoss, confirmRound, createOrder, openRound, orderArticle } from './ledger-helpers';

test('账号、老板备注、订单、流水和模板由服务器在独立客户端之间保存', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  const id = randomUUID();
  const email = `server-persistence-${id}@example.test`;
  const password = `Test-${id}!`;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: '注册账号', exact: true }).click();
  await page.getByLabel(/^邮箱/).fill(email);
  await page.getByLabel(/^密码/).fill(password);
  await page.getByLabel(/^确认密码/).fill(password);
  const registered = page.waitForResponse(response => response.url().endsWith('/api/auth/register') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '注册', exact: true }).click();
  const registration = await registered;
  expect(registration.status()).toBe(201);
  const apiUrl = registration.url().replace(/\/auth\/register$/, '');
  const firstSession: AuthResponse = await registration.json();
  await expect(page.getByRole('main', { name: '老板账本', exact: true })).toBeVisible();

  const boss = await addBoss(page, `同步老板-${id.slice(0, 8)}`);
  const order = await createOrder(page, `同步小时订单-${id.slice(0, 8)}`, 'hourly', async dialog => {
    await dialog.getByLabel('约定陪玩时长小时', { exact: true }).fill('2');
  });
  const round = await openRound(page, order.title);
  await round.getByLabel('本次陪玩时长分钟', { exact: true }).fill('45');
  await round.getByText('补充信息', { exact: true }).click();
  const entryNote = `跨客户端保留的流水备注-${id}`;
  await round.getByLabel('备注', { exact: true }).fill(entryNote);
  const entry: LedgerEntry = await confirmRound(page, round);
  await expect(orderArticle(page, order.title)).toContainText('1 小时 15 分钟');
  const templateResponse = await page.request.post(`${apiUrl}/order-templates`, {
    headers: { Authorization: `Bearer ${firstSession.token}` },
    data: { name: `服务器模板-${id}`, title: '跨客户端小时单模板', kind: 'hourly', target_quantity: 90, failure_default_quantity: 0, note: `模板备注-${id}` },
  });
  expect(templateResponse.status(), await templateResponse.text()).toBe(201);
  const template: OrderTemplate = await templateResponse.json();
  await page.close();

  // A new browser context shares no cookies, storage, or in-memory session with the writer.
  const readerContext = await browser.newContext({ baseURL, viewport: { width: 1320, height: 880 } });
  try {
    expect(await readerContext.storageState()).toEqual({ cookies: [], origins: [] });
    const reader = await readerContext.newPage();
    reader.on('pageerror', error => errors.push(error.message));
    await reader.goto('/');
    await reader.getByLabel(/^邮箱/).fill(email);
    await reader.getByLabel(/^密码/).fill(password);
    const loggedIn = reader.waitForResponse(response => response.url().endsWith('/api/auth/login') && response.request().method() === 'POST');
    await reader.getByRole('button', { name: '登录', exact: true }).click();
    const loginResponse = await loggedIn;
    expect(loginResponse.status()).toBe(200);
    const secondSession: AuthResponse = await loginResponse.json();
    expect(secondSession.user).toEqual(firstSession.user);
    expect(secondSession.token).not.toBe(firstSession.token);
    const get = async <T>(path: string): Promise<T> => {
      const response = await reader.request.get(`${apiUrl}${path}`, { headers: { Authorization: `Bearer ${secondSession.token}` } });
      expect(response.status(), path).toBe(200);
      return response.json();
    };
    expect(await get<User>('/me')).toEqual(firstSession.user);
    expect(await get<Boss>(`/bosses/${boss.id}`)).toMatchObject({ id: boss.id, display_name: boss.display_name, game_id: boss.game_id, game_name: boss.game_name, notes: boss.notes, remaining_minutes: 75 });
    expect(await get<ServiceOrder>(`/orders/${order.id}`)).toMatchObject({ id: order.id, boss_id: boss.id, title: order.title, kind: 'hourly', target_quantity: 120, completed_quantity: 45, remaining_quantity: 75, record_count: 1 });
    expect(await get<LedgerPage>(`/orders/${order.id}/entries`)).toMatchObject({ total: 1, items: [entry] });
    expect((await get<{ items: OrderTemplate[] }>('/order-templates')).items).toContainEqual(template);

    await expect(reader.getByRole('row', { name: `${boss.display_name}老板汇总`, exact: true })).toContainText(boss.notes);
    await reader.getByRole('button', { name: `查看${boss.display_name}订单`, exact: true }).click();
    await expect(reader.getByRole('region', { name: '老板长期备注', exact: true })).toContainText(boss.notes);
    const article = orderArticle(reader, order.title);
    await expect(article).toContainText('1 小时 15 分钟');
    await article.getByRole('button', { name: `${order.title}场次账本`, exact: true }).click();
    await expect(article.locator('.ledger-entry')).toHaveCount(1);
    await expect(article.locator('.ledger-entry')).toContainText(entryNote);
    await expect(article.locator('.ledger-entry')).toContainText('45 分钟');

    await reader.getByRole('navigation').getByRole('button', { name: '设置', exact: true }).click();
    const settings = reader.locator('.settings-layout');
    await expect(settings.getByRole('heading', { name: '外观', exact: true })).toBeVisible();
    await expect(settings.getByRole('heading', { name: '账号', exact: true })).toBeVisible();
    await expect(settings).toContainText(email);
    await expect(settings.locator('.settings-version')).toContainText('PWTools');
    await expect(settings.getByRole('heading', { name: '连接', exact: true })).toHaveCount(0);
    await expect(settings.getByText('连接信息', { exact: true })).toHaveCount(0);
    await expect(settings.getByRole('button', { name: /重试|检查连接/ })).toHaveCount(0);
    await expect(settings.locator('.service-address, .connection-details')).toHaveCount(0);
    await expect(settings).not.toContainText(apiUrl);
    const screenshots = resolve('.artifacts/server-persistence');
    await mkdir(screenshots, { recursive: true });
    for (const viewport of [{ width: 1280, height: 880 }, { width: 960, height: 760 }]) {
      await reader.setViewportSize(viewport);
      for (const theme of ['dark', 'light'] as const) {
        await settings.locator('label').filter({ hasText: theme === 'dark' ? '深色' : '浅色' }).click();
        await expect(reader.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(settings.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
        await reader.screenshot({ path: resolve(screenshots, `settings-${theme}-${viewport.width}x${viewport.height}.png`), animations: 'disabled' });
      }
    }
    expect(await reader.evaluate(() => Object.keys(localStorage).filter(key => !['pwtools:theme', 'pwtools:sidebar-collapsed'].includes(key)))).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await readerContext.close();
  }
});
