/**
 * Vencord, a Discord client mod
 * Copyright (c) 2026 ilyau
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { Channel, Guild } from "@vencord/discord-types";
import {
    Alerts,
    ChannelStore,
    GuildChannelStore,
    GuildStore,
    Menu,
    RestAPI,
    SelectedChannelStore,
    SelectedGuildStore,
    showToast,
    Toasts,
    UserStore
} from "@webpack/common";

const logger = new Logger("MsgDel");

const DEFAULT = 0;
const REPLY = 19;
const CHAT_INPUT_COMMAND = 20;
const CONTEXT_MENU_COMMAND = 23;
const DELETABLE_TYPES = new Set([DEFAULT, REPLY, CHAT_INPUT_COMMAND, CONTEXT_MENU_COMMAND]);

const CATEGORY = 4;
const DIRECTORY = 14;
const FORUM = 15;
const MEDIA = 16;
const SKIP_HISTORY_TYPES = new Set([CATEGORY, DIRECTORY, FORUM, MEDIA]);

const MIN_DELETE_DELAY = 1000;
const MIN_SEARCH_DELAY = 1500;
const MAX_RETRIES = 8;
const SEARCH_EMPTY_CONFIRM = 2;
const SEARCH_EMPTY_GIVE_UP = 6;

interface Target {
    kind: "channel" | "guild";
    channelId?: string;
    guildId?: string | null;
}

interface DiscordMessage {
    id: string;
    channel_id?: string;
    type?: number;
    author?: { id: string; };
}

interface SearchBody {
    messages?: DiscordMessage[][];
    total_results?: number;
    retry_after?: number;
}

const job = {
    running: false,
    deleted: 0,
    failed: 0,
    total: 0,
    gen: 0
};

let progress: {
    bar: HTMLElement;
    label: HTMLElement;
    fill: HTMLElement;
} | null = null;

class StoppedError extends Error {
    constructor() {
        super("stopped");
        this.name = "StoppedError";
    }
}

const settings = definePluginSettings({
    confirmBeforeDelete: {
        type: OptionType.BOOLEAN,
        description: "Спрашивать подтверждение перед удалением",
        default: true
    },
    deleteDelay: {
        type: OptionType.SLIDER,
        description: "Пауза между удалениями (мс). Ниже 1000 — риск лимитов Discord",
        markers: [1000, 1200, 1500, 2000, 2500, 3000, 4000, 5000],
        default: 1200,
        stickToMarkers: false
    },
    searchDelay: {
        type: OptionType.SLIDER,
        description: "Пауза между поиском следующих сообщений (мс)",
        markers: [1500, 2000, 2500, 3000, 4000, 5000, 7000],
        default: 2500,
        stickToMarkers: false
    },
    actions: {
        type: OptionType.COMPONENT,
        description: "Быстрые действия",
        component: () => (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                <Button onClick={() => startFromCurrent("channel")}>Текущий чат</Button>
                <Button onClick={() => startFromCurrent("guild")}>Текущий сервер</Button>
                <Button variant="dangerPrimary" onClick={() => stopJob(true)}>Стоп</Button>
            </div>
        )
    }
});

function clampDelay(value: number, min: number) {
    const n = Number(value);
    return Math.max(min, Number.isFinite(n) ? n : min);
}

function deleteDelay() {
    return clampDelay(settings.store.deleteDelay, MIN_DELETE_DELAY);
}

function searchDelay() {
    return clampDelay(settings.store.searchDelay, MIN_SEARCH_DELAY);
}

function sleep(ms: number) {
    const gen = job.gen;
    const abortable = job.running;

    return new Promise<void>((resolve, reject) => {
        window.setTimeout(() => {
            if (abortable && (!job.running || job.gen !== gen))
                reject(new StoppedError());
            else
                resolve();
        }, Math.max(0, ms));
    });
}

function httpStatus(err: unknown) {
    if (!err || typeof err !== "object") return;
    const e = err as Record<string, any>;
    return e.status ?? e.statusCode ?? e.response?.status;
}

function retryAfterMs(err: unknown) {
    const e = err as Record<string, any> | undefined;
    const sec = Number(e?.body?.retry_after ?? e?.retry_after ?? e?.response?.body?.retry_after ?? 2);
    return (Number.isFinite(sec) ? sec : 2) * 1000 + 400;
}

function isDeletable(msg: DiscordMessage | undefined, authorId: string) {
    return Boolean(msg?.id && msg.author?.id === authorId && DELETABLE_TYPES.has(msg.type ?? 0));
}

function isHistoryChannel(channel: Channel) {
    return Boolean(channel?.id) && !SKIP_HISTORY_TYPES.has(channel.type);
}

function describeTarget(target: Target) {
    if (target.kind === "guild") {
        const guild = GuildStore.getGuild(target.guildId!);
        return `сервере «${guild?.name ?? target.guildId}»`;
    }

    const channel = ChannelStore.getChannel(target.channelId!);
    if (!channel) return "этом чате";
    if (channel.guild_id) return `#${channel.name}`;
    return channel.name ? `чате «${channel.name}»` : "личном чате";
}

function toast(message: string, type = Toasts.Type.MESSAGE) {
    showToast(message, type);
}

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs?: Record<string, string>,
    children?: Array<Node | string>
) {
    const node = document.createElement(tag);
    if (attrs) {
        for (const [key, value] of Object.entries(attrs)) {
            if (key === "style") node.style.cssText = value;
            else node.setAttribute(key, value);
        }
    }
    if (children) node.append(...children);
    return node;
}

function ensureProgressBar() {
    if (progress && document.body.contains(progress.bar)) return;

    removeProgressBar();

    const label = el("div", { id: "vc-msgdel-label" }, ["MsgDel"]);
    const stop = el("button", {
        id: "vc-msgdel-stop",
        type: "button",
        style: "background:var(--button-danger-background,#ed4245);color:var(--white,#fff);border:0;border-radius:4px;padding:4px 10px;cursor:pointer;flex-shrink:0"
    }, ["Стоп"]);
    const fill = el("div", {
        id: "vc-msgdel-fill",
        style: "height:100%;width:0;background:var(--brand-500,#5865f2);transition:width .2s"
    });

    const bar = el("div", {
        id: "vc-msgdel-progress",
        style: [
            "position:fixed",
            "top:0",
            "left:0",
            "right:0",
            "z-index:100000",
            "background:var(--background-floating,#1e1f22)",
            "color:var(--text-normal,#fff)",
            "font:12px/1.4 var(--font-primary,Whitney,sans-serif)",
            "padding:8px 12px",
            "display:flex",
            "flex-direction:column",
            "gap:6px",
            "box-shadow:0 2px 8px rgba(0,0,0,.45)"
        ].join(";")
    }, [
        el("div", {
            style: "display:flex;justify-content:space-between;align-items:center;gap:12px"
        }, [label, stop]),
        el("div", {
            style: "height:6px;background:var(--background-modifier-accent,#313338);border-radius:4px;overflow:hidden"
        }, [fill])
    ]);

    stop.addEventListener("click", () => stopJob(true));
    document.body.appendChild(bar);
    progress = { bar, label, fill };
}

function updateProgress(phase: string) {
    if (!progress) return;

    const total = Math.max(job.total, job.deleted);
    const pct = total > 0 ? Math.min(100, Math.round((job.deleted / total) * 100)) : 0;
    progress.label.textContent = `${phase} · удалено ${job.deleted}${total ? ` / ~${total}` : ""}${job.failed ? ` · ошибок ${job.failed}` : ""}`;
    progress.fill.style.width = `${pct}%`;
}

function removeProgressBar() {
    progress?.bar.remove();
    document.getElementById("vc-msgdel-progress")?.remove();
    progress = null;
}

function stopJob(notify = false) {
    if (!job.running) {
        if (notify) toast("Удаление уже не идёт");
        return;
    }

    job.running = false;
    job.gen++;
    if (notify) toast("Останавливаю удаление…");
}

async function restGet<T = unknown>(url: string, query?: Record<string, unknown>): Promise<T | null> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const res = await RestAPI.get({ url, query });
            const retry = Number(res?.body?.retry_after);
            if (retry > 0) {
                await sleep(retry * 1000 + 400);
                continue;
            }
            return res.body as T;
        } catch (err) {
            if (err instanceof StoppedError) throw err;
            const status = httpStatus(err);
            if (status === 401) throw err;
            if (status === 202 || status === 429) {
                await sleep(retryAfterMs(err));
                continue;
            }
            throw err;
        }
    }

    return null;
}

async function deleteMessage(channelId: string, messageId: string) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            await RestAPI.del({ url: `/channels/${channelId}/messages/${messageId}` });
            return true;
        } catch (err) {
            if (err instanceof StoppedError) throw err;
            const status = httpStatus(err);
            if (status === 401) throw err;
            if (status === 404) return true;
            if (status === 400 || status === 403) return false;
            if (status === 429) {
                await sleep(retryAfterMs(err));
                continue;
            }
            if (attempt === MAX_RETRIES - 1) return false;
            await sleep(300 * 2 ** attempt);
        }
    }

    return false;
}

function searchQuery(target: Target, authorId: string) {
    const query: Record<string, unknown> = {
        author_id: authorId,
        include_nsfw: true,
        sort_by: "timestamp",
        sort_order: "desc"
    };

    if (target.kind === "channel" && target.guildId && target.channelId)
        query.channel_id = target.channelId;

    return query;
}

function searchUrl(target: Target) {
    if (target.guildId) return `/guilds/${target.guildId}/messages/search`;
    return `/channels/${target.channelId}/messages/search`;
}

function flattenHits(body: SearchBody | null, authorId: string) {
    const groups = body?.messages ?? [];
    const seen = new Set<string>();
    const out: { id: string; channelId: string; }[] = [];

    for (const group of groups) {
        for (const msg of group) {
            if (!isDeletable(msg, authorId) || seen.has(msg.id)) continue;
            seen.add(msg.id);
            out.push({ id: msg.id, channelId: msg.channel_id ?? "" });
        }
    }

    return out.filter(msg => msg.channelId);
}

async function previewCount(target: Target, authorId: string) {
    if (!target.guildId && target.kind === "channel") return null;

    try {
        const body = await restGet<SearchBody>(searchUrl(target), searchQuery(target, authorId));
        const total = body?.total_results;
        return typeof total === "number" ? total : null;
    } catch (err) {
        if (err instanceof StoppedError) throw err;
        logger.warn("preview failed", err);
        return null;
    }
}

async function recordDelete(channelId: string, messageId: string) {
    const ok = await deleteMessage(channelId, messageId);
    if (ok) job.deleted++;
    else job.failed++;
    updateProgress("Удаление");
}

async function deleteBySearch(target: Target, authorId: string) {
    let empty = 0;
    let first = true;

    while (job.running) {
        if (!first) await sleep(searchDelay());
        first = false;

        const body = await restGet<SearchBody>(searchUrl(target), searchQuery(target, authorId));
        const messages = flattenHits(body, authorId);
        const remaining = body?.total_results;

        if (typeof remaining === "number")
            job.total = job.deleted + remaining;

        updateProgress("Поиск");

        if (!messages.length) {
            empty++;
            if ((remaining ?? 0) === 0 && empty >= SEARCH_EMPTY_CONFIRM) break;
            if (empty >= SEARCH_EMPTY_GIVE_UP) break;
            await sleep(1500 * empty);
            continue;
        }

        empty = 0;

        for (const msg of messages) {
            await sleep(deleteDelay());
            await recordDelete(msg.channelId, msg.id);
        }
    }
}

async function deleteByHistory(channelId: string, authorId: string) {
    let before: string | undefined;

    while (job.running) {
        const query: Record<string, unknown> = { limit: 100 };
        if (before) query.before = before;

        let messages: DiscordMessage[] = [];
        try {
            const body = await restGet<DiscordMessage[]>(`/channels/${channelId}/messages`, query);
            messages = Array.isArray(body) ? body : [];
        } catch (err) {
            if (err instanceof StoppedError) throw err;
            logger.error("history fetch failed", err);
            break;
        }

        if (!messages.length) break;
        before = messages[messages.length - 1].id;

        for (const msg of messages) {
            if (!isDeletable(msg, authorId)) continue;
            await sleep(deleteDelay());
            await recordDelete(msg.channel_id ?? channelId, msg.id);
            job.total = Math.max(job.total, job.deleted);
        }

        if (messages.length < 100) break;
        await sleep(searchDelay());
    }
}

function channelsForGuild(guildId: string) {
    const byId = new Map<string, Channel>();
    const cached = (ChannelStore as any).getMutableGuildChannelsForGuild?.(guildId);

    if (cached && typeof cached === "object") {
        for (const channel of Object.values(cached) as Channel[]) {
            if (channel?.id) byId.set(channel.id, channel);
        }
    }

    const grouped = GuildChannelStore.getChannels(guildId) as {
        SELECTABLE?: Array<{ channel?: Channel; } | Channel>;
        VOCAL?: Array<{ channel?: Channel; } | Channel>;
    };

    for (const entry of [...(grouped?.SELECTABLE ?? []), ...(grouped?.VOCAL ?? [])]) {
        const channel = (entry as any)?.channel ?? entry;
        if (channel?.id) byId.set(channel.id, channel);
    }

    return [...byId.values()].filter(isHistoryChannel);
}

async function deleteGuildByChannels(guildId: string, authorId: string) {
    for (const channel of channelsForGuild(guildId)) {
        if (!job.running) break;
        updateProgress(`#${channel.name ?? channel.id}`);
        await deleteByHistory(channel.id, authorId);
    }
}

async function runJob(target: Target) {
    const authorId = UserStore.getCurrentUser()?.id;
    if (!authorId) {
        toast("Не удалось получить ваш аккаунт", Toasts.Type.FAILURE);
        return;
    }

    if (job.running) {
        toast("Удаление уже запущено. Сначала нажмите Стоп", Toasts.Type.FAILURE);
        return;
    }

    const gen = ++job.gen;
    job.running = true;
    job.deleted = 0;
    job.failed = 0;
    job.total = 0;

    ensureProgressBar();
    updateProgress("Запуск");

    const started = Date.now();

    try {
        try {
            if (target.kind === "guild" || target.guildId)
                await deleteBySearch(target, authorId);
            else
                await deleteByHistory(target.channelId!, authorId);
        } catch (err) {
            if (err instanceof StoppedError) throw err;
            logger.warn("основной метод не сработал, пробую запасной", err);
            toast("Поиск недоступен, переключаюсь на обход истории");
            if (target.channelId)
                await deleteByHistory(target.channelId, authorId);
            else if (target.guildId)
                await deleteGuildByChannels(target.guildId, authorId);
            else
                throw err;
        }

        const sec = Math.max(1, Math.round((Date.now() - started) / 1000));
        toast(`Готово: удалено ${job.deleted} сообщ. за ${sec}с`, Toasts.Type.SUCCESS);
    } catch (err: any) {
        if (err instanceof StoppedError)
            toast(`Остановлено. Удалено ${job.deleted}`);
        else {
            logger.error(err);
            toast(`Ошибка MsgDel: ${err?.message ?? err}`, Toasts.Type.FAILURE);
        }
    } finally {
        if (job.gen === gen) {
            job.running = false;
            removeProgressBar();
        }
    }
}

function confirmAndStart(target: Target) {
    const authorId = UserStore.getCurrentUser()?.id;
    if (!authorId) {
        toast("Не удалось получить ваш аккаунт", Toasts.Type.FAILURE);
        return;
    }

    const where = describeTarget(target);
    void (async () => {
        if (!settings.store.confirmBeforeDelete) {
            void runJob(target);
            return;
        }

        const count = await previewCount(target, authorId);
        const countText = count == null
            ? "все ваши сообщения"
            : `примерно ${count} ваших сообщений`;

        Alerts.show({
            title: "Удалить сообщения?",
            body: (
                <Paragraph>
                    Будут удалены {countText} в {where}. Это необратимо. Плагин удаляет только ваши сообщения, не чужие.
                    Слишком маленькая пауза может привести к лимитам Discord.
                </Paragraph>
            ),
            confirmText: "Удалить",
            cancelText: "Отмена",
            onConfirm: () => void runJob(target)
        });
    })();
}

function startFromCurrent(kind: "channel" | "guild") {
    if (kind === "guild") {
        const guildId = SelectedGuildStore.getGuildId();
        if (!guildId) {
            toast("Сейчас открыт не сервер", Toasts.Type.FAILURE);
            return;
        }
        confirmAndStart({ kind: "guild", guildId });
        return;
    }

    const channelId = SelectedChannelStore.getChannelId();
    const channel = channelId && ChannelStore.getChannel(channelId);
    if (!channel) {
        toast("Нет открытого чата", Toasts.Type.FAILURE);
        return;
    }

    confirmAndStart({
        kind: "channel",
        channelId: channel.id,
        guildId: channel.guild_id
    });
}

function addMenuItem(children: any[], ids: string | string[], item: any) {
    const group = findGroupChildrenByChildId(ids, children, true);
    if (group) group.push(item);
    else children.push(<Menu.MenuGroup>{item}</Menu.MenuGroup>);
}

const channelMenu: NavContextMenuPatchCallback = (children, props: { channel?: Channel; }) => {
    const channel = props?.channel;
    if (!channel) return;

    addMenuItem(
        children,
        ["mute-channel", "unmute-channel", "mark-unread", "close-dm"],
        <Menu.MenuItem
            id="vc-msgdel-channel"
            label="Удалить мои сообщения"
            color="danger"
            action={() => confirmAndStart({
                kind: "channel",
                channelId: channel.id,
                guildId: channel.guild_id
            })}
        />
    );
};

const guildMenu: NavContextMenuPatchCallback = (children, props: { guild?: Guild; }) => {
    const guild = props?.guild;
    if (!guild) return;

    addMenuItem(
        children,
        "privacy",
        <Menu.MenuItem
            id="vc-msgdel-guild"
            label="Удалить мои сообщения на сервере"
            color="danger"
            action={() => confirmAndStart({ kind: "guild", guildId: guild.id })}
        />
    );
};

export default definePlugin({
    name: "MsgDel",
    description: "Удаляет ваши сообщения в выбранном чате или на всём сервере",
    authors: [{ name: "ilyau", id: 0n }],
    tags: ["Messages", "Utility"],
    dependencies: ["CommandsAPI"],
    settings,
    settingsAboutComponent: () => (
        <Paragraph>
            ПКМ по каналу или серверу → «Удалить мои сообщения». Удаляются только ваши сообщения.
            Если Discord начнёт выдавать лимиты — увеличьте паузы в настройках плагина.
        </Paragraph>
    ),

    contextMenus: {
        "channel-context": channelMenu,
        "thread-context": channelMenu,
        "gdm-context": channelMenu,
        "user-context": (children, props: { channel?: Channel; }) => {
            const channel = props?.channel;
            if (!channel || channel.guild_id) return;
            channelMenu(children, { channel });
        },
        "guild-context": guildMenu,
        "guild-header-popout": guildMenu
    },

    toolboxActions: {
        "Удалить мои сообщения в этом чате": () => startFromCurrent("channel"),
        "Удалить мои сообщения на этом сервере": () => startFromCurrent("guild"),
        "Остановить удаление": () => stopJob(true)
    },

    commands: [
        {
            name: "msgdel",
            description: "Удалить ваши сообщения в этом чате или на сервере",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "scope",
                    description: "Где удалять",
                    type: ApplicationCommandOptionType.STRING,
                    required: false,
                    choices: [
                        { name: "chat", displayName: "Этот чат", value: "channel" },
                        { name: "server", displayName: "Весь сервер", value: "server" },
                        { name: "stop", displayName: "Стоп", value: "stop" }
                    ]
                }
            ],
            execute(opts, ctx) {
                const scope = findOption(opts, "scope", "channel");

                if (scope === "stop") {
                    stopJob(true);
                    sendBotMessage(ctx.channel.id, { content: "Останавливаю MsgDel." });
                    return;
                }

                if (scope === "server") {
                    if (!ctx.guild) {
                        sendBotMessage(ctx.channel.id, { content: "Команду сервера можно использовать только на сервере." });
                        return;
                    }
                    confirmAndStart({ kind: "guild", guildId: ctx.guild.id });
                    return;
                }

                confirmAndStart({
                    kind: "channel",
                    channelId: ctx.channel.id,
                    guildId: ctx.channel.guild_id
                });
            }
        }
    ],

    stop() {
        stopJob();
        removeProgressBar();
    }
});
