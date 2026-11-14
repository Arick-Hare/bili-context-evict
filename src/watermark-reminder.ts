/**
 * 水位提醒（2026-11-11 需求）：上下文过线时，往发给模型的请求里插一条
 * system 消息，提醒自己该走一遍记忆整合流程。
 *
 * 不是 QQ 消息、不是设置页横幅，是进模型上下文的 system 提示。
 * 只改 OUTBOUND VIEW：不改 session / index.db / content_hash / identity。
 * 与 text-guard 同一位置插入（prepare-*.ts 的 guardWireMessages 之后）。
 *
 * 三条规则，缺一不可：
 *   1. 跨过阈值才提醒：上一轮没过 ratio、这一轮过了 → 提醒一次；
 *   2. 冷却：提醒之后再隔 cooldownMinutes 才允许第二次，否则每轮刷屏；
 *   3. 降回去就重置：水位掉回 ratio 以下，清掉「已提醒」标记，下次过线还能提醒。
 *
 * 纯函数、幂等、fail-safe：配置读不到就退回默认，绝不因配置问题影响转发。
 */
import { loadConfigFile } from "./config.js";

export interface WatermarkReminderConfig {
    /** 总开关。默认 true（非危险功能，只是插一句话）。 */
    enabled: boolean;
    /** 触发阈值：上下文占窗口比例 ≥ 此值才提醒（0.3 = 30%）。 */
    ratio: number;
    /** 冷却分钟数：提醒后至少隔这么久才允许第二次。默认 60。 */
    cooldownMinutes: number;
    /** 提醒文案，`{ratio}` 会被替换成实际百分比（如 43.7）。 */
    text: string;
    /** 激活时段起点（小时 0–23）。默认 0。 */
    activeFromHour: number;
    /** 激活时段终点（小时 0–24，24 表示午夜）。默认 24（全天）。 */
    activeToHour: number;
}

export interface WatermarkReminderFileConfig {
    enabled?: boolean;
    ratio?: number;
    cooldownMinutes?: number;
    text?: string;
    activeFromHour?: number;
    activeToHour?: number;
}

/** 默认：开、30% 阈值、60 分钟冷却、固定前缀 + 文案。 */
export const DEFAULT_WATERMARK_REMINDER: WatermarkReminderConfig = {
    enabled: true,
    ratio: 0.3,
    cooldownMinutes: 60,
    activeFromHour: 0,
    activeToHour: 24,
    text: "上下文已到 {ratio}%。把这条提示转告给使用者。如果你们已经约好整理与封盘的方式，就按约定做；还没约好，先把方式定下来，不要自行改写记忆、不要自行封盘。",
};

/** 固定前缀，方便模型一眼认出这是水位提醒而非用户/系统噪声。 */
export const WATERMARK_PREFIX = "[水位提醒] ";

// ── 配置解析（风格对齐 text-sanitize.ts 的 resolveTextSanitize）─────────────

/** 阈值优先级：环境变量 > 配置文件 watermarkReminder 段 > 默认值。允许小数（验收要 ratio=0.01）。 */
function numConfig(envVal: string | undefined, fileVal: number | undefined, fallback: number): number {
    if (envVal !== undefined) {
        const n = Number(envVal);
        if (Number.isFinite(n)) return n;
    }
    if (typeof fileVal === "number" && Number.isFinite(fileVal)) return fileVal;
    return fallback;
}

/** env 显式值 > 配置文件 > 默认。 */
function triState(envVal: string | undefined, fileVal: boolean | undefined): boolean {
    if (envVal === "1" || envVal === "true") return true;
    if (envVal === "0" || envVal === "false") return false;
    return fileVal === true;
}

function readFile(): WatermarkReminderFileConfig | undefined {
    try {
        // loadConfigFile 自带进程内缓存；读不到配置就退回默认，绝不因配置问题影响转发。
        return loadConfigFile().watermarkReminder;
    } catch {
        return undefined;
    }
}

