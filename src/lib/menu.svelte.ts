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

  show(e: MouseEvent, items: MenuItem[]) {
    e.preventDefault();
    e.stopPropagation();
    this.open = { x: e.clientX, y: e.clientY, items };
  }

  close() {
    this.open = null;
  }
}

export const menu = new MenuState();
