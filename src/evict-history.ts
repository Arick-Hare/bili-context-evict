/**
 * 驱逐记录（2026-11-06 上午反馈）：
 *   每次驱逐（自动或手动）追加一条 JSONL，失败也写，reason 带真实原因。
 *   GET /__bili/evict-history?limit=20 从尾部读回最近 N 条给设置页展示。
 *
 * 落点：~/.config/billion-context/evict-history.jsonl（和 billion-context.json
 * 同目录，UTF-8 无 BOM，见 paths.ts 的 configDir()）。
 *
 * 编码（2026-11-06 修复 reason 中文乱码后改）：JSONL 落盘是**纯 ASCII**，
 * 所有非 ASCII 字符写成 \uXXXX 转义。原因不是写坏了——原本就是合法 UTF-8，
 * JSON.parse 也能还原中文——而是 Windows 上 PowerShell 5.1 / 记事本 / 某些
 * 查看器按 GBK 解无 BOM 文件，中文就显示成乱码（billion-context.json 早踩过）。
 * 不能靠加 BOM 解决：BOM 会粘在第一行 JSON 开头，破坏逐行 parse。纯 ASCII
 * 是 UTF-8 的子集，任何编码打开都不乱，JSON.parse 又会把中文还原回来。
 * 存量 UTF-8 中文行不用迁移也能读（见 readEvictionHistory）；要统一显示，
 * 在停机窗口跑 tools/normalize-evict-history.mjs。
 *
 * 两条护栏（自动路径每个请求都会跑，不设会把文件写爆）：
 *  - 只有 trigger=auto 且没删成东西的记录按 (sessionId, reason) 去重，
 *    同原因 60s 内只写一条。手动路径必须条条留痕（验收要求连续两次失败
 *    能看到两条带原因的记录），不参与去重；
 *  - 文件超过 512KB 时懒清理，只留最近 500 行；无常驻定时器。
 *
 * 所有 IO 都吞掉异常返回 false / []：记录写失败绝不能影响驱逐或代理本身。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configDir } from "./paths.js";

export const HISTORY_FILE_NAME = "evict-history.jsonl";

export interface EvictHistoryEntry {
    at: string;
    trigger: "auto" | "manual";
    sessionId: string;
    evictedCount: number;
    /** 拆分口径：落地回合范围数 / 摘要块数。旧记录没有这两个字段。 */
    evictedTurns?: number;
    evictedBlocks?: number;
    reclaimedTokens: number;
    beforeRatio: number | null;
    afterRatio: number | null;
    dryRun: boolean;
    reason: string;
    /** 手动端点用的是「最近一次请求的快照」还是 session.stats，便于对账。 */
    tokensSource?: "snapshot" | "stats" | "unknown";
    snapshotAgeMs?: number | null;
}

export type EvictHistoryInput = Omit<EvictHistoryEntry, "at"> & { at?: string };

const MAX_BYTES = 512 * 1024;
const KEEP_LINES = 500;
const NOOP_MIN_INTERVAL_MS = 60_000;
const NOOP_MAX_KEYS = 200;

/** 测试可传绝对路径覆盖，生产走 configDir()。 */
export function historyFile(explicit?: string): string {
    const p = typeof explicit === "string" ? explicit.trim() : "";
    return p ? path.resolve(p) : path.join(configDir(), HISTORY_FILE_NAME);
}

const lastNoop = new Map<string, { reason: string; at: number }>();

function shouldWriteNoop(key: string, reason: string, now: number): boolean {
    if (lastNoop.size > NOOP_MAX_KEYS) lastNoop.clear();
    const prev = lastNoop.get(key);
    if (prev && prev.reason === reason && now - prev.at < NOOP_MIN_INTERVAL_MS) return false;
    lastNoop.set(key, { reason, at: now });
    return true;
}

