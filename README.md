# NotificationsPlus

A Vencord plugin that extends notification positioning for both Vencord's in-app overlay and Discord's native OS toasts.

## Current version

`0.2.0`

## What it does

**In-app notifications:** Vencord's built-in overlay supports only top-right and bottom-right. NotificationsPlus adds all four corners with configurable pixel offsets.

**Native OS toasts:** An optional toggle intercepts Discord's native OS notifications and replaces them with a custom Electron `BrowserWindow` — a frameless, always-on-top window you control completely. This enables monitor selection, per-corner positioning, click-to-navigate, custom content templates, toast stacking, DM-specific positioning and persistence, and icon overrides that the OS notification API doesn't support.

**Sound suppression:** A standalone toggle that mutes Discord's notification ping audio without touching the visual notification.

## Performance note

> **Set per-server notifications to "Only @mentions" on servers you don't need to track closely.**
>
> Discord fires a notification for every qualifying message. If a busy server is set to "All Messages", every message in every channel will trigger a toast, which creates a continuous stream of `BrowserWindow` creations and destructions. This can noticeably impact performance over time. Keeping high-traffic servers on "Only @mentions" ensures only genuinely relevant messages reach the plugin. You can configure this per-server in Discord's notification settings (right-click the server icon → Notification Settings).

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
| Background opacity (0–100) | Number (only visible when gradient is on) | 88 |
| DM accent color | Color picker | `#23a55a` |
| Server accent color | Color picker | `#5865f2` |
| Font | Nunito, Inter, Poppins, Roboto, Open Sans, Lato, Segoe UI, Arial | Nunito |
| Title font size | Number (px) | 14 |
| Channel line font size | Number (px) | 12 |
| Message body font size | Number (px) | 13 |
| Title template | String — use `{title}` | `{title}` |
| Body template | String — use `{body}` | `{body}` |
| Icon URL | String (overrides sender avatar; leave blank to use avatar) | *(blank)* |

### Diagnostics

| Setting | Options / Type | Default |
|---|---|---|
| Log internal errors to devtools | Toggle | Off |

When enabled, internal errors are logged to Discord's renderer devtools console (`Ctrl+Shift+I` → Console tab) with a `[NotificationsPlus:<scope>]` tag. Useful when reporting bugs or diagnosing why a font / icon / notification isn't behaving.

The settings panel also lists all connected monitors with their index, label, and resolution so you always know which index to enter.

## How it works

### In-app overlay
On `start()`, the plugin writes four CSS custom properties (`--np-top`, `--np-bottom`, `--np-left`, `--np-right`) to `:root`. A single CSS rule in `style.css` applies them to `.vc-notification-root` with `!important`, overriding both Vencord's hardcoded `right: 1rem` and the inline `top`/`bottom` values set by `NotificationComponent` — no webpack patches required. Properties update live on every `onChange`.

### Custom native toast
`native.ts` runs in Electron's main process. On enable, it patches `ElectronNotification.prototype.show` — the shared prototype method called by every Electron `Notification` instance — so the intercept fires regardless of when Discord created the object. Discord on Windows uses `toastXml` (raw Windows Toast XML) rather than setting `title`/`body` directly, so the plugin parses `<text>` elements from the XML as a fallback. The `toastXml` contains exactly two `<text>` elements: `[0]` is the notification title in the format `"Username (#channel-name, Category)"` and `[1]` is the message body. The server name is not included anywhere in Discord's notification data.

**Toast layout — server messages:** Username / Category (dim purple) / #channel-name (blurple) / Message body. Category names may themselves contain parentheses (e.g. "Community (Non-GTA)"); the plugin uses a balanced-paren walking algorithm to find the true matching `)` for the outer Discord context group rather than stopping at the first `)`.

**Toast layout — direct messages:** Detected when the notification title has no `(#channel, Category)` suffix. DM toasts display Username / "Direct Message" / Message body, and use a green (`#23a55a`) accent color throughout — border, icon background, timer bar, and the "Direct Message" label.

