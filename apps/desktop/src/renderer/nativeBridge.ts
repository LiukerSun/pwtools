import type { DesktopBridge, MatchImage, MatchUploadResponse } from '../shared/contracts';

export interface NativeRequest {
  id: string;
  method: string;
  args: unknown[];
}

export interface NativeWebView {
  postMessage(message: NativeRequest): void;
  addEventListener(type: 'message', handler: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', handler: (event: { data: unknown }) => void): void;
}

export class NativeBridgeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'NativeBridgeError';
    this.code = code;
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: NativeBridgeError) => void;
  timer: ReturnType<typeof setTimeout>;
}

const ordinaryTimeout = 20_000;
const ocrTimeout = 110_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)));
  }
  return btoa(parts.join(''));
}

function imageFromNative(value: unknown): MatchImage {
  if (!isObject(value) || typeof value.content_type !== 'string' || typeof value.data_base64 !== 'string') {
    throw new NativeBridgeError('IMAGE_INTEGRITY_ERROR', '截图内容无效，请重试。');
  }
  try {
    const decoded = atob(value.data_base64);
    return { content_type: value.content_type, data: Uint8Array.from(decoded, character => character.charCodeAt(0)) };
  } catch {
    throw new NativeBridgeError('IMAGE_INTEGRITY_ERROR', '截图内容无效，请重试。');
  }
}

