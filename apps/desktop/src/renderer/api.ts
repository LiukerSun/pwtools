import type { ApiErrorData, AuthResponse, DesktopBridge, User } from '../shared/contracts';

export class ClientError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ClientError';
    this.code = code;
  }
}

const browserApiUrl = (import.meta.env.VITE_API_URL || 'http://localhost:8080/api').replace(/\/$/, '');
let browserToken: string | null = null;

async function send(path: string, init: RequestInit = {}, timeout = 15_000): Promise<Response> {
  const requestToken = browserToken;
  try {
    const response = await fetch(`${browserApiUrl}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(requestToken ? { Authorization: `Bearer ${requestToken}` } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(timeout),
      redirect: 'error',
    });
    if (!response.ok) {
      if (response.status === 401 && browserToken === requestToken) browserToken = null;
      const body = await response.json().catch(() => null);
      const error = (body?.error || body) as Partial<ApiErrorData> | null;
      throw new ClientError(
        error?.code || (response.status === 401 ? 'UNAUTHORIZED' : `HTTP_${response.status}`),
        error?.message || '请求未完成，请稍后重试。',
      );
    }
    return response;
  } catch (error) {
    if (error instanceof ClientError) throw error;
    if (error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name)) {
      throw new ClientError('TIMEOUT', '连接超时，请检查后端服务后重试。');
    }
    throw new ClientError('NETWORK_ERROR', '无法连接服务，请检查后端服务是否已启动。');
  }
}

async function request<T>(path: string, init: RequestInit = {}, timeout = 15_000): Promise<T> {
  const response = await send(path, {
    ...init,
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  }, timeout);
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

function matchPath(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new ClientError('INVALID_INPUT', '战绩记录编号不正确。');
  return `/matches/${id}`;
}

function ledgerId(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new ClientError('INVALID_INPUT', '账本记录编号不正确。');
  return id;
}

function ledgerPath(resource: 'bosses' | 'orders' | 'entries', id: string): string {
  return `/${resource}/${ledgerId(id)}`;
}

function orderQuery(orderId?: string): string {
  if (!orderId) return '';
  return `order_id=${encodeURIComponent(ledgerId(orderId))}`;
}

const browserBridge: DesktopBridge = {
  health: () => request('/health'),
  register: async (input) => {
    const response = await request<AuthResponse>('/auth/register', { method: 'POST', body: JSON.stringify(input) });
    browserToken = response.token;
    return response.user;
  },
  login: async (input) => {
    const response = await request<AuthResponse>('/auth/login', { method: 'POST', body: JSON.stringify(input) });
    browserToken = response.token;
    return response.user;
  },
  me: () => browserToken
    ? request<User>('/me')
    : Promise.reject(new ClientError('UNAUTHORIZED', '请先登录。')),
  logout: async () => { await request('/auth/logout', { method: 'POST' }); browserToken = null; },
  windowControl: async () => {},
  appInfo: async () => ({ version: '浏览器预览', apiUrl: browserApiUrl, persistentSession: false }),
  uploadMatch: async (input) => {
    const response = await send('/matches', {
      method: 'POST',
      headers: { 'Content-Type': input.content_type, 'X-File-Name': encodeURIComponent(input.name), ...(input.order_id ? { 'X-Order-Id': ledgerId(input.order_id) } : {}) },
      body: new Uint8Array(input.data).buffer,
    }, 100_000);
    return response.json();
  },
  listMatches: (page = 1, pageSize = 20, orderId, confirmed) => request(`/matches?page=${page}&page_size=${pageSize}${orderId ? `&${orderQuery(orderId)}` : ''}${confirmed === undefined ? '' : `&confirmed=${confirmed}`}`),
  matchStats: orderId => request(`/matches/stats${orderId ? `?${orderQuery(orderId)}` : ''}`),
  getMatch: id => request(matchPath(id)),
  updateMatch: (id, input) => request(matchPath(id), { method: 'PATCH', body: JSON.stringify(input) }),
  recognizeMatch: id => request(`${matchPath(id)}/recognize`, { method: 'POST' }, 100_000),
  deleteMatch: id => request(matchPath(id), { method: 'DELETE' }),
  matchImage: async id => {
    const response = await send(`${matchPath(id)}/image`);
    return { content_type: response.headers.get('content-type') || 'image/png', data: new Uint8Array(await response.arrayBuffer()) };
  },
  matchSettings: () => request('/matches/settings'),
  updateMatchSettings: input => request('/matches/settings', { method: 'PATCH', body: JSON.stringify(input) }),
  listBosses: (search = '') => request(`/bosses?q=${encodeURIComponent(search)}`),
  getBoss: id => request(ledgerPath('bosses', id)),
  createBoss: input => request('/bosses', { method: 'POST', body: JSON.stringify(input) }),
  updateBoss: (id, input) => request(ledgerPath('bosses', id), { method: 'PATCH', body: JSON.stringify(input) }),
  listOrders: bossId => request(`/orders${bossId ? `?boss_id=${encodeURIComponent(ledgerId(bossId))}` : ''}`),
  getOrder: id => request(ledgerPath('orders', id)),
  createOrder: (bossId, input) => request(`${ledgerPath('bosses', bossId)}/orders`, { method: 'POST', body: JSON.stringify(input) }),
  updateOrder: (id, input) => request(ledgerPath('orders', id), { method: 'PATCH', body: JSON.stringify(input) }),
  listOrderTemplates: () => request('/order-templates'),
  createOrderTemplate: input => request('/order-templates', { method: 'POST', body: JSON.stringify(input) }),
  updateOrderTemplate: (id, input) => request(`/order-templates/${ledgerId(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteOrderTemplate: id => request(`/order-templates/${ledgerId(id)}`, { method: 'DELETE' }),
  listCatalog: (query = {}) => request(`/catalog/items?${new URLSearchParams({ q: query.q || '', category: query.category || '', page: String(query.page || 1), page_size: String(query.page_size || 40) })}`),
  listLedgerEntries: (orderId, page = 1, pageSize = 20) => request(`${ledgerPath('orders', orderId)}/entries?page=${page}&page_size=${pageSize}`),
  addLedgerEntry: (orderId, input) => request(`${ledgerPath('orders', orderId)}/entries`, { method: 'POST', body: JSON.stringify(input) }),
  deleteLedgerEntry: (orderId, entryId) => request(`${ledgerPath('orders', orderId)}${ledgerPath('entries', entryId)}`, { method: 'DELETE' }),
};

export const isDesktop = Boolean(window.pwtools);
export const api: DesktopBridge = window.pwtools || browserBridge;

export function errorInfo(error: unknown): ApiErrorData {
  if (typeof error === 'object' && error !== null) {
    const value = error as Partial<ApiErrorData>;
    return { code: value.code || 'UNKNOWN', message: value.message || '操作未完成，请重试。' };
  }
  return { code: 'UNKNOWN', message: '操作未完成，请重试。' };
}

export function isSessionError(error: unknown): boolean {
  return /UNAUTHORIZED|TOKEN|SESSION|AUTH_REQUIRED/i.test(errorInfo(error).code);
}
