/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 David Rodriguez and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { Switch } from "@components/Switch";
import { findStoreLazy } from "@webpack";
import { PluginNative } from "@utils/types";
import definePlugin, { OptionType } from "@utils/types";
import { Button, FluxDispatcher, Forms, React, Select, TextInput } from "@webpack/common";

import type { DisplayInfo, ToastConfig, ToastOptions } from "./native";

const ChannelStore = findStoreLazy("ChannelStore") as any;

const Native = VencordNative.pluginHelpers.NotificationsPlus as PluginNative<typeof import("./native")>;

// ── In-app overlay positioning ──────────────────────────────────────────────

function applyPosition() {
    const { position, offsetX, offsetY } = settings.store;
    const isTop = position.startsWith("top");
    const isLeft = position.endsWith("left");
    const root = document.documentElement;
    root.style.setProperty("--np-top", isTop ? `${offsetY}px` : "unset");
    root.style.setProperty("--np-bottom", isTop ? "unset" : `${offsetY}px`);
    root.style.setProperty("--np-left", isLeft ? `${offsetX}px` : "unset");
    root.style.setProperty("--np-right", isLeft ? "unset" : `${offsetX}px`);
}

// ── Native toast helpers ─────────────────────────────────────────────────────

// Debounce the main-process config push so rapid keystrokes in number/text inputs
// (e.g. typing "16" or a hex color) coalesce into a single IPC call instead of
// firing one per character.
function debounce<A extends any[]>(fn: (...args: A) => void, ms: number) {
    let t: ReturnType<typeof setTimeout> | null = null;
    return (...args: A) => {
        if (t !== null) clearTimeout(t);
        t = setTimeout(() => { t = null; fn(...args); }, ms);
    };
}

const pushToastConfig = debounce(() => {
    if (settings.store.useCustomNativeToast) Native.updateMainProcessPatch(getToastConfig());
}, 150);

function updateToast() {
    pushToastConfig();
}

let OriginalNotification: typeof window.Notification | null = null;

// Shared placement + appearance snapshot — every consumer of toast settings reads
// this so adding a new setting only requires:
//   1. defining the key in definePluginSettings below
//   2. adding it here
//   3. adding a UI cell in SettingsPanel
// Previously this list lived in three places (getToastConfig, PatchedNotification,
// handleTest) and silently drifted when new fields were added.
function getToastShared() {
    const s = settings.store;
    return {
        displayIndex: s.toastDisplayIndex,
        corner: s.toastCorner as ToastOptions["corner"],
        offsetX: s.toastOffsetX,
        offsetY: s.toastOffsetY,
        dmDisplayIndex: s.toastDmDisplayIndex,
        dmCorner: s.toastDmCorner as ToastOptions["dmCorner"],
        dmOffsetX: s.toastDmOffsetX,
        dmOffsetY: s.toastDmOffsetY,
        dmPersist: s.toastDmPersist,
        dmGroupThreshold: s.toastDmGroupThreshold,
        duration: s.toastDuration,
        font: s.toastFont,
        titleSize: s.toastTitleSize,
        channelSize: s.toastChannelSize,
        bodySize: s.toastBodySize,
        stackSize: s.toastStackSize,
        entrance: s.toastEntrance as ToastOptions["entrance"],
        gradientBg: s.toastGradientBg,
        bgOpacity: s.toastBgOpacity,
        dmAccent: s.toastDmAccent,
        serverAccent: s.toastServerAccent,
        alwaysOnTop: s.toastAlwaysOnTop,
        coalesceWindowMs: s.toastCoalesceWindowMs,
        poolMin: s.toastPoolMin,
    };
}

function getToastConfig(): ToastConfig {
    const s = settings.store;
    return {
        ...getToastShared(),
        titleTemplate: s.toastTitleTemplate,
        bodyTemplate: s.toastBodyTemplate,
        redirectOnClick: s.redirectOnClick,
        iconUrl: s.toastIconUrl,
    };
}

