import { useCallback, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import Screenshots from 'react-screenshots';
// 0.6.1 publishes its complete stylesheet under this exported dist path.
// The Vite adapter removes missing stylesheet imports from the library source.
import 'react-screenshots/dist/static/css/index.23cabfe1.css';
import './capture.css';

const MAX_BACKGROUND_BYTES = 64 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 12 * 1024 * 1024;
const MAX_BACKGROUND_PIXELS = 80_000_000;
const MAX_BACKGROUND_SIDE = 32_000;

interface CaptureWebView {
  postMessage(message: { id: string; method: string; args: unknown[] }): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

interface PendingReply {
  resolve?: (value: unknown) => void;
  reject: (error: Error) => void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createCaptureChannel(webview: CaptureWebView) {
  const pending = new Map<string, PendingReply>();
  const receive = (event: { data: unknown }) => {
    const reply = event.data;
    if (!isObject(reply) || typeof reply.id !== 'string') return;
    const operation = pending.get(reply.id);
    if (!operation) return;
    pending.delete(reply.id);
    if (reply.ok === true) { operation.resolve?.(reply.data); return; }
    const message = isObject(reply.error) && typeof reply.error.message === 'string'
      ? reply.error.message : '截图操作未完成，请重试。';
    operation.reject(new Error(message));
  };
  webview.addEventListener('message', receive);
  return {
    ready: () => new Promise<unknown>((resolve, reject) => {
      const id = crypto.randomUUID();
      pending.set(id, { resolve, reject });
      try { webview.postMessage({ id, method: 'captureOverlayReady', args: [] }); }
      catch { pending.delete(id); reject(new Error('无法连接截图窗口。')); }
    }),
    send: (method: 'captureOverlayShow' | 'captureOverlayFinish' | 'captureOverlayCancel', args: unknown[], onError: (error: Error) => void) => {
      const id = crypto.randomUUID();
      pending.set(id, { reject: onError });
      try { webview.postMessage({ id, method, args }); }
      catch { pending.delete(id); throw new Error('无法连接截图窗口。'); }
    },
    dispose: () => {
      webview.removeEventListener('message', receive);
      for (const operation of pending.values()) operation.reject(new Error('截图窗口已关闭。'));
      pending.clear();
    },
  };
}

function decodeSnapshot(value: unknown): { bytes: Uint8Array<ArrayBuffer>; width: number; height: number } {
  if (!isObject(value) || value.content_type !== 'image/png' || typeof value.data_base64 !== 'string'
    || typeof value.width !== 'number' || typeof value.height !== 'number'
    || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)
    || value.width <= 0 || value.height <= 0 || value.width > MAX_BACKGROUND_SIDE
    || value.height > MAX_BACKGROUND_SIDE || value.width * value.height > MAX_BACKGROUND_PIXELS) {
    throw new Error('屏幕图像无效，请取消后重新截图。');
  }
  const base64 = value.data_base64;
  if (base64.length === 0 || base64.length % 4 !== 0 || base64.length > Math.ceil(MAX_BACKGROUND_BYTES / 3) * 4) {
    throw new Error('屏幕图像过大或内容无效，请取消后重新截图。');
  }
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array(base64.length / 4 * 3 - padding);
  if (bytes.length > MAX_BACKGROUND_BYTES) throw new Error('屏幕图像过大，请取消后重新截图。');
  let write = 0;
  // Decode in bounded chunks: a large virtual desktop must not require a
  // giant spread argument or a second full-size binary string.
  try {
    for (let offset = 0; offset < base64.length; offset += 65_536) {
      const binary = atob(base64.slice(offset, offset + 65_536));
      for (let index = 0; index < binary.length; index++) bytes[write++] = binary.charCodeAt(index);
    }
  } catch { throw new Error('屏幕图像内容无效，请取消后重新截图。'); }
  if (write !== bytes.length || bytes.length < 8
    || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) {
    throw new Error('屏幕图像内容无效，请取消后重新截图。');
  }
  return { bytes, width: value.width, height: value.height };
}

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      const prefix = 'data:image/png;base64,';
      if (typeof result !== 'string' || !result.startsWith(prefix)) reject(new Error('截图内容无效，请重新框选。'));
      else resolve(result.slice(prefix.length));
    };
    reader.onerror = () => reject(new Error('截图读取失败，请重新框选。'));
    reader.onabort = () => reject(new Error('截图读取已取消，请重新框选。'));
    reader.readAsDataURL(blob);
  });
}

