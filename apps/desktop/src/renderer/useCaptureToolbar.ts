import { useLayoutEffect, type RefObject } from 'react';
import type { CapturePoint, CaptureViewport } from './captureSelection';

export function useCaptureToolbar(root: RefObject<HTMLDivElement | null>, anchor: CapturePoint | null, viewport: CaptureViewport) {
  useLayoutEffect(() => {
    const host = root.current;
    if (!host || !anchor) return;
    let resize: ResizeObserver | undefined;
    const position = () => {
      const toolbar = host.querySelector<HTMLElement>('.screenshots-operations');
      if (!toolbar) return false;
      const { width, height } = toolbar.getBoundingClientRect();
      if (!width || !height) return false;
      const right = anchor.x < width + 20;
      const x = Math.max(8, Math.min(right ? anchor.x + 12 : anchor.x - width - 12, viewport.width - width - 8));
      const y = Math.max(8, Math.min(anchor.y + height + 20 < viewport.height ? anchor.y + 12 : anchor.y - height - 12, viewport.height - height - 8));
      host.style.setProperty('--capture-toolbar-x', `${x}px`);
      host.style.setProperty('--capture-toolbar-y', `${y}px`);
      host.dataset.toolbarDirection = right ? 'right' : 'left';
      if (!resize) { resize = new ResizeObserver(position); resize.observe(toolbar); }
      return true;
    };
    const observer = new MutationObserver(() => { if (position()) observer.disconnect(); });
    if (!position()) observer.observe(host, { childList: true, subtree: true });
    return () => { observer.disconnect(); resize?.disconnect(); host.removeAttribute('data-toolbar-direction'); };
  }, [root, anchor, viewport.width, viewport.height]);
}
