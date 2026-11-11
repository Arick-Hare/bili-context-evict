/**
 * 驱逐收尾清单（2026-11-11）验收：
 *   #1 evictedCount 拆分 evictedTurns / evictedBlocks + 最近 5 次有效历史
 *   #2 strict 下 ref 与 seq 不同源的白名单
 *   #4 阈值收进 textGuard 配置段
 *
 *   <Node24> --import tsx --test verify-evict-cleanup.mts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectBlockCandidatesDetailed, parseEvictSettings, resolveEvictConfig, type BlockSpanRow } from "./src/evict.js";
import { recordEviction, readEvictionHistory } from "./src/evict-history.js";
import { resolveTextSanitize, DEFAULT_TEXT_SANITIZE } from "./src/text-sanitize.js";
import type { CompressionBlock, CompressionState } from "acp-kernel";

const longSummary = "S".repeat(500);
const mkBlock = (id: string): CompressionBlock => ({
    blockId: id, runId: "r1", tier: "distilled", summary: longSummary, topic: undefined,
    directMessageIds: [], effectiveMessageIds: ["h_a"], directBlockIds: [],
    compressedTokens: 1000, createdAt: 100, survivedCount: 0, generation: "distilled", active: true,
} as unknown as CompressionBlock);
const mkState = (blocks: CompressionBlock[]): CompressionState =>
    ({ blocks, messageRefs: { byRaw: {} } }) as unknown as CompressionState;
const span = (over: Partial<BlockSpanRow> & { blockId: string }): BlockSpanRow => ({
    startSeq: 100, endSeq: 200, startRefNum: null, endRefNum: null, active: true, ord: 1, ...over,
});

// ═══════════════════════════════════════════════════════════════════════
// A. #2 白名单（实测偏差不是单一 off-by-one）
// ═══════════════════════════════════════════════════════════════════════

function mismatchCase(deltaStart: number, deltaEnd: number, allow?: ReadonlySet<string>) {
    const startSeq = 8056, endSeq = 8148;
    const b = mkBlock("b234");
    const spans = new Map([["b234", span({
        blockId: "b234", startSeq, endSeq, startRefNum: 7726, endRefNum: 7811,
    })]]);
    const seqByRef = new Map([[7726, startSeq + deltaStart], [7811, endSeq + deltaEnd]]);
    const logs: string[] = [];
    const r = collectBlockCandidatesDetailed(
        mkState([b]), 100000, new Set<string>(), 200,
        { spans, messageSeqByRef: seqByRef, seqRefCheck: "strict", refMismatchAllow: allow, log: (m) => logs.push(m) },
    );
    return { r, text: logs.join("\n") };
}

test("A1 strict 默认跳过 ref 与 seq 不同源的块，日志写明偏差与放行途径", () => {
    const { r, text } = mismatchCase(1, 0);
    assert.equal(r.units.length, 0);
    assert.equal(r.stats.refMismatch, 1);
    assert.match(text, /偏差 1/);
    assert.match(text, /ref 与 seq 不同源/);
    assert.match(text, /refMismatchAllow/);
});

test("A2 白名单放行，且封盘仍按 seq 判定", () => {
    const { r, text } = mismatchCase(1, 0, new Set(["b234"]));
    assert.equal(r.units.length, 1);
    assert.equal(r.units[0]!.endSeq, 8148);
    assert.match(text, /白名单放行/);
    // boundarySeq 小于 endSeq 时，即便在白名单里也不能放行。
    const logs: string[] = [];
    const b = mkBlock("b234");
    const spans = new Map([["b234", span({ blockId: "b234", startSeq: 8056, endSeq: 8148, startRefNum: 7726, endRefNum: 7811 })]]);
    const close = collectBlockCandidatesDetailed(mkState([b]), 8100, new Set<string>(), 200, {
        spans, messageSeqByRef: new Map([[7726, 8057], [7811, 8148]]),
        seqRefCheck: "strict", refMismatchAllow: new Set(["b234"]), log: (m) => logs.push(m),
    });
    assert.equal(close.units.length, 0, "seq 仍是封盘裁判，白名单不绕过封盘线");
});

test("A3 偏差 +14 / +44 / -2 也覆盖（不是靠 ±1 容忍）", () => {
    for (const [ds, de] of [[1, 14], [0, 44], [0, -2], [1, -1]]) {
        const strict = mismatchCase(ds, de);
        assert.equal(strict.r.units.length, 0);
        const allowed = mismatchCase(ds, de, new Set(["b234"]));
        assert.equal(allowed.r.units.length, 1, `偏差 ${ds}/${de} 应能靠白名单放行`);
    }
});

test("A4 白名单只放行列出的块，不误伤别的块", () => {
    const b1 = mkBlock("b234"), b2 = mkBlock("b999");
    const spans = new Map([
        ["b234", span({ blockId: "b234", startSeq: 8056, endSeq: 8148, startRefNum: 7726, endRefNum: 7811 })],
        ["b999", span({ blockId: "b999", startSeq: 8200, endSeq: 8250, startRefNum: 7900, endRefNum: 7950 })],
    ]);
    const seqByRef = new Map([[7726, 8057], [7811, 8148], [7900, 8205], [7950, 8250]]);
    const r = collectBlockCandidatesDetailed(mkState([b1, b2]), 100000, new Set<string>(), 200, {
        spans, messageSeqByRef: seqByRef, seqRefCheck: "strict",
        refMismatchAllow: new Set(["b234"]), log: () => {},
    });
    assert.deepEqual(r.units.map((u) => u.blockId), ["b234"]);
});

test("A5 配置解析：refMismatchAllow 从文件读、env 逗号分隔覆盖", () => {
    const parsed = parseEvictSettings({ seqRefCheck: "strict", refMismatchAllow: ["b234", 3, "", "b247"] });
    assert.deepEqual(parsed?.refMismatchAllow, ["b234", "b247"]);
    const fromFile = resolveEvictConfig({ seqRefCheck: "strict", refMismatchAllow: ["b234"] });
    assert.deepEqual(fromFile.refMismatchAllow, ["b234"]);
    const fromEnv = resolveEvictConfig({ seqRefCheck: "strict", refMismatchAllow: ["b234"] }, { EVICT_REF_MISMATCH_ALLOW: "b1, b2" });
    assert.deepEqual(fromEnv.refMismatchAllow, ["b1", "b2"]);
    assert.deepEqual(resolveEvictConfig({}).refMismatchAllow, [], "默认空白名单，通用部署保持严格");
});

// ═══════════════════════════════════════════════════════════════════════
// B. #4 阈值进 textGuard 配置段
// ═══════════════════════════════════════════════════════════════════════

test("B1 阈值优先级：env > 配置文件 > 默认值", () => {
    const fromFile = resolveTextSanitize({}, { maxChars: 800, headChars: 50, cycleMinRepeats: 30 });
    assert.equal(fromFile.maxChars, 800);
    assert.equal(fromFile.headChars, 50);
    assert.equal(fromFile.cycleMinRepeats, 30);
    const envWins = resolveTextSanitize({ BILI_TEXT_SANITIZE_MAX_CHARS: "1234" }, { maxChars: 800 });
    assert.equal(envWins.maxChars, 1234);
    const defaults = resolveTextSanitize({}, {});
    assert.equal(defaults.maxChars, DEFAULT_TEXT_SANITIZE.maxChars);
    assert.equal(defaults.cycleMinRepeats, 10, "19:09 定稿与收尾清单都写 10");
});

test("B2 非法阈值回退，不会让配置把功能弄坏", () => {
    const c = resolveTextSanitize({ BILI_TEXT_SANITIZE_MAX_CHARS: "abc" }, { maxChars: -5, cycleMinRepeats: 0 });
    assert.equal(c.maxChars, DEFAULT_TEXT_SANITIZE.maxChars);
    assert.equal(c.cycleMinRepeats, DEFAULT_TEXT_SANITIZE.cycleMinRepeats);
});

test("B3 三个布尔仍默认全关", () => {
    const c = resolveTextSanitize({}, { maxChars: 800 });
    assert.equal(c.enabled, false);
    assert.equal(c.dropAssistantText, false);
    assert.equal(c.cycleGuard, false);
});

// ═══════════════════════════════════════════════════════════════════════
// C. #1 / #3 历史拆分与「最近 5 次有效记录」过滤
// ═══════════════════════════════════════════════════════════════════════

const TMP = mkdtempSync(path.join(tmpdir(), "bili-evict-history-"));
process.on("exit", () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响验收结论 */ } });

