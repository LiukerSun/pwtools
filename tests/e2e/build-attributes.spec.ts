import { expect, test, type Page } from '@playwright/test';
import { openLedger } from './ledger-helpers';
import type { WeaponBuildCode } from '../../apps/desktop/src/shared/contracts';

async function image(page: Page) {
  const data = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
    canvas.getContext('2d')!.fillRect(0, 0, 32, 32);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  return { name: 'panel.png', mimeType: 'image/png', buffer: Buffer.from(data, 'base64') };
}
const candidate = { status: 'completed', weapon_name: 'M7战斗步枪', values: { damage: 39, range_m: 65, handling: 38, price: 852355 }, confidences: { damage: .99 }, warnings: [], missing: ['armor_damage'] };
async function add(page: Page) {
  await page.getByRole('button', { name: '改枪码管理', exact: true }).click();
  await page.getByRole('button', { name: '添加改枪码', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加改枪码', exact: true });
  await dialog.getByLabel(/^改枪码/).fill('M7战斗步枪-烽火地带-6LHDKCC036I65F2DQBEVD');
  return dialog;
}

test('截图校对、再次识别保留人工值、保存与清除', async ({ page }) => {
  const { get, errors } = await openLedger(page);
  await page.route('**/weapon-build-codes/recognize-attributes', route => route.fulfill({ json: candidate }));
  const dialog = await add(page);
  await dialog.locator('input[type=file]').setInputFiles(await image(page));
  await dialog.getByRole('button', { name: '识别属性', exact: true }).click();
  await expect(dialog.getByLabel('基础伤害', { exact: true })).toHaveValue('39');
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await dialog.getByLabel('基础伤害', { exact: true }).fill('40');
  await dialog.getByRole('button', { name: '识别属性', exact: true }).click();
  await expect(dialog.getByLabel('基础伤害', { exact: true })).toHaveValue('40');
  await dialog.getByLabel('我已核对，并确认这些属性与当前改枪码对应', { exact: true }).check();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const article = page.getByRole('article', { name: 'M7战斗步枪改枪方案', exact: true });
  await expect(article.getByText(/个人截图校对/)).toBeVisible();
  const saved = (await get<{ items: WeaponBuildCode[] }>('/weapon-build-codes')).items[0];
  expect(saved.manual_attributes?.values).toMatchObject({ damage: 40, handling: 38, price: 852355 });
  expect(saved.manual_attributes?.source).toBe('ocr_confirmed');
  await article.getByRole('button', { name: '编辑M7战斗步枪', exact: true }).click();
  const edit = page.getByRole('dialog', { name: '编辑改枪码', exact: true });
  await edit.getByRole('button', { name: '清除个人属性', exact: true }).click();
  await page.getByRole('dialog', { name: '清除个人属性', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
  await expect(edit.getByLabel('基础伤害', { exact: true })).toHaveValue('40');
  await page.setViewportSize({ width: 760, height: 880 });
  await page.screenshot({ path: '.artifacts/build-attributes/editor-dark.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await edit.getByRole('button', { name: '清除个人属性', exact: true }).click();
  await page.getByRole('dialog', { name: '清除个人属性', exact: true }).getByRole('button', { name: '确认清除', exact: true }).click();
  await edit.getByRole('button', { name: '保存', exact: true }).click();
  await expect(edit).not.toBeVisible();
  expect((await get<{ items: WeaponBuildCode[] }>('/weapon-build-codes')).items[0].manual_attributes).toBeNull();
  expect(errors).toEqual([]);
});

test('换码后丢弃迟到识别结果，纯手填可保存零值', async ({ page }) => {
  const { get, errors } = await openLedger(page);
  let release!: () => void;
  const wait = new Promise<void>(done => { release = done; });
  await page.route('**/weapon-build-codes/recognize-attributes', async route => { await wait; await route.fulfill({ json: candidate }); });
  const dialog = await add(page);
  await dialog.locator('input[type=file]').setInputFiles(await image(page));
  const request = page.waitForRequest('**/weapon-build-codes/recognize-attributes');
  await dialog.getByRole('button', { name: '识别属性', exact: true }).click();
  await request;
  await dialog.getByLabel(/^改枪码/).fill('M7战斗步枪-烽火地带-6LHDKCC036I65F2DQBEVE');
  release();
  await expect(dialog.getByText('方案已改变，请重新录入并确认对应属性。')).toBeVisible();
  await expect(dialog.getByLabel('基础伤害', { exact: true })).toHaveValue('');
  await dialog.getByLabel('基础伤害', { exact: true }).fill('0');
  await dialog.getByLabel('我已核对，并确认这些属性与当前改枪码对应', { exact: true }).check();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect((await get<{ items: WeaponBuildCode[] }>('/weapon-build-codes')).items[0].manual_attributes?.values.damage).toBe(0);
  expect(errors).toEqual([]);
});

test('本机 M7 原图通过浏览器服务识别并保存', async ({ page }) => {
  test.skip(!process.env.PWTOOLS_GUN_OCR_SAMPLE, 'opt-in private image kept outside repository');
  const { get } = await openLedger(page);
  const dialog = await add(page);
  await dialog.locator('input[type=file]').setInputFiles(process.env.PWTOOLS_GUN_OCR_SAMPLE!);
  await dialog.getByRole('button', { name: '识别属性', exact: true }).click();
  await expect(dialog.getByLabel('基础伤害', { exact: true })).toHaveValue('39', { timeout: 80000 });
  await expect(dialog.getByLabel('射速', { exact: true })).toHaveValue('649 发/分');
  await dialog.getByLabel('我已核对，并确认这些属性与当前改枪码对应', { exact: true }).check();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect((await get<{ items: WeaponBuildCode[] }>('/weapon-build-codes')).items[0].manual_attributes?.values).toMatchObject({ damage: 39, handling: 38, fire_rate_rpm: 649, capacity: 30, muzzle_velocity_mps: 819, sound_distance_m: 600 });
});

test('聚焦区域粘贴、枪名冲突、替换确认和放弃草稿', async ({ page }) => {
  const { get, errors } = await openLedger(page);
  await page.route('**/weapon-build-codes/recognize-attributes', route => route.fulfill({ json: { ...candidate, weapon_name: '其他步枪', confidences: { damage: .5 }, warnings: ['基础伤害低置信度，请核对'] } }));
  const dialog = await add(page);
  await dialog.getByLabel('备注', { exact: true }).evaluate(element => {
    const data = new DataTransfer(); data.setData('text/plain', '文本备注');
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
    element.dispatchEvent(event); if (event.defaultPrevented) throw new Error('text paste intercepted');
  });
  const screenshot = await image(page);
  await dialog.getByLabel('粘贴属性截图', { exact: true }).focus();
  await dialog.getByLabel('粘贴属性截图', { exact: true }).evaluate((element, bytes) => {
    const data = new DataTransfer(); data.items.add(new File([new Uint8Array(bytes)], 'pasted.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, [...screenshot.buffer]);
  await expect(dialog.getByAltText('待校对枪支属性截图')).toBeVisible();
  await dialog.getByRole('button', { name: '识别属性', exact: true }).click();
  await expect(dialog.getByText(/截图枪名「其他步枪」/)).toBeVisible();
  await expect(dialog.locator('.mantine-Alert-message').filter({ hasText: '基础伤害低置信度，请核对' })).toBeVisible();
  await dialog.getByLabel('基础伤害', { exact: true }).fill('40');
  await dialog.getByRole('button', { name: '重新识别并替换全部值', exact: true }).click();
  await page.getByRole('dialog', { name: '替换全部属性', exact: true }).getByRole('button', { name: '确认替换', exact: true }).click();
  await expect(dialog.getByLabel('基础伤害', { exact: true })).toHaveValue('39');
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await dialog.getByLabel('我已核对枪名差异，并确认截图属性属于当前改枪码', { exact: true }).check();
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('dialog', { name: '放弃未保存修改', exact: true }).getByRole('button', { name: '放弃修改', exact: true }).click();
  expect((await get<{ items: WeaponBuildCode[] }>('/weapon-build-codes')).items).toHaveLength(0);
  await page.getByRole('button', { name: '切换至浅色', exact: true }).click();
  await page.getByRole('button', { name: '添加改枪码', exact: true }).click();
  await page.setViewportSize({ width: 760, height: 880 });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('基础伤害', { exact: true })).toBeVisible();
  await page.screenshot({ path: '.artifacts/build-attributes/editor-light.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('识别失败保留手工填写，无文字和繁忙提示可区分', async ({ page }) => {
  await openLedger(page);
  let status = 'no_text';
  await page.route('**/weapon-build-codes/recognize-attributes', route => status === 'busy'
    ? route.fulfill({ status: 503, json: { error: { code: 'OCR_BUSY', message: '识别服务正忙，请稍后重试' } } })
    : route.fulfill({ json: { status, weapon_name: null, values: {}, confidences: {}, warnings: [], missing: [] } }));
  const dialog = await add(page);
  await dialog.getByLabel('基础伤害', { exact: true }).fill('38');
  await dialog.getByLabel('操控速度', { exact: true }).pressSequentially('38.5');
  await expect(dialog.getByLabel('操控速度', { exact: true })).toHaveValue('38.5');
  await dialog.locator('input[type=file]').setInputFiles(await image(page));
  await dialog.getByRole('button', { name: '识别属性', exact: true }).click();
  await expect(dialog.getByText('没有识别到文字，请裁剪清晰面板或手工填写。', { exact: true })).toBeVisible();
  status = 'no_fields';
  await dialog.getByRole('button', { name: '识别属性', exact: true }).click();
  await expect(dialog.getByText('没有识别到枪支属性面板，可继续手工填写。', { exact: true })).toBeVisible();
  status = 'busy';
  await dialog.getByRole('button', { name: '识别属性', exact: true }).click();
  await expect(dialog.getByText('识别服务正忙，请稍后重试', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('基础伤害', { exact: true })).toHaveValue('38');
  await dialog.getByLabel('我已核对，并确认这些属性与当前改枪码对应', { exact: true }).check();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).not.toBeVisible();
});
