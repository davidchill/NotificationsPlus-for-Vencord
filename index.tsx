/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 David Rodriguez and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { Switch } from "@components/Switch";
import { PluginNative } from "@utils/types";
import definePlugin, { OptionType } from "@utils/types";
import { Button, Forms, React, Select, TextInput } from "@webpack/common";

import type { DisplayInfo, ToastConfig, ToastOptions } from "./native";

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

function updateToast() {
    if (settings.store.useCustomNativeToast) Native.updateMainProcessPatch(getToastConfig());
}

let OriginalNotification: typeof window.Notification | null = null;

function getToastConfig(): ToastConfig {
    const {
        toastDisplayIndex, toastCorner, toastOffsetX, toastOffsetY,
        toastDmDisplayIndex, toastDmCorner, toastDmOffsetX, toastDmOffsetY,
        toastDmPersist, toastDmGroupThreshold,
        toastDuration, toastTitleTemplate, toastBodyTemplate, redirectOnClick, toastIconUrl,
        toastFont, toastTitleSize, toastChannelSize, toastBodySize, toastStackSize, toastEntrance, toastGradientBg,
    } = settings.store;
    return {
        displayIndex: toastDisplayIndex,
        corner: toastCorner as ToastOptions["corner"],
        offsetX: toastOffsetX,
        offsetY: toastOffsetY,
        dmDisplayIndex: toastDmDisplayIndex,
        dmCorner: toastDmCorner as ToastOptions["dmCorner"],
        dmOffsetX: toastDmOffsetX,
        dmOffsetY: toastDmOffsetY,
        dmPersist: toastDmPersist,
        dmGroupThreshold: toastDmGroupThreshold,
        duration: toastDuration,
        titleTemplate: toastTitleTemplate,
        bodyTemplate: toastBodyTemplate,
        redirectOnClick,
        iconUrl: toastIconUrl,
        font: toastFont,
        titleSize: toastTitleSize,
        channelSize: toastChannelSize,
        bodySize: toastBodySize,
        stackSize: toastStackSize,
        entrance: toastEntrance,
        gradientBg: toastGradientBg,
    };
}

function applyToastPatch() {
    if (OriginalNotification) return;
    OriginalNotification = window.Notification;

    function PatchedNotification(title: string, options?: NotificationOptions) {
        const {
            toastDisplayIndex, toastCorner, toastOffsetX, toastOffsetY,
            toastDmDisplayIndex, toastDmCorner, toastDmOffsetX, toastDmOffsetY,
            toastDmPersist, toastDmGroupThreshold,
            toastDuration, toastTitleTemplate, toastBodyTemplate, toastIconUrl,
            toastFont, toastTitleSize, toastChannelSize, toastBodySize, toastStackSize, toastEntrance, toastGradientBg,
        } = settings.store;

        Native.showToast({
            title: toastTitleTemplate.replace("{title}", title),
            body: toastBodyTemplate.replace("{body}", options?.body ?? ""),
            icon: toastIconUrl || (options as any)?.icon || "",
            displayIndex: toastDisplayIndex,
            corner: toastCorner as ToastOptions["corner"],
            offsetX: toastOffsetX,
            offsetY: toastOffsetY,
            dmDisplayIndex: toastDmDisplayIndex,
            dmCorner: toastDmCorner as ToastOptions["dmCorner"],
            dmOffsetX: toastDmOffsetX,
            dmOffsetY: toastDmOffsetY,
            dmPersist: toastDmPersist,
            dmGroupThreshold: toastDmGroupThreshold,
            duration: toastDuration,
            font: toastFont,
            titleSize: toastTitleSize,
            channelSize: toastChannelSize,
            bodySize: toastBodySize,
            stackSize: toastStackSize,
            entrance: toastEntrance,
            gradientBg: toastGradientBg,
        });

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
            Native.showToast({
                title: "NotificationsPlus",
                body: "Custom toast is working — looking good?",
                icon: "",
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
                entrance: s.toastEntrance,
                gradientBg: s.toastGradientBg,
            });
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
    toastGradientBg: {
        hidden: true,
        description: "Subtle gradient background on toast",
        type: OptionType.BOOLEAN,
        default: false,
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
        if (settings.store.useCustomNativeToast) applyToastPatch();
    },

    stop() {
        const root = document.documentElement;
        ["--np-top", "--np-bottom", "--np-left", "--np-right"].forEach(v => root.style.removeProperty(v));
        removeToastPatch();
    },
});
