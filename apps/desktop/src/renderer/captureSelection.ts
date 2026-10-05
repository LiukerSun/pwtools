export interface CapturePoint { x: number; y: number }
export interface CaptureBounds extends CapturePoint { width: number; height: number }
export interface CaptureViewport { width: number; height: number }

export function readCaptureWindows(value: unknown, viewport: CaptureViewport): CaptureBounds[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 512) throw new Error('截图窗口范围无效，请取消后重新截图。');
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw new Error('截图窗口范围无效，请取消后重新截图。');
    const bounds = entry as Record<string, unknown>;
    const { x, y, width, height } = bounds;
    if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number'
      || ![x, y, width, height].every(Number.isSafeInteger) || x < 0 || y < 0 || width <= 0 || height <= 0
      || x + width > viewport.width || y + height > viewport.height) throw new Error('截图窗口范围无效，请取消后重新截图。');
    return { x, y, width, height };
  });
}

export function captureWindowAt(windows: readonly CaptureBounds[], point: CapturePoint): CaptureBounds | null {
  return windows.find(bounds => point.x >= bounds.x && point.y >= bounds.y
    && point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height) ?? null;
}

export function captureDragStarted(start: CapturePoint, point: CapturePoint): boolean {
  return Math.hypot(point.x - start.x, point.y - start.y) >= 5;
}

export function captureDragBounds(start: CapturePoint, end: CapturePoint, viewport: CaptureViewport): CaptureBounds | null {
  const x0 = Math.max(0, Math.min(viewport.width, Math.round(start.x)));
  const y0 = Math.max(0, Math.min(viewport.height, Math.round(start.y)));
  const x1 = Math.max(0, Math.min(viewport.width, Math.round(end.x)));
  const y1 = Math.max(0, Math.min(viewport.height, Math.round(end.y)));
  if (x0 === x1 || y0 === y1) return null;
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}
