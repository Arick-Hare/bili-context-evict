/**
 * 出站正文三道闸（2026-11-10「正文污染事故」处方 ① ② ③）。
 *
 * 事故形态：assistant 的 text 里混进 `<user_message …>` 输入复述和短周期循环，
 * 下一轮整段历史回放，模型把「挂在 assistant 角色下、却长得像用户输入」的块
 * 当成用户说过的话 → 假记忆。
 *
 * 三项能力，**默认全关**（通用宿主可能把正文当真正的回复，默认改写是侵入性的）：
 *   - dropAssistantText：请求体里不读回 assistant 的 text 块（治本）；
 *   - sanitize：形状剥离 / 短周期折叠 / 长度上限 / `[[完]]` 收尾（治标 + 兜底）；
 *   - cycleGuard：源头短周期重复时 abort 上游流（在 runaway-guard.ts 里接）。
 * 开关在配置文件 `textGuard` 段或同名环境变量，env 优先。
 *
 * 全部只改 **OUTBOUND VIEW**：不改 session.lastMessages / state / index.db /
 * 会话 .json，不改 content_hash / identity / digest parity。原文完整留在库里。
 * 与 `reasoning-drop.ts` 的 OUTBOUND-only 教条一致。纯函数、幂等、fail-safe。
 */
import { loadConfigFile } from "./config.js";

export interface TextSanitizeConfig {
    /** sanitize 总开关。默认 false。 */
    enabled: boolean;
    /** 出站视图里摘除 assistant text 块。默认 false。 */
    dropAssistantText: boolean;
    /** 源头短周期 abort。默认 false。 */
    cycleGuard: boolean;
    /** 单条 assistant text 的字符上限。默认 4000。 */
    maxChars: number;
    /** 超长时保留的前缀长度。默认 200。 */
    headChars: number;
    /** 短周期连续重复达到多少次判定为失控。默认 12。 */
    cycleMinRepeats: number;
    /** 是否剥离 `<user_message>` / `【来自…】` 等注入形状。默认 true。 */
    stripInjection: boolean;
}

export interface TextGuardFileConfig {
    dropAssistantText?: boolean;
    sanitize?: boolean;
    cycleGuard?: boolean;
    /** 以下三个阈值：env > 配置文件 > 默认值。 */
    maxChars?: number;
    headChars?: number;
    cycleMinRepeats?: number;
}

/** 三项默认全关：这是开源通用插件，不能假设「正文是废纸」。 */
export const DEFAULT_TEXT_SANITIZE: Required<TextSanitizeConfig> = {
    enabled: false,
    dropAssistantText: false,
    cycleGuard: false,
    maxChars: 4000,
    headChars: 200,
    cycleMinRepeats: 10,
    stripInjection: true,
};

/** 约定的收尾暗号：正文写完最后一行写它，之后一律不再往下写。 */
export const TEXT_DONE_MARK = "[[完]]";
export const FOLDED_MARK = "[正文已折叠]";
export const TRUNCATED_MARK = "[正文过长已截断]";

const CLOSED_USER_MSG_RE = /<user_message\b[^>]*>[\s\S]*?<\/user_message>/gi;
const OPEN_USER_MSG_RE = /<user_message\b[^>]*>/gi;
const CLOSE_USER_MSG_RE = /<\/user_message>/gi;
const PRIVATE_SOURCE_RE = /【来自[^\】\n]*】/g;