test("C1 recordEviction 落盘 evictedTurns / evictedBlocks，读回一致", () => {
    const f = path.join(TMP, "h1.jsonl");
    const ok = recordEviction({
        trigger: "manual", sessionId: "s1", evictedCount: 51,
        evictedTurns: 0, evictedBlocks: 51,
        reclaimedTokens: 8885, beforeRatio: 0.316, afterRatio: 0.29,
        dryRun: false, reason: "", tokensSource: "snapshot",
    }, { file: f, now: Date.parse("2026-11-10T23:56:39Z") });
    assert.equal(ok, true);
    const e = readEvictionHistory(1, { file: f })[0]!;
    assert.equal(e.evictedCount, 51);
    assert.equal(e.evictedTurns, 0);
    assert.equal(e.evictedBlocks, 51);
    assert.equal(e.evictedTurns! + e.evictedBlocks!, e.evictedCount);
});

test("C2 旧记录没有拆分字段也能读（向后兼容）", () => {
    const f = path.join(TMP, "h2.jsonl");
    recordEviction({
        trigger: "auto", sessionId: "s1", evictedCount: 0, reclaimedTokens: 0,
        beforeRatio: null, afterRatio: null, dryRun: false, reason: "noop",
    }, { file: f, now: Date.now() });
    const e = readEvictionHistory(1, { file: f })[0]!;
    assert.equal(e.evictedCount, 0);
    assert.equal(e.evictedTurns, undefined);
    assert.equal(e.evictedBlocks, undefined);
});

