import { useCallback, useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';
import { captureDragBounds, captureDragStarted, captureWindowAt, type CaptureBounds, type CapturePoint, type CaptureViewport } from './captureSelection';

interface Press {
  id: number;
  start: CapturePoint;
  window: CaptureBounds | null;
  dragging: boolean;
}

export function useCaptureSelection(root: RefObject<HTMLDivElement | null>, viewport: CaptureViewport, enabled: boolean) {
  const [hovered, setHovered] = useState<CaptureBounds | null>(null);
  const [selectionBounds, setSelectionBounds] = useState<CaptureBounds | null>();
  const [hasSelection, setHasSelection] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const windows = useRef<CaptureBounds[]>([]);
  const hover = useRef<CaptureBounds | null>(null);
  const selected = useRef(false);
  const pointer = useRef<CapturePoint>({ x: -1, y: -1 });
  const press = useRef<Press | null>(null);
  const frame = useRef(0);
  const pendingBounds = useRef<CaptureBounds | null>(null);

  const showHover = useCallback((bounds: CaptureBounds | null) => {
    if (hover.current === bounds) return;
    hover.current = bounds;
    setHovered(bounds);
  }, []);
  const stopFrame = useCallback(() => {
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
  }, []);
  const loadWindows = useCallback((bounds: CaptureBounds[], cursor: CapturePoint | null) => {
    windows.current = bounds;
    if (cursor) pointer.current = cursor;
    showHover(captureWindowAt(bounds, pointer.current));
  }, [showHover]);
  const commit = useCallback((bounds: CaptureBounds | null) => {
    selected.current = bounds !== null;
    setHasSelection(bounds !== null);
    // A new command identity also permits choosing the same window again.
    setSelectionBounds(bounds ? { ...bounds } : null);
    showHover(bounds ? null : captureWindowAt(windows.current, pointer.current));
  }, [showHover]);
  const reset = useCallback(() => {
    stopFrame();
    const active = press.current;
    press.current = null;
    if (active && root.current?.hasPointerCapture(active.id)) root.current.releasePointerCapture(active.id);
    setSelecting(false);
    commit(null);
  }, [stopFrame, root, commit]);
  const boundsChanged = useCallback((bounds: CaptureBounds | null) => {
    selected.current = bounds !== null;
    setHasSelection(bounds !== null);
    if (bounds) showHover(null);
    else if (!press.current) showHover(captureWindowAt(windows.current, pointer.current));
  }, [showHover]);
  const selectHovered = useCallback(() => {
    if (!enabled || press.current || selected.current || !hover.current) return false;
    commit(hover.current);
    return true;
  }, [enabled, commit]);

  const pointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!enabled || selected.current || press.current || event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest('button, input, textarea')) return;
    event.preventDefault(); event.stopPropagation();
    const start = { x: event.clientX, y: event.clientY };
    pointer.current = start;
    press.current = { id: event.pointerId, start, window: captureWindowAt(windows.current, start), dragging: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    showHover(press.current.window);
  }, [enabled, showHover]);

  const pointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    pointer.current = { x: event.clientX, y: event.clientY };
    if (!enabled) return;
    const active = press.current;
    if (active) {
      if (event.pointerId !== active.id) return;
      event.preventDefault(); event.stopPropagation();
      if (!active.dragging && !captureDragStarted(active.start, pointer.current)) return;
      if (!active.dragging) { active.dragging = true; setSelecting(true); showHover(null); }
      pendingBounds.current = captureDragBounds(active.start, pointer.current, viewport);
      // Keep pointer state in refs and crop rendering bounded to display frames.
      if (!frame.current) frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        if (press.current) setSelectionBounds(pendingBounds.current);
      });
    } else if (!selected.current) showHover(captureWindowAt(windows.current, pointer.current));
  }, [enabled, viewport, showHover]);

  const pointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const active = press.current;
    if (!active || event.pointerId !== active.id) return;
    event.preventDefault(); event.stopPropagation();
    pointer.current = { x: event.clientX, y: event.clientY };
    stopFrame();
    const dragged = active.dragging || captureDragStarted(active.start, pointer.current);
    const bounds = dragged ? captureDragBounds(active.start, pointer.current, viewport) : active.window;
    press.current = null;
    if (event.currentTarget.hasPointerCapture(active.id)) event.currentTarget.releasePointerCapture(active.id);
    setSelecting(false);
    commit(bounds);
  }, [stopFrame, viewport, commit]);

  const pointerCancelled = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (press.current?.id === event.pointerId) reset();
  }, [reset]);

  useEffect(() => stopFrame, [stopFrame]);
  return { hovered, selectionBounds, hasSelection, selecting, loadWindows, boundsChanged, selectHovered, reset,
    pointerDown, pointerMove, pointerUp, pointerCancelled };
}
