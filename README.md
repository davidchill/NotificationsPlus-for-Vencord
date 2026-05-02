# NotificationsPlus

A Vencord plugin that extends notification positioning for both Vencord's in-app overlay and Discord's native OS toasts.

## Current version

`0.1.13`

## What it does

**In-app notifications:** Vencord's built-in overlay supports only top-right and bottom-right. NotificationsPlus adds all four corners with configurable pixel offsets.

**Native OS toasts:** An optional toggle intercepts Discord's native OS notifications and replaces them with a custom Electron `BrowserWindow` — a frameless, always-on-top window you control completely. This enables monitor selection, per-corner positioning, click-to-navigate, custom content templates, toast stacking, DM-specific positioning and persistence, and icon overrides that the OS notification API doesn't support.

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

### Custom native toast — server message placement

| Setting | Options / Type | Default |
|---|---|---|
| Enable custom toast | Toggle | Off |
| Monitor index | Number (see panel for list) | 0 (primary) |
| Corner | Top Right, Top Left, Bottom Right, Bottom Left | Bottom Right |
| Horizontal offset | Number (px) | 16 |
| Vertical offset | Number (px) | 16 |

### Custom native toast — direct message placement

| Setting | Options / Type | Default |
|---|---|---|
| Monitor index | Number (see panel for list) | 0 (primary) |
| Corner | Top Right, Top Left, Bottom Right, Bottom Left | Bottom Right |
| Horizontal offset | Number (px) | 16 |
| Vertical offset | Number (px) | 16 |

### Custom native toast — direct message behavior

| Setting | Options / Type | Default |
|---|---|---|
| Stay open until dismissed | Toggle | Off |
| Group after N messages | Number (min 2) | 5 |

### Custom native toast — behavior

| Setting | Options / Type | Default |
|---|---|---|
| Duration | Number (seconds, 0 = until clicked) | 5 |
| Max stacked toasts | Number (1–5) | 3 |
| Click opens message in Discord | Toggle | On |

### Custom native toast — appearance & content

| Setting | Options / Type | Default |
|---|---|---|
| Entrance animation | None, Slide in | None |
| Gradient background | Toggle | Off |
| Font | Nunito, Inter, Poppins, Roboto, Open Sans, Lato, Segoe UI, Arial | Nunito |
| Title font size | Number (px) | 14 |
| Channel line font size | Number (px) | 12 |
| Message body font size | Number (px) | 13 |
| Title template | String — use `{title}` | `{title}` |
| Body template | String — use `{body}` | `{body}` |
| Icon URL | String (overrides sender avatar; leave blank to use avatar) | *(blank)* |

The settings panel also lists all connected monitors with their index, label, and resolution so you always know which index to enter.

## How it works

### In-app overlay
On `start()`, the plugin writes four CSS custom properties (`--np-top`, `--np-bottom`, `--np-left`, `--np-right`) to `:root`. A single CSS rule in `style.css` applies them to `.vc-notification-root` with `!important`, overriding both Vencord's hardcoded `right: 1rem` and the inline `top`/`bottom` values set by `NotificationComponent` — no webpack patches required. Properties update live on every `onChange`.

### Custom native toast
`native.ts` runs in Electron's main process. On enable, it patches `ElectronNotification.prototype.show` — the shared prototype method called by every Electron `Notification` instance — so the intercept fires regardless of when Discord created the object. Discord on Windows uses `toastXml` (raw Windows Toast XML) rather than setting `title`/`body` directly, so the plugin parses `<text>` elements from the XML as a fallback. The `toastXml` contains exactly two `<text>` elements: `[0]` is the notification title in the format `"Username (#channel-name, Category)"` and `[1]` is the message body. The server name is not included anywhere in Discord's notification data.

**Toast layout — server messages:** Username / Category (dim purple) / #channel-name (blurple) / Message body. Category names may themselves contain parentheses (e.g. "Community (Non-GTA)"); the plugin uses a balanced-paren walking algorithm to find the true matching `)` for the outer Discord context group rather than stopping at the first `)`.

