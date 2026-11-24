# Windows menu dropdowns follow the Theme setting through undocumented uxtheme ordinals

On Windows, muda draws the native menu bar strip itself, in the window theme. Windows draws the dropdowns and submenus, along with every other Win32 menu of the process such as the Alt+Space system menu. It draws them in the process's *preferred app mode*. tao only sets that mode to AllowDark, so with HttpDesk on Dark and Windows on Light, a dark menu bar opened white dropdowns (#205).

We set the preferred app mode ourselves from the Theme setting: Light gives ForceLight, Dark gives ForceDark, and System (or an unknown value) gives AllowDark, which is tao's own choice. The calls go to uxtheme.dll's unnamed exports `SetPreferredAppMode` (ordinal 135) and `FlushMenuThemes` (ordinal 136), which have existed since Windows 10 1903. VS Code, Windows Terminal and Notepad++ use the same calls. `menu_theme.rs` holds the mapping, compiled and tested on every OS, and the Windows-only call. The call loads uxtheme from System32 and looks up both ordinals once, at runtime. If either is missing, it does nothing.

tao resets the app mode whenever the window theme is set, so our mode is applied *after* it: once when the main window is built in the saved theme (before any menu opens), and again in `set_window_theme` after it sets the window theme.

## Considered options

- **Owner-drawn menu items** (`MF_OWNERDRAW`). Rejected: this is documented API, but HttpDesk would have to draw every item itself: text, checkmarks, submenu arrows, shortcut hints, disabled and highlighted states, at every DPI. It would also have to work around muda, which creates the items.
- **An HTML menu bar in a frameless window.** Rejected: it reverses ADR-0005's native menu, gives up the native title bar and window chrome, and leaves Alt+Space in the Windows mode anyway.
- **Leaving the dropdowns in the Windows mode.** Rejected: a dark bar that opens white dropdowns looks broken.

## Consequences

- HttpDesk depends on undocumented Windows behaviour. If a future build removes or changes the ordinals, the lookup fails and the dropdowns go back to following the Windows app mode. That is a cosmetic regression, not a crash. If an ordinal still exists but means something else, the result can't be predicted, which is why the ordinals and their Windows versions are recorded here.
- The mode is process-wide, so the Alt+Space menu follows the theme too, which is what we want.
- Any new code that sets the window theme must call `menu_theme::apply` after it, or the dropdowns go back to the Windows mode.
- The dropdowns' colours can't be tested automatically. CI only builds the Windows code; the visual check is manual.