/** 阈值优先级：环境变量 > 配置文件 textGuard 段 > 默认值。 */
function numConfig(envVal: string | undefined, fileVal: number | undefined, fallback: number): number {
    if (envVal !== undefined) {
        const n = Number(envVal);
        if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
    if (typeof fileVal === "number" && Number.isFinite(fileVal) && fileVal > 0) return Math.floor(fileVal);
    return fallback;
}

/** env 显式值 > 配置文件 > 默认 false。 */
function triState(envVal: string | undefined, fileVal: boolean | undefined): boolean {
    if (envVal === "1" || envVal === "true") return true;
    if (envVal === "0" || envVal === "false") return false;
    return fileVal === true;
}

function readTextGuard(): TextGuardFileConfig | undefined {
    try {
        // loadConfigFile 自带进程内缓存；读不到配置就退回 env-only，绝不因配置问题影响转发。
        return loadConfigFile().textGuard;
    } catch {
        return undefined;
    }
}

export function resolveTextSanitize(
    env: NodeJS.ProcessEnv = process.env,
    file?: TextGuardFileConfig | undefined,
): Required<TextSanitizeConfig> {
    const guard = file === undefined ? readTextGuard() : file;
    return {
        enabled: triState(env.BILI_TEXT_SANITIZE, guard?.sanitize),
        dropAssistantText: triState(env.BILI_TEXT_GUARD_DROP_ASSISTANT_TEXT, guard?.dropAssistantText),
        cycleGuard: triState(env.BILI_GUARDRAIL_TEXT_CYCLE, guard?.cycleGuard),
        maxChars: numConfig(env.BILI_TEXT_SANITIZE_MAX_CHARS, guard?.maxChars, DEFAULT_TEXT_SANITIZE.maxChars),
        headChars: numConfig(env.BILI_TEXT_SANITIZE_HEAD_CHARS, guard?.headChars, DEFAULT_TEXT_SANITIZE.headChars),
        cycleMinRepeats: numConfig(env.BILI_TEXT_SANITIZE_CYCLE_REPEATS, guard?.cycleMinRepeats, DEFAULT_TEXT_SANITIZE.cycleMinRepeats),
        stripInjection: env.BILI_TEXT_SANITIZE_KEEP_TAGS !== "1",
    };
}

/**
 * 短周期循环判定。
 *  - 严格周期：末尾存在长度 1..8 的单元连续重复 ≥ minRepeats 次（抓「好. 好. 好.」）；
 *  - 低熵兜底：末尾 512 字符窗口里不同 2-gram 的占比 < 0.08
 *    （抓「好.」「（停）」「（等）」交替的混合循环，它没有单一周期）。
 * 只看末尾窗口，避免把正常长文里偶然出现的重复当失控。
 */
export function hasShortCycle(text: string, minRepeats: number): boolean {
    if (text.length < 32) return false;
    const tail = text.slice(-512);
    for (let p = 1; p <= 8; p++) {
        if (tail.length < p * minRepeats) continue;
        let run = 1;
        for (let i = tail.length - p; i - p >= 0; i -= p) {
            if (tail.slice(i - p, i) !== tail.slice(i, i + p)) break;
            run++;
        }
        if (run >= minRepeats) return true;
    }
    if (tail.length >= 256) {
        const grams = new Set<string>();
        for (let i = 0; i + 2 <= tail.length; i++) grams.add(tail.slice(i, i + 2));
        if (grams.size / (tail.length - 1) < 0.08) return true;
    }
    return false;
}

export interface SanitizeResult {
    text: string;
    reasons: string[];
}

/** 净化单条正文。幂等：净化结果再跑一次不会变化。 */
export function sanitizeText(raw: string, cfg: Required<TextSanitizeConfig> = DEFAULT_TEXT_SANITIZE): SanitizeResult {
    if (!cfg.enabled || raw.length === 0) return { text: raw, reasons: [] };
    const reasons: string[] = [];
    let text = raw;
    try {
        // 1) 收尾暗号：[[完]] 之后的内容一律不要（约定的停止信号）。
        const doneAt = text.indexOf(TEXT_DONE_MARK);
        if (doneAt >= 0 && doneAt + TEXT_DONE_MARK.length < text.length) {
            text = text.slice(0, doneAt + TEXT_DONE_MARK.length);
            reasons.push("done-mark");
        }
        // 2) 注入形状：把宿主包装用户输入的标签剥掉，保留标签里的正文。
        if (cfg.stripInjection) {
            const before = text;
            text = text.replace(CLOSED_USER_MSG_RE, "").replace(OPEN_USER_MSG_RE, "")
                .replace(CLOSE_USER_MSG_RE, "").replace(PRIVATE_SOURCE_RE, "");
            if (text !== before) reasons.push("injection-shape");
        }
        // 3) 短周期循环：整段折叠，不留残句（残句照样会被当成记忆）。
        if (hasShortCycle(text, cfg.cycleMinRepeats)) {
            text = FOLDED_MARK;
            reasons.push("short-cycle");
        }
        // 4) 长度上限。
        if (text.length > cfg.maxChars) {
            text = text.slice(0, cfg.headChars) + TRUNCATED_MARK;
            reasons.push("too-long");
        }
    } catch {
        return { text: raw, reasons: [] };
    }
    return { text, reasons };
}

type TextLog = ((level: string, msg: string) => void) | undefined;

function report(changed: number, where: string, log: TextLog, sessionId: string | undefined): void {
    if (changed === 0 || !log) return;
    log("info", `[${sessionId ?? "-"}] text-guard(${where}): ${changed} assistant text block(s) rewritten`);
}

/** Anthropic 签名 thinking / redacted_thinking 的邻居 block 不能改，改了上游会拒。 */
function coreHasSignedThinking(m: Record<string, unknown>): boolean {
    if (typeof m.thinkingSignature === "string" && (m.thinkingSignature as string).length > 0) return true;
    const raw = m.rawAnthropicBlock as { type?: unknown } | undefined;
    return raw !== undefined && (raw.type === "thinking" || raw.type === "redacted_thinking");
}

function wireHasSignedThinking(parts: unknown[]): boolean {
    for (const p of parts) {
        if (!p || typeof p !== "object") continue;
        const o = p as Record<string, unknown>;
        if (o.type === "redacted_thinking") return true;
        if (o.type === "thinking" && typeof o.signature === "string" && (o.signature as string).length > 0) return true;
    }
    return false;
}

/** Anthropic `{type:"text",text}` / OpenAI `{type:"output_text",text}` / Google `{text}` 都算文本块。 */
function isTextBlock(p: unknown): p is Record<string, unknown> {
    if (!p || typeof p !== "object") return false;
    const o = p as Record<string, unknown>;
    if (typeof o.text !== "string") return false;
    const t = o.type;
    return t === undefined || t === "text" || t === "output_text";
}

function isAssistantRole(role: unknown): boolean {
    return role === "assistant" || role === "model";
}

/** wire 消息的内容数组：Anthropic/OpenAI/Responses 用 content，Google 用 parts。 */
function partsOf(rec: Record<string, unknown>): unknown {
    return rec.content ?? rec.parts;
}

/** 净化 CoreMessage 数组（processTurn 后的视图 / relay 二次渲染视图）。 */
export function sanitizeCoreMessages<T extends { role?: string; contentType?: string; text?: string }>(
    msgs: T[],
    cfg: Required<TextSanitizeConfig> = DEFAULT_TEXT_SANITIZE,
    log?: (level: string, msg: string) => void,
    sessionId?: string,
): T[] {
    if (!cfg.enabled || msgs.length === 0) return msgs;
    let changed = 0;
    let out: T[] | undefined;
    for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i]!;
        if (m.role !== "assistant" || m.contentType !== "text" || typeof m.text !== "string" || m.text.length === 0) continue;
        const r = sanitizeText(m.text, cfg);
        if (r.text === m.text) continue;
        if (!out) out = msgs.slice();
        out[i] = { ...m, text: r.text };
        changed++;
    }
    report(changed, "core-sanitize", log, sessionId);
    return out ?? msgs;
}