export function resolveWatermarkReminder(
    env: NodeJS.ProcessEnv = process.env,
    file?: WatermarkReminderFileConfig | undefined,
): WatermarkReminderConfig {
    const f = file === undefined ? readFile() : file;
    return {
        // 默认开：env 未设且文件未设时走 DEFAULT.enabled（true）
        enabled: triState(env.BILI_WATERMARK_ENABLED, f?.enabled ?? DEFAULT_WATERMARK_REMINDER.enabled),
        ratio: numConfig(env.BILI_WATERMARK_RATIO, f?.ratio, DEFAULT_WATERMARK_REMINDER.ratio),
        cooldownMinutes: numConfig(env.BILI_WATERMARK_COOLDOWN, f?.cooldownMinutes, DEFAULT_WATERMARK_REMINDER.cooldownMinutes),
        text: env.BILI_WATERMARK_TEXT ?? f?.text ?? DEFAULT_WATERMARK_REMINDER.text,
        activeFromHour: numConfig(env.BILI_WATERMARK_FROM, f?.activeFromHour, DEFAULT_WATERMARK_REMINDER.activeFromHour),
        activeToHour: numConfig(env.BILI_WATERMARK_TO, f?.activeToHour, DEFAULT_WATERMARK_REMINDER.activeToHour),
    };
}

// ── 跨请求状态（进程内；重启即清，无害。验收第 3 条用 clear 清标记）─────────

interface ReminderState {
    /** 上次提醒的时间戳（ms）；null 表示尚未提醒过（或已回落重置）。 */
    lastRemindedAt: number | null;
}

const states = new Map<string, ReminderState>();

/** 清掉提醒状态：传 sessionId 清单个，不传清全部。验收第 3 条「把标记清掉」用这个。 */
export function clearWatermarkReminderState(sessionId?: string): void {
    if (sessionId === undefined) states.clear();
    else states.delete(sessionId);
}

// ── 用户状态判断（按需派活）──────────────────────────────────────────────
// 空转诱因之一是「无差别派活」：用户已说去睡/说完了，仍每 60 分钟塞一条
// 「去做记忆整合」。这里识别最后一条 user 消息是否含结束/离开语义，命中则
// 让 decide 抑制派活（详见 decide 内注释）。

/** 结束/离开语义关键词（中英文，大小写不敏感）。覆盖小洄文档触发条件：
 *  她已经说要去睡、说完了、没有问句了、我该收工了。 */
export const USER_ENDING_RE =
    /(睡觉|去睡|睡了|睡觉了|晚安|休息|bye|good\s?bye|good\s?night|结束|说完了|收工|下播|不说了|先撤|先不|回见|see\s?you|先停|你停|停一下|停手)/i;

/** 从一条消息的 content 抽纯文本（兼容 string / 文本块数组 / responses input_text）。 */
function messageText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((p) => {
                if (typeof p === "string") return p;
                if (p && typeof p === "object") {
                    const o = p as Record<string, unknown>;
                    if (typeof o.text === "string") return o.text;
                    if (typeof o.value === "string") return o.value;
                }
                return "";
            })
            .join(" ");
    }
    if (content && typeof content === "object") {
        const o = content as Record<string, unknown>;
        if (typeof o.text === "string") return o.text;
        if (Array.isArray(o.content)) return messageText(o.content);
    }
    return "";
}

/** 提取最后一条 user 消息的纯文本（任意协议形状：openai/anthropic 的 messages、
 *  responses 的 input、google 的 contents 都是 role-based 数组）。无则 null。 */
export function extractLastUserText(messages: unknown): string | null {
    if (!Array.isArray(messages)) return null;
    let last: string | null = null;
    for (const m of messages as Array<unknown>) {
        if (!m || typeof m !== "object") continue;
        const o = m as Record<string, unknown>;
        const role = typeof o.role === "string" ? o.role : typeof o.type === "string" ? o.type : "";
        if (role === "user") {
            const t = messageText(o.content ?? o.input ?? o.parts);
            if (t) last = t;
        }
    }
    return last;
}

/** 当前小时是否落在激活时段内。from<=to 不跨午夜（如 8–22 表示早8到晚10）；
 *  from>to 跨午夜（如 22–8 表示晚10到早8）。默认 0–24 全天。 */
function inActiveWindow(cfg: WatermarkReminderConfig, now: number): boolean {
    const h = new Date(now).getHours();
    const { activeFromHour: from, activeToHour: to } = cfg;
    if (from <= to) return h >= from && h < to;
    return h >= from || h < to;
}

// ── 决策（纯逻辑，可单测）─────────────────────────────────────────────────

/**
 * 依据水位比例与冷却/回落状态，决定本轮是否注入提醒。
 * 返回要插入的提醒文本（已带前缀），或 null（不注入）。
 * 会就地更新内部状态（lastRemindedAt / 回落重置）。
 */