function CaptureOverlay() {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [state, setState] = useState<'loading' | 'ready' | 'finishing' | 'error'>('loading');
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const root = useRef<HTMLDivElement>(null);
  const channel = useRef<ReturnType<typeof createCaptureChannel> | null>(null);
  const alive = useRef(true);
  const encoding = useRef(false);
  const sent = useRef(false);
  const showSent = useRef(false);
  const readyStarted = useRef(false);
  const objectUrl = useRef('');

  const recover = useCallback((failure: Error) => {
    if (!alive.current) return;
    sent.current = false;
    encoding.current = false;
    setState(url ? 'ready' : 'error');
    setError(failure.message);
  }, [url]);
  const cancel = useCallback(() => {
    if (sent.current) return;
    sent.current = true;
    try { channel.current?.send('captureOverlayCancel', [], recover); }
    catch (failure) { recover(failure instanceof Error ? failure : new Error('取消截图未完成。')); }
  }, [recover]);
  const finish = useCallback(async (blob: Blob) => {
    if (encoding.current || sent.current) return;
    if (blob.type !== 'image/png' || blob.size === 0) { setError('截图内容无效，请重新框选。'); return; }
    if (blob.size > MAX_CAPTURE_BYTES) { setError('截图超过 12 MiB，请重新框选较小的区域。'); return; }
    encoding.current = true;
    setState('finishing'); setError('');
    try {
      const data_base64 = await blobBase64(blob);
      if (!alive.current || sent.current) return;
      sent.current = true;
      channel.current?.send('captureOverlayFinish', [{ data_base64 }], recover);
      // The host acknowledges and destroys this window asynchronously. Do
      // not await its destruction before completing the library callback.
    } catch (failure) { recover(failure instanceof Error ? failure : new Error('截图导入未完成，请重新框选。')); }
    finally { encoding.current = false; }
  }, [recover]);

  useEffect(() => {
    alive.current = true;
    const cleanup = () => {
      alive.current = false;
      // React's development effect replay must reuse the single native Ready
      // request. Only release the session if the component stays unmounted.
      queueMicrotask(() => {
        if (alive.current) return;
        channel.current?.dispose();
        channel.current = null;
        if (objectUrl.current) { URL.revokeObjectURL(objectUrl.current); objectUrl.current = ''; }
      });
    };
    if (readyStarted.current) return cleanup;
    readyStarted.current = true;
    const webview = (window as Window & { chrome?: { webview?: CaptureWebView } }).chrome?.webview;
    if (!webview) { setError('请从 PWTools 的导入快捷键打开截图工具。'); setState('error'); return cleanup; }
    const connection = createCaptureChannel(webview);
    channel.current = connection;
    void connection.ready().then(async value => {
      if (!alive.current) return;
      const { bytes, width, height } = decodeSnapshot(value);
      objectUrl.current = URL.createObjectURL(new Blob([bytes.buffer], { type: 'image/png' }));
      const image = new Image(); image.src = objectUrl.current;
      try { await image.decode(); }
      catch { throw new Error('屏幕图像未加载，请取消后重新截图。'); }
      if (image.naturalWidth !== width || image.naturalHeight !== height) throw new Error('屏幕图像尺寸无效，请取消后重新截图。');
      if (alive.current) setUrl(objectUrl.current);
    }).catch((failure: unknown) => {
      if (!alive.current) return;
      setError(failure instanceof Error ? failure.message : '屏幕图像未加载，请取消后重新截图。');
      setState('error');
    });
    return cleanup;
  }, []);

  useEffect(() => {
    if (state !== 'error' || url || showSent.current || !channel.current) return;
    const frame = requestAnimationFrame(() => {
      if (!alive.current || showSent.current) return;
      showSent.current = true;
      try { channel.current?.send('captureOverlayShow', [], () => {}); }
      catch { /* The native capture timeout also closes this window. */ }
    });
    return () => cancelAnimationFrame(frame);
  }, [state, url]);

  useEffect(() => {
    if (!url) return;
    let frame = 0;
    let active = true;
    const waitForLibraryImage = () => {
      if (!active) return;
      const image = root.current?.querySelector<HTMLImageElement>('.screenshots-background-image');
      if (!image?.complete || !image.naturalWidth) { frame = requestAnimationFrame(waitForLibraryImage); return; }
      setState('ready');
      frame = requestAnimationFrame(() => {
        if (!active || showSent.current) return;
        showSent.current = true;
        try { channel.current?.send('captureOverlayShow', [], recover); }
        catch (failure) { recover(failure instanceof Error ? failure : new Error('截图窗口未显示。')); }
      });
    };
    frame = requestAnimationFrame(waitForLibraryImage);
    return () => { active = false; cancelAnimationFrame(frame); };
  }, [url, recover]);

  useEffect(() => {
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); cancel();
    };
    const context = (event: MouseEvent) => {
      event.preventDefault();
      if (event.button === 2) { event.stopPropagation(); cancel(); }
    };
    window.addEventListener('resize', resize);
    window.addEventListener('keydown', key, true);
    window.addEventListener('contextmenu', context, true);
    return () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('contextmenu', context, true);
    };
  }, [cancel]);

  return <div ref={root} className="capture-overlay" data-capture-state={state} aria-label="截图工具">
    {url ? <>
      <Screenshots url={url} width={viewport.width} height={viewport.height} onOk={finish} onCancel={cancel} lang={{ operation_ok_title: '完成截图', operation_cancel_title: '取消截图', operation_save_title: '保存截图' }} />
      <div className="capture-hint" role="status">{state === 'finishing' ? '正在准备导入…' : '拖动框选战绩，完成后选择订单 · Esc 或右键取消'}</div>
      {error && <div className="capture-error" role="alert">{error}</div>}
    </> : <div className="capture-loading" role={error ? 'alert' : 'status'}><p>{error || '正在准备截图…'}</p>{error && <button type="button" onClick={cancel}>取消截图</button>}</div>}
  </div>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(<CaptureOverlay />);