/**
 * 治本：出站视图里摘除 assistant 的 text 块。
 * CoreMessage 是一条消息一个 contentType，tool-call / tool-result 是独立消息，
 * 所以整条过滤不会误删工具调用。带签名 thinking 的消息保守保留。
 */
export function dropAssistantTextFromCores<T extends { role?: string; contentType?: string }>(
    msgs: T[],
    cfg: Required<TextSanitizeConfig> = DEFAULT_TEXT_SANITIZE,
    log?: (level: string, msg: string) => void,
    sessionId?: string,
): T[] {
    if (!cfg.dropAssistantText || msgs.length === 0) return msgs;
    const out = msgs.filter((m) => {
        if (m.role !== "assistant" || m.contentType !== "text") return true;
        return coreHasSignedThinking(m as unknown as Record<string, unknown>);
    });
    const dropped = msgs.length - out.length;
    if (dropped > 0) {
        report(dropped, "core-drop", log, sessionId);
        return out;
    }
    return msgs;
}

/**
 * 净化最终 wire 请求体里的 messages（Anthropic / OpenAI / Responses / Google 通用）。
 * 原地改 text 块；只碰 assistant（Google 为 `model`），tool_use / tool_calls /
 * thinking / 图片 / functionCall 一律不动。这是降级路径（kernel transform 失败、
 * 直接转发客户端原始 body）的最后一道闸。
 */
