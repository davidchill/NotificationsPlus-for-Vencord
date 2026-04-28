# Changelog

## v0.1.1 — 2026-04-27

### Added
- **Custom native toast window** — new toggle ("Replace native OS notifications with a custom positionable window") intercepts `window.Notification` in Discord's renderer and redirects every native OS toast to a custom Electron `BrowserWindow` instead. Implemented via a `native.ts` companion file that runs in Electron's main process with full `BrowserWindow` and `electron.screen` access.
- **Multi-monitor support** — `getDisplays()` enumerates all connected displays at startup and lists them (with index, label, and resolution) directly in the settings panel. A numeric "Monitor index" setting controls which display the custom toast appears on.
- **Per-corner positioning for custom toast** — independent corner setting (Top Right, Top Left, Bottom Right, Bottom Left) and X/Y edge offsets for the custom toast window, separate from the existing in-app overlay position controls.
- **Auto-dismiss timer with progress bar** — custom toast closes automatically after a configurable number of seconds (default 5); a blurple progress bar animates across the bottom of the toast to show time remaining. Set to 0 for click-to-dismiss only.
- **Title and body templates** — `{title}` and `{body}` placeholder strings let you reformat the notification content before it's displayed.
- **Icon URL override** — optional field to replace Discord's default logo with any image URL.
- **Context-aware test button** — the "Send test notification" button in the settings panel now fires a `Native.showToast()` test when the custom toast is enabled, or the existing Vencord in-app notification test when it is not.

### How the custom toast works
`native.ts` exports `getDisplays()` and `showToast()`. The build system auto-discovers and registers these as `VencordPluginNative_NotificationsPlus_*` IPC handlers in the main process. The renderer calls them via `VencordNative.pluginHelpers.NotificationsPlus`. `showToast()` creates a frameless, transparent, always-on-top `BrowserWindow` at computed pixel coordinates (derived from `screen.getAllDisplays()` bounds + corner + offsets), loads an inline HTML toast via a base64 data URI, and schedules a close timer. The window never steals focus from Discord (`focusable: false`).

---

## v0.1.0 — 2026-04-27

Initial release.

### Added
- **4-corner positioning** — choose Top Right, Top Left, Bottom Right, or Bottom Left from plugin settings. Vencord's built-in overlay only supports Top Right and Bottom Right.
- **Custom edge offsets** — separate horizontal (X) and vertical (Y) pixel offset fields control how far from each screen edge the notification sits. Default is 16 px on both axes.
- **Live settings update** — position and offsets update immediately when changed; no Discord restart required.
- **Test notification button** — a "Send test notification" button in the plugin settings panel fires a one-off notification to verify placement without waiting for a real Discord event.

### How positioning works
Position is driven entirely by CSS custom properties (`--np-top`, `--np-bottom`, `--np-left`, `--np-right`) written to `:root`. A single CSS rule applies them to `.vc-notification-root` with `!important`, which overrides both Vencord's hardcoded `right: 1rem` and the inline top/bottom styles set by `NotificationComponent` — no webpack patches required.
