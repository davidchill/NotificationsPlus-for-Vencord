# NotificationsPlus

A Vencord plugin that extends notification positioning for both Vencord's in-app overlay and Discord's native OS toasts.

## Current version

`0.1.8`

## What it does

**In-app notifications:** Vencord's built-in overlay supports only top-right and bottom-right. NotificationsPlus adds all four corners with configurable pixel offsets.

**Native OS toasts:** An optional toggle intercepts Discord's native OS notifications and replaces them with a custom Electron `BrowserWindow` — a frameless, always-on-top window you control completely. This enables monitor selection, per-corner positioning, click-to-navigate, custom content templates, and icon overrides that the OS notification API doesn't support.

**Sound suppression:** A standalone toggle that mutes Discord's notification ping audio without touching the visual notification.

## Settings

### In-app overlay

| Setting | Options | Default |
|---|---|---|
| Position | Top Right, Top Left, Bottom Right, Bottom Left | Bottom Right |
| Horizontal offset | Any number (px) | 16 |
| Vertical offset | Any number (px) | 16 |

### Sound

| Setting | Options / Type | Default |
|---|---|---|
| Suppress notification sound | Toggle | Off |

### Custom native toast

| Setting | Options / Type | Default |
|---|---|---|
| Enable custom toast | Toggle | Off |
| Click opens message in Discord | Toggle | On |
| Monitor index | Number (see panel for list) | 0 (primary) |
| Corner | Top Right, Top Left, Bottom Right, Bottom Left | Bottom Right |
| Horizontal offset | Number (px) | 16 |
| Vertical offset | Number (px) | 16 |
| Duration | Number (seconds, 0 = until clicked) | 5 |
| Title template | String — use `{title}` | `{title}` |
| Body template | String — use `{body}` | `{body}` |
| Icon URL | String (overrides sender avatar; leave blank to use avatar) | *(blank)* |
| Font | Nunito, Inter, Poppins, Roboto, Open Sans, Lato, Segoe UI, Arial | Nunito |
| Title font size | Number (px) | 14 |
| Channel line font size | Number (px) | 12 |
| Message body font size | Number (px) | 13 |

The settings panel also lists all connected monitors with their index, label, and resolution so you always know which index to enter.

## How it works

### In-app overlay
On `start()`, the plugin writes four CSS custom properties (`--np-top`, `--np-bottom`, `--np-left`, `--np-right`) to `:root`. A single CSS rule in `style.css` applies them to `.vc-notification-root` with `!important`, overriding both Vencord's hardcoded `right: 1rem` and the inline `top`/`bottom` values set by `NotificationComponent` — no webpack patches required. Properties update live on every `onChange`.

### Custom native toast
`native.ts` runs in Electron's main process. On enable, it patches `ElectronNotification.prototype.show` — the shared prototype method called by every Electron `Notification` instance — so the intercept fires regardless of when Discord created the object. Discord on Windows uses `toastXml` (raw Windows Toast XML) rather than setting `title`/`body` directly, so the plugin parses `<text>` elements from the XML as a fallback. The `toastXml` contains exactly two `<text>` elements: `[0]` is the notification title in the format `"Username (#channel-name, Category)"` and `[1]` is the message body. The server name is not included anywhere in Discord's notification data. The custom toast displays: **Username** / **Category | #channel** / **Message**. The sender's avatar is embedded in `toastXml` as a local temp file path; the plugin reads it immediately in the main process and converts it to a base64 data URI so it can be inlined into the toast HTML (a sandboxed `BrowserWindow` cannot load bare file paths from a `data:` page).

The toast window is created hidden (`show: false`) at a minimum height of 113 px. After the HTML loads, the plugin measures `document.documentElement.scrollHeight` via `webContents.executeJavaScript` and resizes the window to fit the content (capped at 400 px), re-anchoring the `y` position for bottom-corner toasts before calling `win.show()`. This means the window always appears at its final size with no visible resize flash. Font selection injects a Google Fonts `<link>` tag into the toast HTML at render time; system font choices (Segoe UI, Arial) skip the network request entirely. Right-clicking anywhere on the toast dismisses it immediately; because the window is frameless, Electron shows no context menu.

**Multiple notifications (bump and replace):** Only one custom toast is ever visible per corner/display combination at a time. When a new notification arrives while a toast is showing, the existing window is closed immediately and the new one takes its place. This prevents notifications from layering on top of each other without the risk of stacking off-screen. Tracked internally via an `activeToasts` map keyed by `"${displayIndex}-${corner}"`.

`native.ts` exports:

- `getDisplays()` — calls `electron.screen.getAllDisplays()` and returns display metadata
- `showToast(options)` — IPC-callable; creates a `BrowserWindow` (frameless, transparent, always-on-top, `focusable: false`) at exact pixel coordinates computed from the target display's bounds plus corner and offsets; loads an inline HTML toast via base64 data URI; auto-closes after the configured duration
- `startMainProcessPatch(config)` / `updateMainProcessPatch(config)` / `stopMainProcessPatch()` — manage the prototype patch and keep toast config in sync with renderer settings

**Click-to-navigate:** When `redirectOnClick` is on, the toast's `onclick` navigates to `vc-np://click` instead of calling `window.close()`. The main process intercepts this via `webContents.on('will-navigate')`, cancels the navigation, closes the window, and calls `notifInstance.emit('click')` on the original `Notification` instance — triggering Discord's own registered handler, which navigates to the source channel and message.

### Sound suppression
A webpack patch on Discord's notification dispatch module sets the `sound` property to `undefined` when `suppressNotificationSound` is enabled. This mutes the ping audio before it reaches Discord's audio system, with no effect on the visual notification path.

## Files

- `index.tsx` — plugin logic, settings, webpack patches, `window.Notification` patch, CSS variable management
- `native.ts` — Electron main-process functions: display enumeration, BrowserWindow toast creation, `ElectronNotification.prototype.show` interception
- `style.css` — CSS rule that applies the in-app overlay position variables
- `README.md` — this file
- `CHANGELOG.md` — version history

## Planned features

- Custom toast width and opacity settings
- Per-monitor positioning on multi-display setups (in-app overlay)