The sender's avatar is embedded in `toastXml` as a local temp file path; the plugin reads it immediately in the main process and converts it to a base64 data URI so it can be inlined into the toast HTML (a sandboxed `BrowserWindow` cannot load bare file paths from a `data:` page).

**BrowserWindow pooling:** Hidden toast windows are pre-created at plugin start and kept warm. The pool size auto-scales between 4 (minimum) and 12 (maximum), targeting `stackSize + dmGroupThreshold + 1` so worst-case concurrent server + DM activity always has buffers ready. When a notification arrives, one is grabbed from the pool instantly — no 100–200ms Chromium process spawn on the hot path. After each acquire, a replacement is created asynchronously via `process.nextTick`. Pool warm-up is deferred to `setImmediate` at plugin start so the IPC returns instantly. The pool is drained on plugin stop.

Each pool window pre-loads a single static template page (`TEMPLATE_HTML`) at creation time via `loadURL` and attaches a **preload script** (`PRELOAD_SRC`, written once per Discord launch to `app.getPath('temp')`) that listens for `np:update` and `np:close-animate` IPC events. When a notification arrives, the main process calls `webContents.send('np:update', data)` — Electron uses structured-clone serialization, which is faster than the previous `executeJavaScript` + JSON.stringify + V8 eval round-trip. The preload reports the rendered `scrollHeight` back via a one-shot reply channel, combining content update and height measurement into a single round-trip. If the preload file write ever fails, the plugin silently falls back to the legacy `executeJavaScript` path (which is why `__npUpdate` is still embedded in `TEMPLATE_HTML`). Sandbox stays on; contextIsolation stays on. Content height is capped at 400 px.

**Font handling:** Google Fonts CSS and `.woff2` files are fetched in parallel at plugin start (using `Promise.all`) via Electron's `net.request` module — respects system proxy settings, has a 10-second per-request timeout that aborts hung connections, and rejects on non-2xx/3xx status codes. Files are base64-encoded and cached in memory as data URIs; every toast gets the font inlined — zero network requests per notification. System font choices (Segoe UI, Arial) skip the fetch entirely. Right-clicking anywhere on the toast dismisses it immediately; because the window is frameless, Electron shows no context menu.

**Toast stacking:** Up to N toasts can be visible simultaneously per display+corner combination (N = "Max stacked toasts", 1–5, default 3 for server messages). Toasts are ordered newest-closest-to-corner, oldest furthest away. `repositionStack()` recomputes all positions as absolute values from the corner edge on every insert and after every height measurement, eliminating the race-condition drift that relative delta-shifting would produce with concurrent notifications.

**DM-specific behavior:** Direct message toasts route to a separate display+corner stack configured in "Direct Message Placement" settings. When "Stay open until dismissed" is on, DM toasts have no timer and never auto-close. When the number of undismissed DM toasts exceeds the "Group after N messages" threshold, the oldest is evicted and a compact 52px group summary window ("N earlier messages") appears at the bottom of the DM stack. The count updates live without reloading the window. Dismissing the group window resets the overflow counter.

`native.ts` exports:

- `getDisplays()` — calls `electron.screen.getAllDisplays()` and returns display metadata
- `showToast(options)` — IPC-callable; acquires a pre-created `BrowserWindow` from the pool (frameless, transparent, always-on-top, `focusable: false`), positions it at exact pixel coordinates computed from the target display's bounds plus corner and offsets, updates the pre-loaded template via the preload IPC channel (or `__npUpdate` fallback), and auto-closes after the configured duration
- `startMainProcessPatch(config)` / `updateMainProcessPatch(config)` / `stopMainProcessPatch()` — manage the prototype patch and keep toast config in sync with renderer settings; `clampToastCaps` runs once at each entry so the hot path can trust the values
- `setDebug(enabled)` — toggles the diagnostics logger (`logErr`), which forwards scoped error messages to Discord's renderer devtools console when on

