/**
 * 离线自检：驱逐重做（让已折的 active block 当整体被驱逐）。
 * 覆盖 collectBlockCandidates 的全部过滤规则；kernel 的 applyCompression /
 * prune 真实渲染留运行态验证（需要活会话 state）。不读真实配置、不碰运行副本。
 *
 *   node --import tsx --test verify-block-evict.mts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { collectBlockCandidates } from "./src/evict.js";
import type { CompressionBlock, CompressionState, CoreMessage } from "acp-kernel";

const mkMsg = (id: string, role: "user" | "assistant" = "assistant"): CoreMessage =>
  ({ id, role, content: "x", text: "x" } as unknown as CoreMessage);

const mkBlock = (
  over: Partial<CompressionBlock> & Pick<CompressionBlock, "blockId" | "summary" | "effectiveMessageIds" | "active">,
): CompressionBlock =>
  ({
    runId: "r1",
    tier: "distilled" as CompressionBlock["tier"],
    directMessageIds: [],
    directBlockIds: [],
    compressedTokens: 1000,
    createdAt: 0,
    survivedCount: 0,
    generation: "distilled" as CompressionBlock["generation"],
    ...over,
  }) as CompressionBlock;

const mkState = (blocks: CompressionBlock[], byRaw: Record<string, string> = {}): CompressionState =>
  ({ blocks, messageRefs: { byRaw } }) as unknown as CompressionState;

// 10 条视图：m0..m9。boundaryIndex=8 → m8/m9 未封盘。
const msgs = Array.from({ length: 10 }, (_, i) => mkMsg("m" + i));
// 每条 raw 都能查到有效 ref（mN → rN）。
const byRaw: Record<string, string> = Object.fromEntries(msgs.map((m, i) => [m.id, "r" + i]));
const protectedIds = new Set<string>(["m0", "m9"]); // 第一条 user + 末尾保护
const boundary = 8;
const minChars = 200;
const longSummary = "S".repeat(500);

const collect = (blocks: CompressionBlock[], raw = byRaw) =>
  collectBlockCandidates(msgs, mkState(blocks, raw), boundary, protectedIds, minChars);

test("只选 active、且 effectiveMessageIds 非空的块", () => {
  const a = mkBlock({ blockId: "b1", summary: longSummary, effectiveMessageIds: ["m1"], active: true, createdAt: 10 });
  const off = mkBlock({ blockId: "b2", summary: longSummary, effectiveMessageIds: ["m2"], active: false, createdAt: 20 });
  const empty = mkBlock({ blockId: "b3", summary: longSummary, effectiveMessageIds: [], active: true, createdAt: 30 });
  assert.deepEqual(collect([a, off, empty]).map((u) => u.blockId), ["b1"]);
});

test("够大：summaryChars < minChars 不进候选", () => {
  const small = mkBlock({ blockId: "b1", summary: "短", effectiveMessageIds: ["m1"], active: true });
  const big = mkBlock({ blockId: "b2", summary: longSummary, effectiveMessageIds: ["m2"], active: true });
  assert.deepEqual(collect([small, big]).map((u) => u.blockId), ["b2"]);
});

test("不会重复扔：evicted 标记块不进候选", () => {
  const marked = mkBlock({
    blockId: "b1", summary: "[evicted: 块 b0 · 折叠于 12:00 · 原文 3 条]".padEnd(300, " "),
    effectiveMessageIds: ["m1"], active: true,
  });
  assert.deepEqual(collect([marked]), []);
});

test("不撞保护区：任一原文 id 命中 protectedIds 就整块跳过", () => {
  const hit = mkBlock({ blockId: "b1", summary: longSummary, effectiveMessageIds: ["m1", "m0"], active: true });
  assert.deepEqual(collect([hit]), []);
});

test("不在主视图：原文 id 全都不在 messages 里则跳过", () => {
  const stale = mkBlock({ blockId: "b1", summary: longSummary, effectiveMessageIds: ["mzz"], active: true });
  assert.deepEqual(collect([stale]), []);
});

test("在封盘线之前：覆盖的最大索引 >= boundaryIndex 则跳过", () => {
  const unsealed = mkBlock({ blockId: "b1", summary: longSummary, effectiveMessageIds: ["m7", "m8"], active: true });
  assert.deepEqual(collect([unsealed]), []);
});

test("ref 无效 / BLOCKED 则跳过", () => {
  const b = mkBlock({ blockId: "b1", summary: longSummary, effectiveMessageIds: ["m3"], active: true });
  assert.deepEqual(collect([b], { m3: "BLOCKED" }), []);
  assert.deepEqual(collect([b], {}), []);
});

test("优先用块自带的 startRef/endRef（老会话 byRaw 查不到也能进）", () => {
  const b = mkBlock({
    blockId: "b1", summary: longSummary, effectiveMessageIds: ["m3"], active: true,
    startRef: "r3", endRef: "r4",
  });
  const got = collect([b], {});
  assert.equal(got.length, 1);
  assert.equal(got[0]!.startRef, "r3");
  assert.equal(got[0]!.endRef, "r4");
});

test("按 createdTurn 从旧到新排序（越老越先扔）", () => {
  const newer = mkBlock({ blockId: "b1", summary: longSummary, effectiveMessageIds: ["m1"], active: true, createdAt: 9000 });
  const older = mkBlock({ blockId: "b2", summary: longSummary, effectiveMessageIds: ["m2"], active: true, createdAt: 1000 });
  const mid = mkBlock({ blockId: "b3", summary: longSummary, effectiveMessageIds: ["m3"], active: true, createdAt: 5000 });
  assert.deepEqual(collect([newer, older, mid]).map((u) => u.blockId), ["b2", "b3", "b1"]);
});

test("kind/summaryChars/tier 字段填充正确", () => {
  const b = mkBlock({ blockId: "b1", summary: longSummary, effectiveMessageIds: ["m1", "m2"], active: true, createdAt: 777 });
  const u = collect([b])[0]!;
  assert.equal(u.kind, "block");
  assert.equal(u.summaryChars, longSummary.length);
  assert.equal(u.createdTurn, 777);
  assert.deepEqual(u.effectiveMessageIds, ["m1", "m2"]);
  assert.equal(u.startRef, "r1");
  assert.equal(u.endRef, "r2");
});
