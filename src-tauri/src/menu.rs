//! The native menu bar. The page decides what is in it (src/lib/menuLayout.ts)
//! and sends it with `set_menu` at startup and whenever it changes; the shell
//! only builds it. A click on one of its items is sent back to the page as a
//! `menu` event carrying the item's id, and the page runs the command
//! (ADR-0005). The page greys out and ticks items with `set_menu_state`.
//!
//! Until the page sends its layout, macOS shows Tauri's default menu and
//! Windows and Linux show no menu bar.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

/// A menu in the menu bar, or a submenu.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmenuLayout {
    label: String,
    #[serde(default = "yes")]
    enabled: bool,
    items: Vec<Entry>,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Entry {
    /// Runs the page's command `id`. A checkbox when `checked` is given.
    /// `accelerator` is a key equivalent ("Cmd+S"); the page only sends one on
    /// macOS (ADR-0005).
    #[serde(rename_all = "camelCase")]
    Item {
        id: String,
        label: String,
        accelerator: Option<String>,
        enabled: bool,
        checked: Option<bool>,
    },
    Separator,
    /// An item the OS runs itself; `label` replaces its own text.
    Predefined {
        item: Predefined,
        label: Option<String>,
    },
    Submenu(SubmenuLayout),
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Predefined {
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    /// macOS: through the shell's quit path (quit.rs), which asks about unsaved files.
    Quit,
    Minimize,
    Zoom,
    BringAllToFront,
}

enum Item<R: Runtime> {
    Plain(MenuItem<R>),
    Check(CheckMenuItem<R>),
}

/// The page's items in the menu bar now, by id. One id can have several (Save
/// is in File and in Request).
pub struct NativeMenu<R: Runtime>(Mutex<HashMap<String, Vec<Item<R>>>>);

impl<R: Runtime> NativeMenu<R> {
    pub fn new() -> Self {
        NativeMenu(Mutex::new(HashMap::new()))
    }
}

/// The `menu` event's payload.
#[derive(Clone, Serialize)]
struct Click<'a> {
    id: &'a str,
}

/// Builds the menu bar from `layout` and shows it, replacing the one before.
#[tauri::command]
pub fn set_menu<R: Runtime>(
    app: AppHandle<R>,
    menu: State<'_, NativeMenu<R>>,
    layout: Vec<SubmenuLayout>,
) -> Result<(), String> {
    let mut items = HashMap::new();
    let bar = Menu::new(&app).map_err(crate::err)?;
    for top in layout {
        bar.append(&submenu(&app, top, &mut items).map_err(crate::err)?).map_err(crate::err)?;
    }
    // The items before the bar, so a click on the new bar always finds its id.
    *menu.0.lock().unwrap() = items;
    app.set_menu(bar).map_err(crate::err)?;
    Ok(())
}

/// How the page wants one item to look now; what isn't given stays as it is.
#[derive(Debug, Deserialize)]
pub struct ItemChange {
    id: String,
    enabled: Option<bool>,
    checked: Option<bool>,
}

/// Greys out, enables, ticks or unticks every item with each change's id.
#[tauri::command]
pub fn set_menu_state<R: Runtime>(app: AppHandle<R>, changes: Vec<ItemChange>) -> Result<(), String> {
    let menu = app.state::<NativeMenu<R>>();
    let items = menu.0.lock().unwrap();
    for change in changes {
        for item in items.get(&change.id).into_iter().flatten() {
            match item {
                Item::Plain(i) => {
                    if let Some(enabled) = change.enabled {
                        i.set_enabled(enabled).map_err(crate::err)?;
                    }
                }
                Item::Check(c) => {
                    if let Some(enabled) = change.enabled {
                        c.set_enabled(enabled).map_err(crate::err)?;
                    }
                    if let Some(checked) = change.checked {
                        c.set_checked(checked).map_err(crate::err)?;
                    }
                }
            }
        }
    }
    Ok(())
}

/// A click on menu item `id`: the page's items are sent to it as a `menu` event.
/// Others (the OS's own, Tauri's default menu) aren't the page's to run.
pub fn clicked<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let ours = app.state::<NativeMenu<R>>().0.lock().unwrap().contains_key(id);
    if ours {
        let _ = app.emit("menu", Click { id });
    }
}

fn submenu<R: Runtime>(
    app: &AppHandle<R>,
    layout: SubmenuLayout,
    items: &mut HashMap<String, Vec<Item<R>>>,
) -> tauri::Result<Submenu<R>> {
    let menu = Submenu::new(app, layout.label, layout.enabled)?;
    for entry in layout.items {
        match entry {
            Entry::Item { id, label, accelerator, enabled, checked: None } => {
                let item = MenuItem::with_id(app, id.as_str(), label, enabled, accelerator)?;
                menu.append(&item)?;
                items.entry(id).or_default().push(Item::Plain(item));
            }
            Entry::Item { id, label, accelerator, enabled, checked: Some(checked) } => {
                let item = CheckMenuItem::with_id(app, id.as_str(), label, enabled, checked, accelerator)?;
                menu.append(&item)?;
                items.entry(id).or_default().push(Item::Check(item));
            }
            Entry::Separator => menu.append(&PredefinedMenuItem::separator(app)?)?,
            Entry::Predefined { item, label } => menu.append(&predefined(app, item, label.as_deref())?)?,
            Entry::Submenu(inner) => menu.append(&submenu(app, inner, items)?)?,
        }
    }
    Ok(menu)
}

fn predefined<R: Runtime>(
    app: &AppHandle<R>,
    item: Predefined,
    label: Option<&str>,
) -> tauri::Result<PredefinedMenuItem<R>> {
    match item {
        Predefined::Undo => PredefinedMenuItem::undo(app, label),
        Predefined::Redo => PredefinedMenuItem::redo(app, label),
        Predefined::Cut => PredefinedMenuItem::cut(app, label),
        Predefined::Copy => PredefinedMenuItem::copy(app, label),
        Predefined::Paste => PredefinedMenuItem::paste(app, label),
        Predefined::SelectAll => PredefinedMenuItem::select_all(app, label),
        Predefined::Services => PredefinedMenuItem::services(app, label),
        Predefined::Hide => PredefinedMenuItem::hide(app, label),
        Predefined::HideOthers => PredefinedMenuItem::hide_others(app, label),
        Predefined::ShowAll => PredefinedMenuItem::show_all(app, label),
        Predefined::Quit => PredefinedMenuItem::quit(app, label),
        Predefined::Minimize => PredefinedMenuItem::minimize(app, label),
        Predefined::Zoom => PredefinedMenuItem::maximize(app, label),
        Predefined::BringAllToFront => PredefinedMenuItem::bring_all_to_front(app, label),
    }
}
