// Menu state: the context menu, and menus opened from a button (the top bar's theme menu).
import type { Align } from "./popup/place";

export interface MenuItem {
  label?: string;
  icon?: string;
  action?: () => void;
  danger?: boolean;
  separator?: boolean;
  disabled?: boolean;
  /** Makes the item one of a set of choices (`menuitemradio`); true marks the current one. */
  checked?: boolean;
}

export interface MenuOptions {
  /** Opens below this element (a menu button) instead of at the pointer, and tracks it while open. */
  anchor?: HTMLElement;
  align?: Align;
  /** The menu's accessible name. */
  label?: string;
  /** Called when the menu closes, before a picked item's action runs. */
  onclose?: () => void;
}

interface OpenMenu {
  x: number;
  y: number;
  items: MenuItem[];
  anchor: HTMLElement | null;
  align: Align;
  label: string | undefined;
  onclose: (() => void) | undefined;
}

class MenuState {
  open = $state<OpenMenu | null>(null);
  /** Where focus goes back to when the menu closes. */
  private opener: HTMLElement | null = null;

  show(e: MouseEvent, items: MenuItem[], { anchor, align = "start", label, onclose }: MenuOptions = {}) {
    e.preventDefault();
    e.stopPropagation();
    this.open?.onclose?.();
    const target = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
    this.opener = anchor ?? (target?.matches("[tabindex], button") ? target : document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const base = { items, anchor: anchor ?? null, align, label, onclose };
    // Opened from the keyboard (no pointer position): place it under the element.
    if (e.clientX === 0 && e.clientY === 0 && target) {
      const r = target.getBoundingClientRect();
      this.open = { x: r.left + 8, y: r.bottom, ...base };
    } else {
      this.open = { x: e.clientX, y: e.clientY, ...base };
    }
  }

  /** Whether the menu is open from `anchor` (a menu button's `aria-expanded`). */
  isOpenFrom(anchor: HTMLElement | undefined) {
    return !!anchor && this.open?.anchor === anchor;
  }

  /** Closes the menu. `restoreFocus` puts focus back on the element it was opened from. */
  close(restoreFocus = true) {
    const onclose = this.open?.onclose;
    this.open = null;
    if (restoreFocus && this.opener?.isConnected) this.opener.focus();
    this.opener = null;
    onclose?.();
  }
}

export const menu = new MenuState();
