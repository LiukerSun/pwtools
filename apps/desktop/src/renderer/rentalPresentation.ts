export const MAX_CENTS = 1_000_000_000_000;
// Keep the existing quote scale so correcting the unit preserves saved prices.
export const RENTAL_QUOTE_SCALE = 10_000;
export const rentalQuoteText = (price: number) => `${new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(price / RENTAL_QUOTE_SCALE)} 元`;
export const moneyText = (cents: number) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(cents / 100);
export const coinText = (coins: number) => `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(coins / 10_000)} W`;
export const rentalDate = (value: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
export function rentalLocalTime(value: string = new Date().toISOString()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
  const get = (name: string) => parts.find(part => part.type === name)?.value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}
export function orderNetCents(price: number, people: number, commission: number): number {
  const denominator = BigInt(people) * 10_000n;
  return Number((BigInt(price) * BigInt(10_000 - commission) + denominator / 2n) / denominator);
}
