import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { NativeApplication } from './native-helpers';

test('实际 WebView2 本机识别 M7、校对保存和重启恢复', async () => {
  test.skip(!process.env.PWTOOLS_GUN_OCR_SAMPLE, 'opt-in private image kept outside repository');
  const directory = await mkdtemp(join(tmpdir(), 'pwtools-native-gun-'));
  let app: NativeApplication | undefined;
  try {
    app = await NativeApplication.launch(directory, undefined, { PWTOOLS_DEV_URL: '' });
    const page = app.page;
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const id = randomUUID();
    await page.getByRole('button', { name: '注册账号', exact: true }).click();
    await page.getByLabel(/^邮箱/).fill(`native-gun-${id}@example.test`);
    await page.getByLabel(/^密码/).fill(`Test-${id}!`);
    await page.getByLabel(/^确认密码/).fill(`Test-${id}!`);
    await page.getByRole('button', { name: '注册', exact: true }).click();
    await expect(page.getByRole('main', { name: '老板账本', exact: true })).toBeVisible();
    await page.evaluate(() => window.pwtools!.setImportHotkey(null));
    expect(await page.evaluate(() => location.origin)).toBe('https://pwtools.local');
    await page.getByRole('button', { name: '改枪码管理', exact: true }).click();
    await page.getByRole('button', { name: '添加改枪码', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '添加改枪码', exact: true });
    await dialog.getByLabel(/^改枪码/).fill('M7战斗步枪-烽火地带-6LHDKCC036I65F2DQBEVD');
    await dialog.locator('input[type=file]').setInputFiles(process.env.PWTOOLS_GUN_OCR_SAMPLE!);
    await dialog.getByRole('button', { name: '识别属性', exact: true }).click();
    await expect(dialog.getByLabel('基础伤害', { exact: true })).toHaveValue('39', { timeout: 80000 });
    await expect(dialog.getByLabel('射速', { exact: true })).toHaveValue('649 发/分');
    await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    await dialog.getByLabel('我已核对，并确认这些属性与当前改枪码对应', { exact: true }).check();
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const saved = await page.evaluate(() => window.pwtools!.listBuildCodes());
    expect(saved.items[0].manual_attributes?.values).toMatchObject({ damage: 39, armor_damage: 42, range_m: 65, recoil_control: 61, handling: 38, stability: 63, hip_fire: 51, fire_rate_rpm: 649, price: 852355, capacity: 30, fire_modes: ['全自动', '单发'], muzzle_velocity_mps: 819, sound_distance_m: 600 });
    await page.screenshot({ path: '.artifacts/build-attributes/native-saved.png', fullPage: true });
    await app.close(); app = undefined;
    app = await NativeApplication.launch(directory, undefined, { PWTOOLS_DEV_URL: '' });
    await expect(app.page.getByRole('main', { name: '老板账本', exact: true })).toBeVisible();
    await app.page.getByRole('button', { name: '改枪码管理', exact: true }).click();
    await expect(app.page.getByRole('article', { name: 'M7战斗步枪改枪方案', exact: true }).getByText(/个人截图校对/)).toBeVisible();
    expect((await app.page.evaluate(() => window.pwtools!.listBuildCodes())).items[0].manual_attributes).toEqual(saved.items[0].manual_attributes);
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    if (resolve(directory).startsWith(resolve(tmpdir()) + sep) && basename(directory).startsWith('pwtools-native-gun-')) await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});
