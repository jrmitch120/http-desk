// Context menu state.
export interface MenuItem {
  label?: string;
  icon?: string;
  action?: () => void;
  danger?: boolean;
  separator?: boolean;
  disabled?: boolean;
}

class MenuState {
  open = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);
  /** Where focus goes back to when the menu closes. */
  private opener: HTMLElement | null = null;

  show(e: MouseEvent, items: MenuItem[]) {
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
    this.opener = target?.matches("[tabindex], button") ? target : document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Opened from the keyboard (no pointer position): place it under the element.
    if (e.clientX === 0 && e.clientY === 0 && target) {
      const r = target.getBoundingClientRect();
      this.open = { x: r.left + 8, y: r.bottom, items };
    } else {
      this.open = { x: e.clientX, y: e.clientY, items };
    }
  }

  /** Closes the menu. `restoreFocus` puts focus back on the element it was opened from. */
  close(restoreFocus = true) {
    this.open = null;
    if (restoreFocus && this.opener?.isConnected) this.opener.focus();
    this.opener = null;
  }
}

export const menu = new MenuState();
