# NotificationsPlus

A Vencord plugin that extends the position and offset options for in-app notifications.

## Current version

`0.1.0`

## What it does

Vencord's built-in notification overlay supports two positions (top-right and bottom-right). NotificationsPlus adds all four corners and lets you dial in a pixel offset from each edge.

| Setting | Options | Default |
|---|---|---|
| Position | Top Right, Top Left, Bottom Right, Bottom Left | Bottom Right |
| Horizontal offset | Any number (px) | 16 |
| Vertical offset | Any number (px) | 16 |

## How it works

On `start()`, the plugin writes four CSS custom properties (`--np-top`, `--np-bottom`, `--np-left`, `--np-right`) to `:root` based on the current position and offset settings. Each property is re-applied automatically when any setting changes via `onChange`.

A single CSS rule overrides all four positional properties on `.vc-notification-root` using `!important` and those variables. Because `!important` in a stylesheet beats inline styles, this cleanly overrides both Vencord's hardcoded `right: 1rem` (from its own stylesheet) and the `top`/`bottom` values the `NotificationComponent` sets as inline styles — with no webpack patches required.

## Files

- `index.tsx` — plugin logic, CSS variable management, settings
- `style.css` — single CSS rule that applies the position variables
- `README.md` — this file

## Planned features

- Notification stacking (show multiple at once instead of queuing)
- Custom width and opacity
- Suppress Discord's native OS toasts and replace with this overlay (requires `native.ts`)
- Per-monitor positioning on multi-display setups
