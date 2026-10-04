import { expect, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Boss, OrderKind, ServiceOrder } from '../../apps/desktop/src/shared/contracts';

export async function openLedger(page: Page) {
  const id = randomUUID();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: '注册账号', exact: true }).click();
  await page.getByLabel(/^邮箱/).fill(`flow-${id}@example.test`);
  await page.getByLabel(/^密码/).fill(`Test-${id}!`);
  await page.getByLabel(/^确认密码/).fill(`Test-${id}!`);
  const registered = page.waitForResponse(response => response.url().endsWith('/api/auth/register') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '注册', exact: true }).click();
  const response = await registered;
  expect(response.status()).toBe(201);
  const session: { token: string } = await response.json();
  const headers = { Authorization: `Bearer ${session.token}` };
  const get = async <T>(path: string): Promise<T> => {
    const response = await page.request.get(`http://localhost:8080/api${path}`, { headers });
    expect(response.status(), path).toBe(200);
    return response.json();
  };
  const post = async <T>(path: string, data: object): Promise<T> => {
    const response = await page.request.post(`http://localhost:8080/api${path}`, { headers, data });
    expect(response.status(), await response.text()).toBe(201);
    return response.json();
  };
  await expect(page.getByRole('heading', { name: '老板账本', exact: true })).toBeVisible();
  return { get, post, errors };
}

export async function addBoss(page: Page, name: string, gameName = '小桃知晚'): Promise<Boss> {
  await page.getByRole('button', { name: '添加老板', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加老板', exact: true });
  await dialog.getByLabel(/^老板称呼/).fill(name);
  await dialog.getByLabel(/^游戏 ID/).fill(randomUUID().slice(0, 8));
  await dialog.getByLabel(/^截图内昵称/).fill(gameName);
  await dialog.getByLabel(/^老板备注/).fill(`${name}的长期备注。`);
  const saved = page.waitForResponse(response => response.url().endsWith('/api/bosses') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  const response = await saved;
  expect(response.status()).toBe(201);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('region', { name: '老板详情与订单', exact: true })).toBeVisible();
  return response.json();
}

export const orderArticle = (page: Page, title: string) => page.getByRole('article', { name: `${title}订单`, exact: true });

export async function selectOption(page: Page, input: Locator, name: string | RegExp) {
  await input.click();
  await page.getByRole('option', { name, exact: typeof name === 'string' }).click();
}

const labels: Record<OrderKind, string> = { hourly: '小时单', escort: '护航单', single_round: '单局单' };

export async function createOrder(page: Page, title: string, kind: OrderKind, configure: (dialog: Locator) => Promise<void>): Promise<ServiceOrder> {
  await page.getByRole('button', { name: '新建订单', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建订单', exact: true });
  await expect(dialog.getByRole('button', { name: '创建订单', exact: true })).toBeDisabled();
  await dialog.getByRole('radio', { name: `使用${labels[kind]}模板`, exact: true }).check();
  await dialog.getByLabel(/^订单名称/).fill(title);
  await configure(dialog);
  const saved = page.waitForResponse(response => /\/api\/bosses\/[^/]+\/orders$/.test(response.url()) && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: '创建订单', exact: true }).click();
  const response = await saved;
  expect(response.status(), await response.text()).toBe(201);
  await expect(dialog).toHaveCount(0);
  await expect(orderArticle(page, title)).toBeVisible();
  return response.json();
}

export async function openRound(page: Page, title: string, manual = true) {
  await orderArticle(page, title).getByRole('button', { name: '记一场', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '记一场', exact: true });
  await expect(dialog).toBeVisible();
  if (manual && await dialog.getByText('手工填写', { exact: true }).count()) await dialog.getByText('手工填写', { exact: true }).click();
  return dialog;
}

export async function confirmRound(page: Page, dialog: Locator) {
  const saved = page.waitForResponse(response => /\/api\/(?:orders\/[^/]+\/entries|matches\/[^/]+)$/.test(response.url()) && ['POST', 'PATCH'].includes(response.request().method()));
  await dialog.getByRole('button', { name: '确认入账', exact: true }).click();
  const response = await saved;
  expect(response.status(), await response.text()).toBeGreaterThanOrEqual(200);
  expect(response.status()).toBeLessThan(300);
  await expect(dialog).toHaveCount(0);
  return response.json();
}

export async function openOrderAction(page: Page, title: string, action: string) {
  await orderArticle(page, title).getByRole('button', { name: `${title}更多操作`, exact: true }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}