test("C3 过滤掉空记录后，51 块那条仍是最近一次有效驱逐", () => {
    const f = path.join(TMP, "h3.jsonl");
    const base = {
        trigger: "manual" as const, sessionId: "s1", reclaimedTokens: 0,
        beforeRatio: 0.3, afterRatio: 0.3, dryRun: false, reason: "", tokensSource: "stats" as const,
    };
    let t = Date.parse("2026-11-10T23:56:39Z");
    recordEviction({ ...base, evictedCount: 51, evictedTurns: 0, evictedBlocks: 51 }, { file: f, now: t });
    // 后续 8 轮自动空记录（只裁工具结果 / noop），会把「最新 1 条」顶成 0。
    for (let i = 1; i <= 8; i++) {
        t += 1000;
        recordEviction({ ...base, trigger: "auto", evictedCount: 0, reclaimedTokens: i > 4 ? 0 : 5 }, { file: f, now: t });
    }
    const pool = readEvictionHistory(100, { file: f });
    assert.equal(pool[0]!.evictedCount, 0, "最新一条确实是 0，复现事故");
    // 与 buildEvictStatus 一致：只列 evictedCount>0 的轮次。
    const recent = pool.filter((e) => e.evictedCount > 0).slice(0, 5);
    assert.equal(recent.length, 1);
    assert.equal(recent[0]!.evictedBlocks, 51, "51 块那条必须是 lastEviction");
    assert.equal(recent[0]!.evictedTurns, 0);
    // lastEviction 指向最近一次「真扔了东西」的记录，而不是被 0 淹没。
    const lastDrive = pool.find((e) => e.evictedCount > 0)!;
    assert.equal(lastDrive.evictedBlocks, 51);
});