export function sanitizeWireMessages(
    messages: unknown,
    cfg: Required<TextSanitizeConfig> = DEFAULT_TEXT_SANITIZE,
    log?: (level: string, msg: string) => void,
    sessionId?: string,
): number {
    if (!cfg.enabled || !Array.isArray(messages)) return 0;
    let changed = 0;
    try {
        for (const m of messages) {
            if (!m || typeof m !== "object") continue;
            const rec = m as Record<string, unknown>;
            if (!isAssistantRole(rec.role)) continue;
            const content = partsOf(rec);
            if (typeof content === "string") {
                const r = sanitizeText(content, cfg);
                if (r.text !== content) { rec.content = r.text; changed++; }
            } else if (Array.isArray(content)) {
                for (const part of content) {
                    if (!isTextBlock(part)) continue;
                    const p = part as Record<string, unknown>;
                    if (typeof p.text !== "string" || p.text.length === 0) continue;
                    const r = sanitizeText(p.text, cfg);
                    if (r.text === p.text) continue;
                    p.text = r.text;
                    changed++;
                }
            }
        }
    } catch {
        return 0;
    }
    report(changed, "wire-sanitize", log, sessionId);
    return changed;
}

/**
 * 治本（wire 兜底）：摘除 assistant 消息里的 text 块。
 * 只摘 text 块、保留 tool_use / functionCall；content 变空才删整条消息，
 * 否则 Anthropic 会收到空 assistant message。带签名 thinking 的消息整条跳过。
 */
export function dropAssistantTextFromWire(
    messages: unknown,
    cfg: Required<TextSanitizeConfig> = DEFAULT_TEXT_SANITIZE,
    log?: (level: string, msg: string) => void,
    sessionId?: string,
): number {
    if (!cfg.dropAssistantText || !Array.isArray(messages)) return 0;
    let changed = 0;
    try {
        for (let i = 0; i < messages.length; i++) {
            const m = messages[i];
            if (!m || typeof m !== "object") continue;
            const rec = m as Record<string, unknown>;
            if (!isAssistantRole(rec.role)) continue;
            const content = partsOf(rec);
            if (typeof content === "string") {
                // 纯文本 assistant 消息：若还挂着 tool_calls，只清空 content；否则删整条。
                if (rec.tool_calls !== undefined || rec.function_call !== undefined) {
                    rec.content = "";
                } else {
                    messages.splice(i, 1);
                    i--;
                }
                changed++;
                continue;
            }
            if (!Array.isArray(content)) continue;
            if (wireHasSignedThinking(content)) continue;
            const kept = content.filter((p) => !isTextBlock(p));
            if (kept.length === content.length) continue;
            if (kept.length === 0) {
                messages.splice(i, 1);
                i--;
            } else if (rec.parts !== undefined && rec.content === undefined) {
                rec.parts = kept;
            } else {
                rec.content = kept;
            }
            changed++;
        }
    } catch {
        return 0;
    }
    report(changed, "wire-drop", log, sessionId);
    return changed;
}

/** 组合入口：core 视图（主出站 processedMessages / relay 二次渲染）。 */
export function guardCoreMessages<T extends { role?: string; contentType?: string; text?: string }>(
    msgs: T[],
    cfg: Required<TextSanitizeConfig> = DEFAULT_TEXT_SANITIZE,
    log?: (level: string, msg: string) => void,
    sessionId?: string,
): T[] {
    return sanitizeCoreMessages(dropAssistantTextFromCores(msgs, cfg, log, sessionId), cfg, log, sessionId);
}

/** 组合入口：最终 wire 请求体（降级路径兜底）。顺序固定：先摘除，再净化。 */
export function guardWireMessages(
    messages: unknown,
    cfg: Required<TextSanitizeConfig> = DEFAULT_TEXT_SANITIZE,
    log?: (level: string, msg: string) => void,
    sessionId?: string,
): void {
    dropAssistantTextFromWire(messages, cfg, log, sessionId);
    sanitizeWireMessages(messages, cfg, log, sessionId);
}