function buildToastOptions(callTitle: string, callBody: string, callIcon: string): ToastOptions {
    const s = settings.store;
    return {
        ...getToastShared(),
        title: s.toastTitleTemplate.replace("{title}", callTitle),
        body: s.toastBodyTemplate.replace("{body}", callBody),
        icon: s.toastIconUrl || callIcon,
    };
}

function applyToastPatch() {
    if (OriginalNotification) return;
    OriginalNotification = window.Notification;

    function PatchedNotification(title: string, options?: NotificationOptions) {
        Native.showToast(buildToastOptions(title, options?.body ?? "", (options as any)?.icon ?? ""));
        return { onclick: null, onclose: null, close() { } };
    }

    Object.defineProperty(PatchedNotification, "permission", {
        get: () => "granted" as NotificationPermission,
        configurable: true,
    });
    (PatchedNotification as any).requestPermission = async () => "granted" as NotificationPermission;

    (window as any).Notification = PatchedNotification;
    document.body.classList.add("np-toast-active");

    // Also intercept Electron's main-process Notification, which is the path
    // Discord uses for its own message notifications.
    Native.startMainProcessPatch(getToastConfig());
}

function removeToastPatch() {
    if (!OriginalNotification) return;
    window.Notification = OriginalNotification;
    OriginalNotification = null;
    document.body.classList.remove("np-toast-active");
    Native.stopMainProcessPatch();
}

// ── Jump-to-message fallback ──────────────────────────────────────────────────
//
// On at least one Discord build the toastXml that the main process receives has no
// `launch=` attribute, so native.ts's extractNavData can never recover the channel/
// message IDs. Without IDs the click handler can only emit("click") (opens the
// channel) — the "jump to the specific message" feature silently degrades.
//
// We restore it from the renderer side, where the IDs are first-class:
//   1. Subscribe to MESSAGE_CREATE via FluxDispatcher and maintain a small LRU map
//      keyed by the same "#channel-name, Category" string that appears in the
//      notification title — so the lookup is a direct Map.get with no search.
//   2. Expose `window.__npJumpFromTitle(rawTitle)` for native to invoke via
//      executeJavaScript on click when navData is null.
//
// Cost: one Map.set per Discord message anywhere in the user's account. Bounded at
// MAX_RECENT_KEYS entries with LRU eviction so chatty users don't accumulate.
const MAX_RECENT_KEYS = 200;
const recentMessageByChannelKey = new Map<string, { channelId: string; messageId: string; }>();

// Mirrors the title format Discord puts in toastXml: "#name, Category" when the channel
// has a parent category, "#name" otherwise. Must match the substring extracted by
// __npJumpFromTitle below — they form one Map key contract.
function channelContextKey(channelName: string, categoryName: string): string {
    return categoryName ? `#${channelName}, ${categoryName}` : `#${channelName}`;
}

function onMessageCreate(payload: { message?: { channel_id?: string; id?: string; }; }) {
    const msg = payload?.message;
    if (!msg?.channel_id || !msg.id) return;
    const channel = ChannelStore?.getChannel?.(msg.channel_id);
    // Only track server text channels (type 0). DMs/threads/voice/etc. either don't
    // appear in this code path's notifications or aren't reachable via the title parse.
    if (!channel || channel.type !== 0) return;
    const parent = channel.parent_id ? ChannelStore.getChannel(channel.parent_id) : null;
    const key = channelContextKey(channel.name ?? "", parent?.name ?? "");
    // True LRU: delete + re-set so the newest is at the tail of insertion order.
    if (recentMessageByChannelKey.has(key)) recentMessageByChannelKey.delete(key);
    recentMessageByChannelKey.set(key, { channelId: msg.channel_id, messageId: msg.id });
    if (recentMessageByChannelKey.size > MAX_RECENT_KEYS) {
        const oldest = recentMessageByChannelKey.keys().next().value;
        if (oldest !== undefined) recentMessageByChannelKey.delete(oldest);
    }
}