**Toast layout — direct messages:** Detected when the notification title has no `(#channel, Category)` suffix. DM toasts display Username / "Direct Message" / Message body, and use a green (`#23a55a`) accent color throughout — border, icon background, timer bar, and the "Direct Message" label.

The sender's avatar is embedded in `toastXml` as a local temp file path; the plugin reads it immediately in the main process and converts it to a base64 data URI so it can be inlined into the toast HTML (a sandboxed `BrowserWindow` cannot load bare file paths from a `data:` page).

The toast window is created hidden (`show: false`) at a minimum height of 113 px. Once the HTML is loaded, `win.show()` is called immediately so the toast appears without delay. `document.documentElement.scrollHeight` is then measured via `webContents.executeJavaScript`; if the actual height differs from the 113 px estimate (e.g. a long message body), `repositionStack()` runs to silently correct sibling positions — the new toast itself is already visible at that point. Content is capped at 400 px. Font selection injects a Google Fonts `<link>` tag into the toast HTML at render time; system font choices (Segoe UI, Arial) skip the network request entirely. Right-clicking anywhere on the toast dismisses it immediately; because the window is frameless, Electron shows no context menu.

**Toast stacking:** Up to N toasts can be visible simultaneously per display+corner combination (N = "Max stacked toasts", 1–5, default 3 for server messages). Toasts are ordered newest-closest-to-corner, oldest furthest away. `repositionStack()` recomputes all positions as absolute values from the corner edge on every insert and after every height measurement, eliminating the race-condition drift that relative delta-shifting would produce with concurrent notifications.

**DM-specific behavior:** Direct message toasts route to a separate display+corner stack configured in "Direct Message Placement" settings. When "Stay open until dismissed" is on, DM toasts have no timer and never auto-close. When the number of undismissed DM toasts exceeds the "Group after N messages" threshold, the oldest is evicted and a compact 52px group summary window ("N earlier messages") appears at the bottom of the DM stack. The count updates live without reloading the window. Dismissing the group window resets the overflow counter.

`native.ts` exports:

- `getDisplays()` — calls `electron.screen.getAllDisplays()` and returns display metadata
- `showToast(options)` — IPC-callable; creates a `BrowserWindow` (frameless, transparent, always-on-top, `focusable: false`) at exact pixel coordinates computed from the target display's bounds plus corner and offsets; loads an inline HTML toast via base64 data URI; auto-closes after the configured duration
- `startMainProcessPatch(config)` / `updateMainProcessPatch(config)` / `stopMainProcessPatch()` — manage the prototype patch and keep toast config in sync with renderer settings

**Visual styling:** The toast left border emits a soft matching glow (`box-shadow`) in either blurple or green depending on message type. The countdown timer bar carries the same glow. Hovering the toast applies a `scale(1.012)` micro-transform with a short ease transition. An optional "Gradient background" setting switches `--bg` from a flat fill to a subtle 135° gradient; the gradient values are injected per-notification as CSS variables. An optional "Entrance animation" setting adds a corner-aware 220ms `cubic-bezier(.22,1,.36,1)` slide-in from the screen edge; the `@keyframes` block is only emitted into the HTML when the animation is enabled.

**Body text formatting:** Before rendering, the message body is processed for inline highlights. `@mention` patterns are rendered in the accent color. `https://` and `http://` URLs are rendered in the accent color with an underline. Both patterns are resolved in a single regex pass (URLs matched first) so an `@` inside a URL is never double-processed.

**Open Link button:** When a URL is detected in the toast body, a small "Open Link ↗" button appears in the bottom-right corner. Clicking it calls `shell.openExternal()` to open the URL in the system browser and dismisses the toast.

**Click-to-navigate:** When `redirectOnClick` is on, the toast's `onclick` navigates to `vc-np://click` instead of calling `window.close()`. The `will-navigate` handler also intercepts `vc-np://open-link/<encoded-url>` for the Open Link button. Both routes cancel the navigation, close the window, and take their respective actions.

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
