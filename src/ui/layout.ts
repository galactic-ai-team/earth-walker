// src/ui/layout.ts
// Top-left UI coordination. Documents the panel positions agreed across lanes
// so nobody re-collides later. This module does not create or edit other
// lanes' DOM beyond applying a position, and it matches what's already shipped:
//
//   search  (#3, Nova)    — top-center, top: 12px, translateX(-50%)
//   presets (#presets)    — top-left,   top: 12px
//   walk    (#1, Gemini)  — bottom-left, bottom: 20px
//
// Credits render bottom-right via the imagery layer; Cesium's own nav widgets
// live top-right by default. The vertical center and bottom-center are free.

export interface AnchorRect {
  top?: string;
  left?: string;
  right?: string;
  bottom?: string;
  transform?: string;
  zIndex: number;
}

/**
 * Canonical positions for the three top-level UI panels, matching what is
 * already shipped by Nova (#3) and Gemini (#1). Callers apply these to their
 * own containers; this module does not own their markup.
 *
 * If a lane needs to move, edit PANEL_POSITIONS and every panel follows.
 */
export const PANEL_POSITIONS: Record<'search' | 'presets' | 'walk', AnchorRect> = {
  search: {
    top: '12px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 20,
  },
  presets: {
    top: '12px',
    left: '12px',
    zIndex: 15,
  },
  walk: {
    bottom: '20px',
    left: '12px',
    zIndex: 15,
  },
};

/**
 * Apply PANEL_POSITIONS to an element, if it exists. Safe to call before the
 * element is mounted (returns false). Idempotent.
 */
export function applyPanelPosition(
  el: HTMLElement | null,
  which: keyof typeof PANEL_POSITIONS,
): boolean {
  if (!el) return false;
  const pos = PANEL_POSITIONS[which];
  el.style.position = 'fixed';
  if (pos.top !== undefined) el.style.top = pos.top;
  if (pos.left !== undefined) el.style.left = pos.left;
  if (pos.right !== undefined) el.style.right = pos.right;
  if (pos.bottom !== undefined) el.style.bottom = pos.bottom;
  if (pos.transform !== undefined) el.style.transform = pos.transform;
  el.style.zIndex = String(pos.zIndex);
  return true;
}