/** The host owns HTTP, session credentials, and clipboard permissions. */
export function createNativeBridge(webview: NativeWebView): {
  bridge: DesktopBridge;
  dragWindow: () => Promise<void>;
  dispose: () => void;
} {
  const pending = new Map<string, PendingRequest>();
  const closeHandlers = new Set<() => void>();
  const exitHandlers = new Set<() => void>();
  const importHandlers = new Set<() => void>();
  let closeRequestedBeforeSubscription = false;
  let exitRequestedBeforeSubscription = false;
  let importRequestedBeforeSubscription = false;
  let disposed = false;

  const invoke = <T>(method: string, args: unknown[] = []): Promise<T> => {
    if (disposed) return Promise.reject(new NativeBridgeError('NETWORK_ERROR', '窗口连接已关闭。'));
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        reject(new NativeBridgeError('TIMEOUT', '操作超时，请确认保存结果后重试。'));
      }, method === 'uploadMatch' || method === 'recognizeMatch' ? ocrTimeout : ordinaryTimeout);
      pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      try {
        webview.postMessage({ id, method, args });
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        reject(new NativeBridgeError('NETWORK_ERROR', '无法连接窗口，请确认保存结果后重试。'));
      }
    });
  };

  const receive = (event: { data: unknown }) => {
    const message = event.data;
    if (!isObject(message)) return;
    if (message.event === 'close-requested') {
      if (closeHandlers.size === 0) closeRequestedBeforeSubscription = true;
      for (const handler of [...closeHandlers]) handler();
      return;
    }
    if (message.event === 'exit-requested') {
      if (exitHandlers.size === 0) exitRequestedBeforeSubscription = true;
      for (const handler of [...exitHandlers]) handler();
      return;
    }
    if (message.event === 'import-requested') {
      if (importHandlers.size === 0) importRequestedBeforeSubscription = true;
      for (const handler of [...importHandlers]) handler();
      return;
    }
    if (typeof message.id !== 'string') return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.ok === true) {
      request.resolve(message.data);
    } else if (message.ok === false && isObject(message.error)
      && typeof message.error.code === 'string' && typeof message.error.message === 'string') {
      request.reject(new NativeBridgeError(message.error.code, message.error.message));
    } else {
      request.reject(new NativeBridgeError('UNKNOWN', '无法确认操作结果，请重试。'));
    }
  };
  webview.addEventListener('message', receive);

  const bridge: DesktopBridge = {
    health: () => invoke('health'),
    register: input => invoke('register', [input]),
    login: input => invoke('login', [input]),
    me: () => invoke('me'),
    logout: () => invoke('logout'),
    windowControl: action => invoke('windowControl', [action]),
    setImportHotkey: shortcut => invoke('setImportHotkey', [shortcut]),
    readClipboardImage: async () => {
      const value = await invoke('readClipboardImage');
      if (value === null) return null;
      if (!isObject(value) || typeof value.name !== 'string') {
        throw new NativeBridgeError('IMAGE_INTEGRITY_ERROR', '剪贴板截图内容无效，请重新复制截图。');
      }
      return { name: value.name, ...imageFromNative(value) };
    },
    appInfo: () => invoke('appInfo'),
    onCloseRequested: handler => {
      closeHandlers.add(handler);
      if (closeRequestedBeforeSubscription) {
        closeRequestedBeforeSubscription = false;
        queueMicrotask(() => { if (closeHandlers.has(handler)) handler(); });
      }
      return () => { closeHandlers.delete(handler); };
    },
    onExitRequested: handler => {
      exitHandlers.add(handler);
      if (exitRequestedBeforeSubscription) {
        exitRequestedBeforeSubscription = false;
        queueMicrotask(() => { if (exitHandlers.has(handler)) handler(); });
      }
      return () => { exitHandlers.delete(handler); };
    },
    onImportRequested: handler => {
      importHandlers.add(handler);
      if (importRequestedBeforeSubscription) {
        importRequestedBeforeSubscription = false;
        queueMicrotask(() => { if (!disposed && importHandlers.has(handler)) handler(); });
      }
      return () => { importHandlers.delete(handler); };
    },
    uploadMatch: input => {
      const { data, ...metadata } = input;
      return invoke<MatchUploadResponse>('uploadMatch', [{ ...metadata, data_base64: bytesToBase64(data) }]);
    },
    listMatches: (page = 1, pageSize = 20, orderId, confirmed) => invoke('listMatches', [page, pageSize, orderId ?? null, confirmed ?? null]),
    matchStats: orderId => invoke('matchStats', [orderId ?? null]),
    getMatch: id => invoke('getMatch', [id]),
    updateMatch: (id, input) => invoke('updateMatch', [id, input]),
    recognizeMatch: id => invoke('recognizeMatch', [id]),
    deleteMatch: id => invoke('deleteMatch', [id]),
    matchImage: async id => imageFromNative(await invoke('matchImage', [id])),
    matchSettings: () => invoke('matchSettings'),
    updateMatchSettings: input => invoke('updateMatchSettings', [input]),
    listBosses: (search = '') => invoke('listBosses', [search]),
    getBoss: id => invoke('getBoss', [id]),
    createBoss: input => invoke('createBoss', [input]),
    updateBoss: (id, input) => invoke('updateBoss', [id, input]),
    listOrders: bossId => invoke('listOrders', [bossId ?? null]),
    getOrder: id => invoke('getOrder', [id]),
    createOrder: (bossId, input) => invoke('createOrder', [bossId, input]),
    updateOrder: (id, input) => invoke('updateOrder', [id, input]),
    listOrderTemplates: () => invoke('listOrderTemplates'),
    createOrderTemplate: input => invoke('createOrderTemplate', [input]),
    updateOrderTemplate: (id, input) => invoke('updateOrderTemplate', [id, input]),
    deleteOrderTemplate: id => invoke('deleteOrderTemplate', [id]),
    listLedgerEntries: (orderId, page = 1, pageSize = 20) => invoke('listLedgerEntries', [orderId, page, pageSize]),
    addLedgerEntry: (orderId, input) => invoke('addLedgerEntry', [orderId, input]),
    deleteLedgerEntry: (orderId, entryId) => invoke('deleteLedgerEntry', [orderId, entryId]),
  };

  return {
    bridge,
    dragWindow: () => invoke('windowDrag'),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      webview.removeEventListener('message', receive);
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new NativeBridgeError('NETWORK_ERROR', '窗口连接已关闭。'));
      }
      pending.clear();
      closeHandlers.clear();
      exitHandlers.clear();
      importHandlers.clear();
    },
  };
}

function isTitlebarBackground(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('.titlebar'))
    && !target.closest('button, input, textarea, select, a, [role="button"], .window-controls, [data-no-drag]');
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const webview = (window as Window & { chrome?: { webview?: NativeWebView } }).chrome?.webview;
  if (webview && !window.pwtools) {
    const native = createNativeBridge(webview);
    window.pwtools = native.bridge;
    document.addEventListener('mousedown', event => {
      if (event.button === 0 && event.detail < 2 && isTitlebarBackground(event.target)) {
        void native.dragWindow().catch(() => {});
      }
    });
    document.addEventListener('dblclick', event => {
      if (event.button === 0 && isTitlebarBackground(event.target)) {
        void native.bridge.windowControl('maximize').catch(() => {});
      }
    });
  }
}