**Window position animation:** When a toast is dismissed and remaining toasts reposition, a single shared `setInterval` ticker drives every in-flight window move. Each animation is one entry in a `pendingMoves` map; the ticker iterates the map every 16 ms and removes entries as they reach their target. The ticker auto-stops when the map is empty and restarts on the next move, so there's no idle CPU cost.

**Visual styling:** The toast left border emits a soft matching glow (`box-shadow`) in the user-configured accent color. The countdown timer bar carries the same glow, fades to transparent at its right edge via a `linear-gradient`, and uses an ease-out timing curve so it slows near the end. Hovering the toast applies a `scale(1.012)` micro-transform with a short ease transition. A 1px `border-top` in `rgba(255,255,255,.07)` (dark) / `rgba(0,0,0,.05)` (light) creates a "lit from above" highlight that makes the card feel raised. The avatar/icon circle carries a `box-shadow` accent ring matching the DM/server color plus a drop shadow beneath it. When "Gradient background" is enabled, `backdrop-filter: blur(14px) saturate(160%)` is applied alongside a semi-transparent background so desktop content bleeds through subtly; the "Background opacity (0–100)" setting (only visible when gradient is on, default 88) controls the alpha. When the setting is off, the background is a solid `#232428` (dark) / `#ffffff` (light). All toast entrances include a `scale(0.97) → scale(1)` transition plus at minimum a 150ms opacity fade; the "Slide in" entrance extends this with a corner-aware 220ms `cubic-bezier(.22,1,.36,1)` translate. Toasts exit with a smooth animation: clicked/dismissed toasts scale down to 0.96 and fade over 120ms; timer-expired toasts fade out over 150ms. Long message bodies are capped at 3 lines with a gradient mask that fades the bottom when content overflows. DM and server accent colors are user-configurable; all color variants (borders, glows, category text, hover states) are derived dynamically from the chosen hex.

**Body text formatting:** Before rendering, the message body is processed for inline highlights. `@mention` patterns are rendered in the accent color. `https://` and `http://` URLs are rendered in the accent color with an underline. Both patterns are resolved in a single regex pass (URLs matched first) so an `@` inside a URL is never double-processed.

**Open Link button:** When a URL is detected in the toast body, a small "Open Link ↗" button appears in the bottom-right corner. Clicking it calls `shell.openExternal()` to open the URL in the system browser and dismisses the toast.

**Click-to-navigate:** When `redirectOnClick` is on, the toast's `onclick` navigates to `vc-np://click` instead of calling `window.close()`. The `will-navigate` handler also intercepts `vc-np://open-link/<encoded-url>` for the Open Link button. Both routes cancel the navigation, close the window, and take their respective actions.

### Sound suppression
A webpack patch on Discord's notification dispatch module sets the `sound` property to `undefined` when `suppressNotificationSound` is enabled. This mutes the ping audio before it reaches Discord's audio system, with no effect on the visual notification path.

## Files

- `index.tsx` — plugin logic, settings, webpack patches, `window.Notification` patch, CSS variable management, settings panel (color picker, debounced IPC, diagnostics toggle)
- `native.ts` — Electron main-process logic: display enumeration, BrowserWindow toast pool, preload-script generation, `ElectronNotification.prototype.show` interception, `fetchBuffer` via Electron `net`, shared animation ticker, scoped error logger
- `toastTemplate.ts` — toast presentation layer: `TEMPLATE_HTML`, `PRELOAD_SRC`, Discord SVG fallback, and layout dimension constants
- `style.css` — CSS rule that applies the in-app overlay position variables; color picker styling
- `README.md` — this file
- `CHANGELOG.md` — version history

## Planned features

- Custom toast width and opacity settings
- Per-monitor positioning on multi-display setups (in-app overlay)