// The jumpToMessage module is stable for the session, so memoize the webpack search
// instead of re-walking the module cache on every toast click. Cached on window.__npJumpMod
// so this helper and native.ts's injected click handler share one lookup. Only cached once
// a non-null result is found, so an early click before the module loads still retries.
function getJumpModule(): any {
    const w = window as any;
    if (!w.__npJumpMod) {
        w.__npJumpMod = w.Vencord?.Webpack?.findByProps?.("jumpToMessage") ?? null;
    }
    return w.__npJumpMod;
}

function installJumpHelper() {
    (window as any).__npJumpFromTitle = function (rawTitle: string) {
        try {
            // Same balanced-paren walk as native's title parser — pull the
            // "#channel-name, Category" substring out of "Username (#channel, Category)".
            const ctxIdx = rawTitle.search(/\s+\(#/);
            if (ctxIdx === -1) return; // DM or unparseable — emit("click") already handled it.
            const openIdx = rawTitle.indexOf("(", ctxIdx);
            let depth = 0;
            let closeIdx = -1;
            for (let i = openIdx; i < rawTitle.length; i++) {
                if (rawTitle[i] === "(") depth++;
                else if (rawTitle[i] === ")") { if (--depth === 0) { closeIdx = i; break; } }
            }
            if (closeIdx === -1) return;
            const key = rawTitle.slice(openIdx + 1, closeIdx); // "#channel-name, Category"
            const nav = recentMessageByChannelKey.get(key);
            if (!nav) return;
            getJumpModule()?.jumpToMessage?.({ channelId: nav.channelId, messageId: nav.messageId, flash: true });
        } catch { /* swallow — never let a click handler throw */ }
    };
}

function uninstallJumpHelper() {
    delete (window as any).__npJumpFromTitle;
    delete (window as any).__npJumpMod;
}

// ── Settings UI ──────────────────────────────────────────────────────────────

const CORNER_OPTIONS = [
    { label: "Bottom Right", value: "bottom-right" },
    { label: "Bottom Left", value: "bottom-left" },
    { label: "Top Right", value: "top-right" },
    { label: "Top Left", value: "top-left" },
];

const FONT_OPTIONS = [
    { label: "Nunito", value: "Nunito" },
    { label: "Inter", value: "Inter" },
    { label: "Poppins", value: "Poppins" },
    { label: "Roboto", value: "Roboto" },
    { label: "Open Sans", value: "Open Sans" },
    { label: "Lato", value: "Lato" },
    { label: "Segoe UI (system)", value: "Segoe UI" },
    { label: "Arial (system)", value: "Arial" },
];

function Cell({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean; }) {
    return (
        <div style={{ gridColumn: full ? "1 / -1" : undefined }}>
            <Forms.FormText style={{ marginBottom: 6, fontSize: 12, color: "var(--text-muted)" }}>
                {label}
            </Forms.FormText>
            {children}
        </div>
    );
}

// Normalize any stored accent value to a valid `#rrggbb` string for <input type="color">.
// Accepts 3-char (#abc) and 6-char (#aabbcc) hex; anything else falls back to Discord
// brand purple so the input still renders something usable rather than going blank.
function normalizeHex(raw: string, fallback = "#5865f2"): string {
    let s = (raw || "").trim().replace(/^#/, "");
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    return /^[0-9a-fA-F]{6}$/.test(s) ? `#${s.toLowerCase()}` : fallback;
}

function ColorPicker({ value, onChange, fallback }: { value: string; onChange: (v: string) => void; fallback?: string; }) {
    const normalized = normalizeHex(value, fallback);
    return (
        <div className="np-color">
            <input
                type="color"
                value={normalized}
                onChange={e => onChange(e.target.value)}
            />
            <span className="np-color-text">{normalized}</span>
        </div>
    );
}

function NumInput({ value, min, onChange }: { value: number; min?: number; onChange: (v: number) => void; }) {
    const [raw, setRaw] = React.useState(String(value));
    React.useEffect(() => { setRaw(String(value)); }, [value]);
    return (
        <input
            type="number"
            className="np-num"
            value={raw}
            min={min}
            onChange={e => {
                setRaw(e.target.value);
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && (min === undefined || v >= min)) onChange(v);
            }}
        />
    );
}

function SubHeader({ children }: { children: React.ReactNode; }) {
    return (
        <div className="np-subheader">{children}</div>
    );
}

function Grid({ children }: { children: React.ReactNode; }) {
    return (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {children}
        </div>
    );
}

function SettingsPanel() {
    const [, rerender] = React.useReducer(n => n + 1, 0);
    const [displays, setDisplays] = React.useState<DisplayInfo[]>([]);
    const s = settings.store;

    React.useEffect(() => {
        Native.getDisplays().then(setDisplays);
    }, []);

    function set<K extends keyof typeof s>(key: K, value: typeof s[K], effect?: () => void) {
        s[key] = value;
        effect?.();
        rerender();
    }

    function handleTest() {
        if (s.useCustomNativeToast) {
            // Fire a DM toast (no channel context in title → isDMTitle = true)
            Native.showToast(buildToastOptions("NotificationsPlus", "DM test — looking good?", ""));
            // Fire a regular server toast (channel context → isDMTitle = false)
            Native.showToast(buildToastOptions("NotificationsPlus (#general, Testing)", "Server notification test — looking good?", ""));
        } else {
            showNotification({
                title: "NotificationsPlus",
                body: "This is a test notification — looking good?",
                noPersist: true,
            });
        }
    }

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

            {/* ── IN-APP OVERLAY ── */}
            <div>
                <Forms.FormTitle tag="h4">In-App Overlay</Forms.FormTitle>
                <Grid>
                    <Cell label="Corner">
                        <Select
                            options={CORNER_OPTIONS}
                            select={v => set("position", v, applyPosition)}
                            isSelected={v => v === s.position}
                            serialize={v => v}
                        />
                    </Cell>
                    <Cell label="Mute notification sound">
                        <Switch
                            checked={s.suppressNotificationSound}
                            onChange={v => set("suppressNotificationSound", v)}
                        />
                    </Cell>
                    <Cell label="Horizontal offset (px)">
                        <NumInput value={s.offsetX} min={0} onChange={v => set("offsetX", v, applyPosition)} />
                    </Cell>
                    <Cell label="Vertical offset (px)">
                        <NumInput value={s.offsetY} min={0} onChange={v => set("offsetY", v, applyPosition)} />
                    </Cell>
                </Grid>
            </div>

            <Forms.FormDivider />

            {/* ── CUSTOM TOAST ── */}
            <div>
                <Forms.FormTitle tag="h4" style={{ marginBottom: 8 }}>Custom Toast Notifications</Forms.FormTitle>
                <div className="np-toggle-row">
                    <Switch
                        checked={s.useCustomNativeToast}
                        onChange={v => set("useCustomNativeToast", v, () => v ? applyToastPatch() : removeToastPatch())}
                    />
                    <Forms.FormText>Replace OS notifications with a custom positionable window</Forms.FormText>
                </div>

                <SubHeader>Server Message Placement</SubHeader>
                <Grid>
                    <Cell label="Monitor (0 = primary)">
                        <NumInput value={s.toastDisplayIndex} min={0} onChange={v => set("toastDisplayIndex", v, updateToast)} />
                    </Cell>
                    <Cell label="Corner">
                        <Select
                            options={CORNER_OPTIONS}
                            select={v => set("toastCorner", v, updateToast)}
                            isSelected={v => v === s.toastCorner}
                            serialize={v => v}
                        />
                    </Cell>
                    <Cell label="Horizontal offset (px)">
                        <NumInput value={s.toastOffsetX} min={0} onChange={v => set("toastOffsetX", v, updateToast)} />
                    </Cell>
                    <Cell label="Vertical offset (px)">
                        <NumInput value={s.toastOffsetY} min={0} onChange={v => set("toastOffsetY", v, updateToast)} />
                    </Cell>
                </Grid>

                <SubHeader>Direct Message Placement</SubHeader>
                <Grid>
                    <Cell label="Monitor (0 = primary)">
                        <NumInput value={s.toastDmDisplayIndex} min={0} onChange={v => set("toastDmDisplayIndex", v, updateToast)} />
                    </Cell>
                    <Cell label="Corner">
                        <Select
                            options={CORNER_OPTIONS}
                            select={v => set("toastDmCorner", v, updateToast)}
                            isSelected={v => v === s.toastDmCorner}
                            serialize={v => v}
                        />
                    </Cell>
                    <Cell label="Horizontal offset (px)">
                        <NumInput value={s.toastDmOffsetX} min={0} onChange={v => set("toastDmOffsetX", v, updateToast)} />
                    </Cell>
                    <Cell label="Vertical offset (px)">
                        <NumInput value={s.toastDmOffsetY} min={0} onChange={v => set("toastDmOffsetY", v, updateToast)} />
                    </Cell>
                </Grid>

                <SubHeader>Direct Message Behavior</SubHeader>
                <Grid>
                    <Cell label="Stay open until dismissed">
                        <Switch
                            checked={s.toastDmPersist}
                            onChange={v => set("toastDmPersist", v, updateToast)}
                        />
                    </Cell>
                    <Cell label="Group after N messages">
                        <NumInput value={s.toastDmGroupThreshold} min={2} onChange={v => set("toastDmGroupThreshold", Math.max(2, v), updateToast)} />
                    </Cell>
                </Grid>

                <SubHeader>Behavior</SubHeader>
                <Grid>
                    <Cell label="Duration in seconds (0 = stays until clicked)">
                        <NumInput value={s.toastDuration} min={0} onChange={v => set("toastDuration", v, updateToast)} />
                    </Cell>
                    <Cell label="Max stacked toasts (1–5)">
                        <NumInput value={s.toastStackSize} min={1} onChange={v => set("toastStackSize", Math.max(1, Math.min(5, v)), updateToast)} />
                    </Cell>
                    <Cell label="Redirect to message on click">
                        <Switch
                            checked={s.redirectOnClick}
                            onChange={v => set("redirectOnClick", v, updateToast)}
                        />
                    </Cell>
                    <Cell label="Show above all other windows">
                        <Switch
                            checked={s.toastAlwaysOnTop}
                            onChange={v => set("toastAlwaysOnTop", v, updateToast)}
                        />
                    </Cell>
                    <Cell label="Coalesce window (ms, 0 = off)" full>
                        <NumInput
                            value={s.toastCoalesceWindowMs}
                            min={0}
                            onChange={v => set("toastCoalesceWindowMs", Math.max(0, Math.min(2000, v)), updateToast)}
                        />
                        <Forms.FormText style={{ marginTop: 4, fontSize: 11, color: "var(--text-muted)" }}>
                            Successive messages in the same channel within this window merge into one toast ("Alice (3 new)").
                            Every toast pays this much latency before showing. Set to 0 to show each message immediately.
                        </Forms.FormText>
                    </Cell>
                    <Cell label="Pool minimum size (1–8)" full>
                        <NumInput
                            value={s.toastPoolMin}
                            min={1}
                            onChange={v => set("toastPoolMin", Math.max(1, Math.min(8, v)), updateToast)}
                        />
                        <Forms.FormText style={{ marginTop: 4, fontSize: 11, color: "var(--text-muted)" }}>
                            Floor for the warm BrowserWindow pool. Each warm window costs ~15–40 MB of RAM at idle but
                            saves a ~50–150 ms cold-create on the first toast after a quiet period. Default 4. Lower to
                            2 if you want to reclaim idle RAM and don't mind a brief stall on the first toast after
                            launch; raise to 6–8 if you frequently get bursts of many simultaneous notifications.
                        </Forms.FormText>
                    </Cell>
                </Grid>

                <SubHeader>Appearance</SubHeader>
                <Grid>
                    <Cell label="Entrance animation">
                        <Select
                            options={[
                                { label: "None", value: "none" },
                                { label: "Slide in", value: "slide" },
                            ]}
                            select={v => set("toastEntrance", v, updateToast)}
                            isSelected={v => v === s.toastEntrance}
                            serialize={v => v}
                        />
                    </Cell>
                    <Cell label="Gradient background">
                        <Switch
                            checked={s.toastGradientBg}
                            onChange={v => set("toastGradientBg", v, updateToast)}
                        />
                    </Cell>
                    {s.toastGradientBg && (
                        <Cell label="Background opacity (0–100)">
                            <NumInput value={s.toastBgOpacity} min={0} onChange={v => set("toastBgOpacity", Math.max(0, Math.min(100, v)), updateToast)} />
                        </Cell>
                    )}
                    <Cell label="DM accent color">
                        <ColorPicker
                            value={s.toastDmAccent}
                            fallback="#23a55a"
                            onChange={v => set("toastDmAccent", v, updateToast)}
                        />
                    </Cell>
                    <Cell label="Server accent color">
                        <ColorPicker
                            value={s.toastServerAccent}
                            fallback="#5865f2"
                            onChange={v => set("toastServerAccent", v, updateToast)}
                        />
                    </Cell>
                    <Cell label="Font family">
                        <Select
                            options={FONT_OPTIONS}
                            select={v => set("toastFont", v, updateToast)}
                            isSelected={v => v === s.toastFont}
                            serialize={v => v}
                        />
                    </Cell>
                    <Cell label="Title size (px)">
                        <NumInput value={s.toastTitleSize} min={8} onChange={v => set("toastTitleSize", v, updateToast)} />
                    </Cell>
                    <Cell label="Channel line size (px)">
                        <NumInput value={s.toastChannelSize} min={8} onChange={v => set("toastChannelSize", v, updateToast)} />
                    </Cell>
                    <Cell label="Body size (px)">
                        <NumInput value={s.toastBodySize} min={8} onChange={v => set("toastBodySize", v, updateToast)} />
                    </Cell>
                </Grid>

                <SubHeader>Content</SubHeader>
                <Grid>
                    <Cell label='Title template — use {title}'>
                        <TextInput
                            value={s.toastTitleTemplate}
                            onChange={v => set("toastTitleTemplate", v, updateToast)}
                        />
                    </Cell>
                    <Cell label='Body template — use {body}'>
                        <TextInput
                            value={s.toastBodyTemplate}
                            onChange={v => set("toastBodyTemplate", v, updateToast)}
                        />
                    </Cell>
                    <Cell label="Icon URL override (blank = Discord's logo)" full>
                        <TextInput
                            value={s.toastIconUrl}
                            onChange={v => set("toastIconUrl", v)}
                            placeholder="https://..."
                        />
                    </Cell>
                </Grid>

                {displays.length > 0 && (
                    <div className="np-monitor-list">
                        {displays.map(d => (
                            <div key={d.index}>
                                <strong style={{ color: "var(--text-normal)" }}>Monitor {d.index}</strong>
                                {d.primary ? " (primary)" : ""} — {d.label} · {d.bounds.width}×{d.bounds.height}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <Forms.FormDivider />

            <div>
                <Forms.FormTitle tag="h4">Diagnostics</Forms.FormTitle>
                <div className="np-toggle-row">
                    <Switch
                        checked={s.npDebug}
                        onChange={v => set("npDebug", v, () => Native.setDebug(v))}
                    />
                    <Forms.FormText>
                        Log internal errors to Discord's devtools console (Ctrl+Shift+I → Console tab).
                        Useful when reporting bugs or diagnosing why a font / icon / notification isn't behaving.
                    </Forms.FormText>
                </div>
            </div>

            <Button onClick={handleTest} style={{ alignSelf: "flex-start" }}>Send test notification</Button>
        </div>
    );
}

// ── Settings ─────────────────────────────────────────────────────────────────

const settings = definePluginSettings({
    // All typed settings are hidden — SettingsPanel above renders the full UI.
    // hidden: true suppresses the auto-generated control while keeping the value in settings.store.
    position: {
        hidden: true,
        description: "Corner for in-app overlay",
        type: OptionType.SELECT,
        options: [
            { label: "Bottom Right", value: "bottom-right", default: true },
            { label: "Bottom Left", value: "bottom-left" },
            { label: "Top Right", value: "top-right" },
            { label: "Top Left", value: "top-left" },
        ],
    },
    offsetX: {
        hidden: true,
        description: "Horizontal offset (px) — in-app overlay",
        type: OptionType.NUMBER,
        default: 16,
    },
    offsetY: {
        hidden: true,
        description: "Vertical offset (px) — in-app overlay",
        type: OptionType.NUMBER,
        default: 16,
    },
    suppressNotificationSound: {
        hidden: true,
        description: "Mute Discord's notification sound",
        type: OptionType.BOOLEAN,
        default: false,
    },
    useCustomNativeToast: {
        hidden: true,
        description: "Enable custom toast window",
        type: OptionType.BOOLEAN,
        default: false,
    },
    redirectOnClick: {
        hidden: true,
        description: "Clicking the custom toast opens the message in Discord",
        type: OptionType.BOOLEAN,
        default: true,
    },
    toastDisplayIndex: {
        hidden: true,
        description: "Monitor index (0 = primary)",
        type: OptionType.NUMBER,
        default: 0,
    },
    toastCorner: {
        hidden: true,
        description: "Corner for custom toast",
        type: OptionType.SELECT,
        options: [
            { label: "Bottom Right", value: "bottom-right", default: true },
            { label: "Bottom Left", value: "bottom-left" },
            { label: "Top Right", value: "top-right" },
            { label: "Top Left", value: "top-left" },
        ],
    },
    toastOffsetX: {
        hidden: true,
        description: "Horizontal offset (px) — custom toast",
        type: OptionType.NUMBER,
        default: 16,
    },
    toastOffsetY: {
        hidden: true,
        description: "Vertical offset (px) — custom toast",
        type: OptionType.NUMBER,
        default: 16,
    },
    toastDmDisplayIndex: {
        hidden: true,
        description: "Monitor index (0 = primary) — DM toasts",
        type: OptionType.NUMBER,
        default: 0,
    },
    toastDmCorner: {
        hidden: true,
        description: "Corner for DM toasts",
        type: OptionType.SELECT,
        options: [
            { label: "Bottom Right", value: "bottom-right", default: true },
            { label: "Bottom Left", value: "bottom-left" },
            { label: "Top Right", value: "top-right" },
            { label: "Top Left", value: "top-left" },
        ],
    },
    toastDmOffsetX: {
        hidden: true,
        description: "Horizontal offset (px) — DM toasts",
        type: OptionType.NUMBER,
        default: 16,
    },
    toastDmOffsetY: {
        hidden: true,
        description: "Vertical offset (px) — DM toasts",
        type: OptionType.NUMBER,
        default: 16,
    },
    toastDmPersist: {
        hidden: true,
        description: "DM toasts stay open until manually dismissed",
        type: OptionType.BOOLEAN,
        default: false,
    },
    toastDmGroupThreshold: {
        hidden: true,
        description: "Max individual DM toasts before overflow condenses into a group summary",
        type: OptionType.NUMBER,
        default: 5,
    },
    toastDuration: {
        hidden: true,
        description: "Seconds before auto-dismiss (0 = stays until clicked)",
        type: OptionType.NUMBER,
        default: 5,
    },
    toastStackSize: {
        hidden: true,
        description: "Maximum number of toasts stacked at once (1–5)",
        type: OptionType.NUMBER,
        default: 3,
    },
    toastAlwaysOnTop: {
        hidden: true,
        description: "Show toast above all other windows (disable to keep it within the Discord layer)",
        type: OptionType.BOOLEAN,
        default: true,
    },
    toastCoalesceWindowMs: {
        hidden: true,
        description: "Per-channel debounce window (ms) for merging burst messages; 0 disables",
        type: OptionType.NUMBER,
        default: 200,
    },
    toastPoolMin: {
        hidden: true,
        description: "Minimum warm BrowserWindow pool size (1–8); higher = more RAM at idle, faster first toast",
        type: OptionType.NUMBER,
        default: 4,
    },
    toastGradientBg: {
        hidden: true,
        description: "Subtle gradient background on toast",
        type: OptionType.BOOLEAN,
        default: false,
    },
    toastBgOpacity: {
        hidden: true,
        description: "Background opacity when gradient is enabled (0–100)",
        type: OptionType.NUMBER,
        default: 88,
    },
    toastEntrance: {
        hidden: true,
        description: "Toast entrance animation style",
        type: OptionType.SELECT,
        options: [
            { label: "None", value: "none", default: true },
            { label: "Slide in", value: "slide" },
        ],
    },
    toastTitleTemplate: {
        hidden: true,
        description: "Title template",
        type: OptionType.STRING,
        default: "{title}",
    },
    toastBodyTemplate: {
        hidden: true,
        description: "Body template",
        type: OptionType.STRING,
        default: "{body}",
    },
    toastIconUrl: {
        hidden: true,
        description: "Icon URL override",
        type: OptionType.STRING,
        default: "",
    },
    toastDmAccent: {
        hidden: true,
        description: "Accent color for DM toasts",
        type: OptionType.STRING,
        default: "#23a55a",
    },
    toastServerAccent: {
        hidden: true,
        description: "Accent color for server toasts",
        type: OptionType.STRING,
        default: "#5865f2",
    },
    toastFont: {
        hidden: true,
        description: "Font for custom toast",
        type: OptionType.SELECT,
        options: [
            { label: "Nunito", value: "Nunito", default: true },
            { label: "Inter", value: "Inter" },
            { label: "Poppins", value: "Poppins" },
            { label: "Roboto", value: "Roboto" },
            { label: "Open Sans", value: "Open Sans" },
            { label: "Lato", value: "Lato" },
            { label: "Segoe UI (system)", value: "Segoe UI" },
            { label: "Arial (system)", value: "Arial" },
        ],
    },
    toastTitleSize: {
        hidden: true,
        description: "Title font size (px)",
        type: OptionType.NUMBER,
        default: 14,
    },
    toastChannelSize: {
        hidden: true,
        description: "Channel line font size (px)",
        type: OptionType.NUMBER,
        default: 12,
    },
    toastBodySize: {
        hidden: true,
        description: "Body font size (px)",
        type: OptionType.NUMBER,
        default: 13,
    },
    npDebug: {
        hidden: true,
        description: "Log internal errors to Discord's devtools console (Ctrl+Shift+I)",
        type: OptionType.BOOLEAN,
        default: false,
    },
    _ui: {
        type: OptionType.COMPONENT,
        description: "",
        component: () => <SettingsPanel />,
    },
});

// ── Plugin ────────────────────────────────────────────────────────────────────

export default definePlugin({
    name: "NotificationsPlus",
    description: "Adds position and offset control to Vencord's in-app notifications, and replaces native OS toasts with a fully positionable custom window",
    authors: [{ name: "David Rodriguez", id: 140194457222905856n }],
    settings,

    patches: [
        {
            // Same module that onePingPerDM patches — Discord's notification dispatch function.
            // Nulling sound when suppressNotificationSound is enabled mutes the ping audio
            // without affecting the visual notification path.
            find: ".getDesktopType()===",
            replacement: {
                match: /sound:(\i\?\i:void 0,volume:\i,onClick)/,
                replace: "sound:$self.settings.store.suppressNotificationSound?void 0:$1",
            },
        },
    ],

    start() {
        applyPosition();
        // Push debug flag to main before any IPC so the first toast (if useCustomNativeToast
        // is enabled) already has the right logging behavior.
        Native.setDebug(settings.store.npDebug);
        // Subscribe to MESSAGE_CREATE unconditionally so the jump-to-message fallback
        // works regardless of whether custom toasts are currently enabled — the user
        // may flip the toggle without restarting Discord, and we want the map already
        // populated by the time the first toast fires.
        FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
        installJumpHelper();
        if (settings.store.useCustomNativeToast) applyToastPatch();
    },

    stop() {
        const root = document.documentElement;
        ["--np-top", "--np-bottom", "--np-left", "--np-right"].forEach(v => root.style.removeProperty(v));
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
        uninstallJumpHelper();
        recentMessageByChannelKey.clear();
        removeToastPatch();
    },
});
