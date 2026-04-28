# NotificationsPlus

A Vencord plugin that extends notification positioning for both Vencord's in-app overlay and Discord's native OS toasts.

## Current version

`0.1.1`

## What it does

**In-app notifications:** Vencord's built-in overlay supports only top-right and bottom-right. NotificationsPlus adds all four corners with configurable pixel offsets.

**Native OS toasts:** An optional toggle intercepts Discord's `window.Notification` calls and replaces them with a custom Electron `BrowserWindow` — a frameless, always-on-top window you control completely. This enables monitor selection, per-corner positioning, custom content templates, and icon overrides that the OS notification API doesn't support.

## Settings

### In-app overlay

| Setting | Options | Default |
|---|---|---|
| Position | Top Right, Top Left, Bottom Right, Bottom Left | Bottom Right |
| Horizontal offset | Any number (px) | 16 |
| Vertical offset | Any number (px) | 16 |

### Custom native toast

| Setting | Options / Type | Default |
|---|---|---|
| Enable custom toast | Toggle | Off |
| Monitor index | Number (see panel for list) | 0 (primary) |
| Corner | Top Right, Top Left, Bottom Right, Bottom Left | Bottom Right |
| Horizontal offset | Number (px) | 16 |
| Vertical offset | Number (px) | 16 |
| Duration | Number (seconds, 0 = until clicked) | 5 |
| Title template | String — use `{title}` | `{title}` |
| Body template | String — use `{body}` | `{body}` |
| Icon URL | String (leave blank for Discord logo) | *(blank)* |

The settings panel also lists all connected monitors with their index, label, and resolution so you always know which index to enter.

## How it works

### In-app overlay
On `start()`, the plugin writes four CSS custom properties (`--np-top`, `--np-bottom`, `--np-left`, `--np-right`) to `:root`. A single CSS rule in `style.css` applies them to `.vc-notification-root` with `!important`, overriding both Vencord's hardcoded `right: 1rem` and the inline `top`/`bottom` values set by `NotificationComponent` — no webpack patches required. Properties update live on every `onChange`.

### Custom native toast
`native.ts` runs in Electron's main process and exports two functions registered automatically as IPC handlers by Vencord's build system:

- `getDisplays()` — calls `electron.screen.getAllDisplays()` and returns display metadata
- `showToast(options)` — creates a `BrowserWindow` (frameless, transparent, always-on-top, `focusable: false`) at exact pixel coordinates computed from the target display's bounds plus the chosen corner and offsets; loads an inline HTML toast via base64 data URI; auto-closes after the configured duration

When the toggle is enabled, the plugin monkey-patches `window.Notification` in the renderer. Every Discord OS toast is intercepted, the title/body templates are applied, and `Native.showToast()` is called instead of the original constructor. The patch is removed on `stop()`.

## Files

- `index.tsx` — plugin logic, settings, `window.Notification` patch, CSS variable management
- `native.ts` — Electron main-process functions: display enumeration and BrowserWindow toast creation
- `style.css` — CSS rule that applies the in-app overlay position variables
- `README.md` — this file
- `CHANGELOG.md` — version history

## Planned features

- Notification stacking (show multiple custom toasts at once instead of queuing)
- Custom toast width and opacity settings
- Click-to-focus Discord and navigate to the source channel
- Per-monitor positioning on multi-display setups (in-app overlay)
