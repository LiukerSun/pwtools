import { expect, test } from '@playwright/test';

test('12 MiB 截图编码时界面定时器仍可响应', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
  const result = await page.evaluate(async () => {
    // Measure the same encoding helper used immediately before the OCR RPC.
    const module = await import('/buildAttributes.ts');
    const bytes = new Uint8Array(12 * 1024 * 1024); bytes[bytes.length - 1] = 123;
    const start = performance.now();
    const heartbeat = new Promise<number>(done => setTimeout(() => done(performance.now() - start), 0));
    const data = await module.bytesToBase64(bytes);
    return { heartbeatMs: await heartbeat, totalMs: performance.now() - start, length: data.length, tail: data.slice(-4) };
  });
  console.log(JSON.stringify(result));
  expect(result.length).toBe(16 * 1024 * 1024);
  expect(result.tail).toBe('AAB7');
  expect(result.heartbeatMs).toBeLessThan(50);
});
