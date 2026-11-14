/**
 * 开源发布前修复验收（2026-11-14）。
 *
 *   node --import tsx --test verify-open-release-fixes.mts
 *
 * 覆盖三处发布前修复：
 *   1. 块驱逐阈值：minBlockSummaryChars 默认 1，短摘要块应进候选
 *      （回归：旧代码把 minToolResultChars=200 误用作块门槛，挡掉所有短块）。
 *   2. resolveEvictConfig / parseEvictSettings 正确解析 minBlockSummaryChars。
 *   3. 水位提醒默认文案中性（转告使用者、不要自行行动，不再写「记忆整合流程」）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  collectBlockCandidatesDetailed,
  parseEvictSettings,
  resolveEvictConfig,
} from "./src/evict.js";
import { DEFAULT_WATERMARK_REMINDER } from "./src/watermark-reminder.js";

// ---------- 1 & 2. 块驱逐阈值 ----------
const makeState = (): any => ({
  blocks: [
    { active: true, blockId: "b1", summary: "短".repeat(100), effectiveMessageIds: ["a1"], tier: 1, createdAt: 1, startRef: "m1", endRef: "m2" },
    { active: true, blockId: "b2", summary: "长".repeat(300), effectiveMessageIds: ["a2"], tier: 1, createdAt: 2, startRef: "m3", endRef: "m4" },
  ],
  messageRefs: { byRaw: {} },
});
const makeSpans = (): Map<string, any> =>
  new Map([
    ["b1", { startSeq: 1, endSeq: 10, active: true, startRefNum: 1, endRefNum: 10 }],
    ["b2", { startSeq: 11, endSeq: 20, active: true, startRefNum: 11, endRefNum: 20 }],
  ]);

test("块驱逐：minBlockSummaryChars=1 时短摘要块也进候选（修复回归）", () => {
  const units = collectBlockCandidatesDetailed(makeState(), 1_000_000, new Set(), 1, {
    spans: makeSpans(),
    seqRefCheck: "off",
  }).units;
  assert.equal(units.length, 2, "短块(100字)与长块(300字)都应进候选");
});

test("块驱逐：旧误用 minToolResultChars=200 会挡掉短块（bug 复现，作为对照）", () => {
  const units = collectBlockCandidatesDetailed(makeState(), 1_000_000, new Set(), 200, {
    spans: makeSpans(),
    seqRefCheck: "off",
  }).units;
  assert.equal(units.length, 1, "短块(100字<200)被挡，只剩长块");
  assert.equal(units[0]?.blockId, "b2", "剩下的是长块");
});

test("resolveEvictConfig：默认 minBlockSummaryChars = 1", () => {
  const cfg = resolveEvictConfig(undefined, {});
  assert.equal(cfg.minBlockSummaryChars, 1, "默认应为 1");
});

test("resolveEvictConfig：文件配置覆盖默认值", () => {
  const cfg = resolveEvictConfig({ minBlockSummaryChars: 5 } as any, {});
  assert.equal(cfg.minBlockSummaryChars, 5, "文件配置应覆盖默认");
});

test("parseEvictSettings：解析 minBlockSummaryChars", () => {
  const parsed = parseEvictSettings({ minBlockSummaryChars: 7 });
  assert.equal(parsed?.minBlockSummaryChars, 7, "应解析为 7");
  assert.equal(
    parseEvictSettings({ minBlockSummaryChars: -3 }),
    undefined,
    "负值非法应被忽略，返回 undefined",
  );
});

// ---------- 3. 水位提醒默认文案中性 ----------
test("水位提醒默认文案中性：含「转告使用者」且不含旧「记忆整合流程」", () => {
  const t = DEFAULT_WATERMARK_REMINDER.text;
  assert.ok(t.includes("转告给使用者"), "应含「转告给使用者」");
  assert.ok(t.includes("不要自行"), "应明确「不要自行」改写记忆/封盘");
  assert.ok(!t.includes("记忆整合流程"), "不应再含旧「记忆整合流程」");
});