/** 懒清理：只在文件超限时重写一次，不留定时器。原子替换避免半截文件。 */
function trimIfLarge(file: string): void {
    try {
        if (!existsSync(file) || statSync(file).size <= MAX_BYTES) return;
        const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
        const tail = lines.slice(-KEEP_LINES);
        const tmp = `${file}.tmp-${process.pid}`;
        writeFileSync(tmp, tail.length > 0 ? `${tail.join("\n")}\n` : "", "utf8");
        renameSync(tmp, file);
    } catch {
        // 清理失败不影响追加
    }
}

function finiteRatio(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function finiteInt(v: unknown): number {
    return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
}

/**
 * JSON.stringify 默认保留中文字面量；把 BMP 里的非 ASCII 逐个转成 \uXXXX。
 * 代理对（emoji）是两个码元、各转一次，JSON.parse 会正确还原成一个字符。
 * 结果每个字节都 < 0x80，GBK / ANSI / UTF-8 打开都不乱码。
 * 导出给存量迁移脚本复用，保证新旧行格式一致。
 */
export function asciiJson(value: unknown): string {
    return JSON.stringify(value).replace(/[\u0080-\uffff]/g, (ch) =>
        `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** 追加一条。返回是否真的落盘（被去重挡掉时返回 false）。 */
export function recordEviction(input: EvictHistoryInput, opts: { file?: string; now?: number } = {}): boolean {
    try {
        const file = historyFile(opts.file);
        const now = opts.now ?? Date.now();
        const entry: EvictHistoryEntry = {
            at: input.at ?? new Date(now).toISOString(),
            trigger: input.trigger === "auto" ? "auto" : "manual",
            sessionId: String(input.sessionId ?? ""),
            evictedCount: finiteInt(input.evictedCount),
            ...(Number.isFinite(input.evictedTurns) ? { evictedTurns: finiteInt(input.evictedTurns) } : {}),
            ...(Number.isFinite(input.evictedBlocks) ? { evictedBlocks: finiteInt(input.evictedBlocks) } : {}),
            reclaimedTokens: finiteInt(input.reclaimedTokens),
            beforeRatio: finiteRatio(input.beforeRatio),
            afterRatio: finiteRatio(input.afterRatio),
            dryRun: input.dryRun === true,
            reason: String(input.reason ?? ""),
            tokensSource: input.tokensSource ?? "unknown",
            snapshotAgeMs: typeof input.snapshotAgeMs === "number" && Number.isFinite(input.snapshotAgeMs)
                ? Math.max(0, Math.floor(input.snapshotAgeMs))
                : null,
        };
        const succeeded = entry.evictedCount > 0 || entry.reclaimedTokens > 0;
        // 手动路径逐条落盘；自动路径每个请求都会跑，才需要按原因节流。
        if (!succeeded && entry.trigger === "auto"
            && !shouldWriteNoop(`auto:${entry.sessionId}`, entry.reason, now)) return false;
        mkdirSync(path.dirname(file), { recursive: true });
        trimIfLarge(file);
        // 无 BOM、纯 ASCII；JSON 会转义换行，一行一条。
        appendFileSync(file, `${asciiJson(entry)}\n`, "utf8");
        return true;
    } catch {
        return false;
    }
}

/** 从尾部读最近 limit 条，最新在前；坏行跳过，文件不存在返回 []。 */
export function readEvictionHistory(limit = 20, opts: { file?: string } = {}): EvictHistoryEntry[] {
    try {
        const file = historyFile(opts.file);
        if (!existsSync(file)) return [];
        const n = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 20;
        const raw = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
        // 从尾部倒着解析，坏行跳过但不占 limit 名额（否则末尾一条半截行
        // 会让设置页少显示一条记录）。
        const lines = raw.split("\n").filter((l) => l.trim().length > 0).reverse();
        const out: EvictHistoryEntry[] = [];
        for (const line of lines) {
            if (out.length >= n) break;
            try {
                const v: unknown = JSON.parse(line);
                if (v && typeof v === "object" && !Array.isArray(v)) out.push(v as EvictHistoryEntry);
            } catch {
                // 半截行 / 手工编辑过的行：跳过，不让一条坏记录挡住整页
            }
        }
        return out;
    } catch {
        return [];
    }
}
