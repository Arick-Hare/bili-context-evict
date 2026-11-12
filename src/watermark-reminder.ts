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
}

export interface WatermarkReminderFileConfig {
    enabled?: boolean;
    ratio?: number;
    cooldownMinutes?: number;
    text?: string;
}

/** 默认：开、30% 阈值、60 分钟冷却、固定前缀 + 文案。 */
export const DEFAULT_WATERMARK_REMINDER: WatermarkReminderConfig = {
    enabled: true,
    ratio: 0.3,
    cooldownMinutes: 60,
    text: "上下文已到 {ratio}%，手头这件事做完去做一遍记忆整合流程。",
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
}): string | null {
    // 适配：把两参 log 包成单参 logger，避免调用处漏传 level（2026-11-11 崩溃修复）
    const logger = opts.log
        ? (m: string) => { try { opts.log!("info", m); } catch {} }
        : undefined;
    if (!opts.cfg.enabled) return null; // 总开关关 → 绝不插入（验收第 4 条）
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
