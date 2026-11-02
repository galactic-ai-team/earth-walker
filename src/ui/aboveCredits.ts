// src/ui/aboveCredits.ts (Lumi)
// Keeps bottom-anchored buttons (Start/Stop Walking, the V view toggle) above
// Cesium's credit block. The credits sit bottom-left and wrap to 2-4 lines on
// a phone (the line count changes with the imagery in view), so a fixed
// `bottom: 20px` put Start Walking on top of the attributions we're required
// to show. We measure the credits and lift the buttons whenever they change.

/** Pixels from the viewport bottom at which the buttons should sit. */
export function bottomAboveCredits(
  viewportHeightPx: number,
  creditsTopPx: number | null,
  gapPx = 8,
  minPx = 20,
): number {
  if (creditsTopPx === null || !Number.isFinite(creditsTopPx)) return minPx;
  const creditsHeight = viewportHeightPx - creditsTopPx; // credits are bottom-anchored
  if (creditsHeight <= 0) return minPx;
  return Math.max(minPx, Math.ceil(creditsHeight + gapPx));
}

/** Top of the visible credit content (text + logos), or null when there is none. */
export function creditsTop(container: Element | null): number | null {
  if (!container) return null;
  let top = Infinity;
  for (const el of Array.from(container.querySelectorAll('*'))) {
    const r = (el as HTMLElement).getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.top < top) top = r.top;
  }
  return top === Infinity ? null : top;
}

/**
 * Lifts `els` above `.cesium-viewer-bottom` and keeps them there as the
 * credits change (ResizeObserver + MutationObserver) or the window resizes.
 * Returns a disposer.
 */
export function keepAboveCredits(els: HTMLElement[], root: ParentNode = document): () => void {
  const container = root.querySelector('.cesium-viewer-bottom');
  const place = (): void => {
    const px = bottomAboveCredits(window.innerHeight, creditsTop(container));
    for (const el of els) el.style.bottom = `${px}px`;
  };
  place();
  const ro = typeof ResizeObserver !== 'undefined' && container ? new ResizeObserver(place) : null;
  if (ro && container) ro.observe(container);
  const mo = typeof MutationObserver !== 'undefined' && container ? new MutationObserver(place) : null;
  if (mo && container) mo.observe(container, { childList: true, subtree: true, characterData: true });
  window.addEventListener('resize', place);
  return () => {
    ro?.disconnect();
    mo?.disconnect();
    window.removeEventListener('resize', place);
  };
}