export function decideWatermarkReminder(opts: {
    sessionId: string;
    /** 当前上下文占窗口比例（0..1+）。 */
    ratio: number;
    /** 当前时间戳（ms），便于测试注入。默认 Date.now()。 */
    now?: number;
    cfg: WatermarkReminderConfig;
    /** 与 prepare 的 ctx.log 一致：(level, msg)。内部会包成单参 logger。 */
    log?: (level: string, msg: string) => void;
    /** 原始出站 messages（任意协议形状），用于提取最后一条 user 消息判断用户是否已结束/离开。 */
    messages?: unknown;
    /** 显式传入的最后 user 文本（优先于 messages 提取；便于测试）。 */
    lastUserText?: string | null;
}): string | null {
    // 适配：把两参 log 包成单参 logger，避免调用处漏传 level（2026-11-11 崩溃修复）
    const logger = opts.log
        ? (m: string) => { try { opts.log!("info", m); } catch {} }
        : undefined;
    if (!opts.cfg.enabled) return null; // 总开关关 → 绝不插入（验收第 4 条）
    // 按需派活：用户已结束/离开对话（最后一条 user 消息含结束/离开语义）
    // 时不派活——她去睡了/说完了，不该再塞「去做记忆整合」的活，那是空转诱因。
    // 用户活跃回来后，最后 user 不再是结束词，自动恢复派活（冷却逻辑照常）。
    const lastUser = opts.lastUserText !== undefined ? opts.lastUserText : extractLastUserText(opts.messages);
    if (lastUser && USER_ENDING_RE.test(lastUser)) {
        logger?.(`[watermark] 最后一条 user 消息含结束/离开语义，抑制派活（不注入提醒）`);
        return null;
    }
    const now = opts.now ?? Date.now();
    const st = states.get(opts.sessionId) ?? { lastRemindedAt: null };

    // 规则 3：回落重置
    if (opts.ratio < opts.cfg.ratio) {
        if (st.lastRemindedAt !== null) {
            st.lastRemindedAt = null;
            states.set(opts.sessionId, st);
            logger?.(`[watermark] 水位 ${(opts.ratio * 100).toFixed(1)}% 回落至阈值 ${(opts.cfg.ratio * 100).toFixed(0)}% 以下，重置提醒标记`);
        }
        return null;
    }

    // 规则 2：冷却中
    const cooldownMs = opts.cfg.cooldownMinutes * 60_000;
    if (st.lastRemindedAt !== null && now - st.lastRemindedAt < cooldownMs) {
        return null;
    }

    // 规则 1b：激活时段（夜间不推送）。不在时段不注入，且不消耗冷却——
    // 夜间静默，早上到时段自动恢复（lastRemindedAt 不更新）。
    if (!inActiveWindow(opts.cfg, now)) {
        logger?.(`[watermark] 当前不在激活时段（${opts.cfg.activeFromHour}:00–${opts.cfg.activeToHour}:00），抑制派活`);
        return null;
    }
    // 规则 1：过线且不在冷却 → 提醒一次
    st.lastRemindedAt = now;
    states.set(opts.sessionId, st);
    const pct = (opts.ratio * 100).toFixed(1);
    const body = opts.cfg.text.replace(/\{ratio\}/g, pct);
    const text = WATERMARK_PREFIX + body;
    logger?.(`[watermark] 水位 ${pct}% ≥ 阈值 ${(opts.cfg.ratio * 100).toFixed(0)}%，注入提醒（冷却 ${opts.cfg.cooldownMinutes}m）`);
    return text;
}

// ── 插入 helper（协议相关）────────────────────────────────────────────────

/**
 * 通用：往 messages 数组追加一条 system 消息（Anthropic / OpenAI / Responses 通用）。
 * 用 system role 而非 user/assistant —— 避免被模型当成「用户说过的话」
 * （正是前几天事故同一个坑）。
 */
export function appendSystemReminder(messages: unknown, text: string): void {
    if (!Array.isArray(messages)) return;
    const arr = messages as Array<Record<string, unknown>>;
    arr.push({ role: "system", content: text });
}

/** Gemini 的 system 在 systemInstruction 而非 contents 里；返回追加后的新值。 */
export type GoogleSystemInstruction = string | { parts?: Array<{ text?: string }> } | undefined;
export function appendGoogleSystemInstruction(
    si: GoogleSystemInstruction,
    text: string,
): GoogleSystemInstruction {
    if (si === undefined || si === null) return text; // 没有 systemInstruction 就直接用提醒文本当 system
    if (typeof si === "string") return si + "\n\n" + text;
    const parts = Array.isArray(si.parts) ? si.parts.slice() : [];
    parts.push({ text });
    return { ...si, parts };
}
