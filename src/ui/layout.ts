// src/ui/layout.ts
// Top-left UI coordination. The preset panel (#presets), search box and walk
// button each mount themselves; this module just publishes where they should
// sit so no one overlaps. Purely a positioning helper — it does not create or
// edit the DOM of the other lanes' panels.
//
// Proposed layout (top-left is a vertical stack; right side reserved):
//
//   ┌─────────────────────────────────────────┐
//   │ [search box]           (top center)     │
//   │                                         │
//   │ [presets]      (top-left, y=72)         │
//   │                                         │
//   │ [walk btn]     (bottom-left, y=bottom-16)│
//   └─────────────────────────────────────────┘
//
// Search at top-center keeps it discoverable without hiding the viewport
// corner where presets live. Presets top-left, walk bottom-left — thumb
// reach, no overlap with either the search box or the credits (which the
// imagery layer renders bottom-right).

export interface AnchorRect {
  top?: string;
  left?: string;
  right?: string;
  bottom?: string;
  transform?: string;
  zIndex: number;
}

/**
 * Canonical positions for the three top-level UI panels. Other modules read
 * these and apply them to their own containers; this module does not touch
 * their DOM.
 */
export const PANEL_POSITIONS: Record<'search' | 'presets' | 'walk', AnchorRect> = {
  search: {
    top: '16px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 20,
  },
  presets: {
    top: '72px', // below the centered search box (search is 16px + ~44px tall)
    left: '16px',
    zIndex: 15,
  },
  walk: {
    bottom: '16px',
    left: '16px',
    zIndex: 15,
  },
};

/**
 * Apply PANEL_POSITIONS to an element, if it exists. Safe to call before the
 * element is mounted (returns false). Idempotent — safe to call on every
 * mount/unmount cycle.
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
