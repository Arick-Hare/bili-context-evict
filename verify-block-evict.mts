/**
 * 离线自检：驱逐重做 + 补丁一（BlockUnit 候选）。覆盖 collectBlockCandidates
 * 的全部过滤规则；kernel 的 applyCompression / prune 真实渲染见
 * verify-block-evict-kernel.mts（用真实 minSummaryLength 验证标记长度）。
 * 不读真实配置、不碰运行副本。
 *
 *   <DSH Node24> --import tsx --test verify-block-evict.mts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { collectBlockCandidates, refNumber } from "./src/evict.js";
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

// boundary ref 数值 = 1000（对应 sleep.json 的 mNNNNN）
const BOUNDARY = 1000;
const minChars = 200;
const longSummary = "S".repeat(500);
const protectedIds = new Set<string>(["m990", "m991"]); // 「最近 N 条 / 末尾」保护区

const collect = (blocks: CompressionBlock[], boundary = BOUNDARY, prot = protectedIds, byRaw: Record<string, string> = {}) =>
  collectBlockCandidates(mkState(blocks, byRaw), boundary, prot, minChars);

/** 造一个自带 ref 范围的块。 */
const block = (id: string, startRef: string, endRef: string, over: Partial<CompressionBlock> = {}) =>
  mkBlock({
    blockId: id, summary: longSummary, effectiveMessageIds: ["h_a", "h_b"], active: true,
    startRef, endRef, createdAt: 100, ...over,
  });

test("refNumber：只认 mNNNNN，block ref / 杂串返回 null", () => {
  assert.equal(refNumber("m12113"), 12113);
  assert.equal(refNumber("m00001"), 1);
  assert.equal(refNumber("b1"), null);
  assert.equal(refNumber("BLOCKED"), null);
  assert.equal(refNumber(undefined), null);
});

test("补丁一核心：endRef 数值 < boundary 才进候选（不要求原文在视图里）", () => {
  // 注意 collect 不传 messages —— 块本来就是「原文已不在视图」的产物
  const before = block("b1", "m00100", "m00999"); // 已封盘
  const after = block("b2", "m01000", "m01500"); // 未封盘
  const equal = block("b3", "m00900", "m01000"); // 正好等于 boundary，不算之前
  assert.deepEqual(collect([before, after, equal]).map((u) => u.blockId), ["b1"]);
});

test("补丁一核心：endRef 解析不出（b1..b543 这类 block ref）保守跳过", () => {
  const mixed = block("b1", "b0", "b543"); // startRef/endRef 都是 block ref
  const bad = block("b2", "m00100", "b543"); // endRef 是 block ref
  assert.deepEqual(collect([mixed, bad]), []);
});

test("反向验收：boundary 解析不出（null）时一块都不扔", () => {
  const b = block("b1", "m00100", "m00999");
  assert.deepEqual(collect([b], null as unknown as number), []);
});

test("反向验收：boundary 指到最前（m00001）时一块都不扔", () => {
  const b = block("b1", "m00100", "m00999");
  assert.deepEqual(collect([b], 1), []);
});

test("只选 active、且 effectiveMessageIds 非空的块", () => {
  const a = block("b1", "m00100", "m00999");
  const off = block("b2", "m00100", "m00999", { active: false });
  const empty = block("b3", "m00100", "m00999", { effectiveMessageIds: [] });
  assert.deepEqual(collect([a, off, empty]).map((u) => u.blockId), ["b1"]);
});

test("够大：summaryChars < minChars 不进候选", () => {
  const small = block("b1", "m00100", "m00999", { summary: "短" });
  const big = block("b2", "m00100", "m00999");
  assert.deepEqual(collect([small, big]).map((u) => u.blockId), ["b2"]);
});

test("不会重复扔：evicted 标记块不进候选", () => {
  const marked = block("b1", "m00100", "m00999", {
    summary: "[evicted: 块 b0 · 折叠于 12:00 · 原文 3 条]".padEnd(300, " "),
  });
  assert.deepEqual(collect([marked]), []);
});

test("保护区：命中「最近 N 条 / 末尾」就整块跳过", () => {
  const hit = mkBlock({
    blockId: "b1", summary: longSummary, effectiveMessageIds: ["h_a", "m990"], active: true,
    startRef: "m00100", endRef: "m00999", createdAt: 100,
  });
  assert.deepEqual(collect([hit]), []);
});

test("会话根不在 blockProtectedIds 里就不误挡（补丁一实测 b540 场景）", () => {
  // 调用方传的 blockProtectedIds 已剔除第一条 user；这里模拟「大块覆盖会话根」
  const rootId = "h_root";
  const big = mkBlock({
    blockId: "b540", summary: longSummary,
    effectiveMessageIds: [rootId, "h_2", "h_3"], active: true,
    startRef: "b1", endRef: "m00999", createdAt: 100,
  });
  // protectedIds 里不含 rootId → 不被挡
  assert.deepEqual(collect([big]).map((u) => u.blockId), ["b540"]);
});

test("ref 为 BLOCKED / 缺失则跳过；老会话可用 byRaw 反查", () => {
  const noRef = block("b1", "BLOCKED", "m00999");
  assert.deepEqual(collect([noRef]), []);
  const legacy = mkBlock({
    blockId: "b2", summary: longSummary, effectiveMessageIds: ["h_a", "h_b"], active: true,
    createdAt: 100, // 无 startRef/endRef
  });
  const got = collect([legacy], BOUNDARY, protectedIds, { h_a: "m00100", h_b: "m00999" });
  assert.equal(got.length, 1);
  assert.equal(got[0]!.startRef, "m00100");
  assert.equal(got[0]!.endRef, "m00999");
});

test("按 createdTurn 从旧到新排序（越老越先扔）", () => {
  const newer = block("b1", "m00100", "m00999", { createdAt: 9000 });
  const older = block("b2", "m00200", "m00800", { createdAt: 1000 });
  const mid = block("b3", "m00300", "m00700", { createdAt: 5000 });
  assert.deepEqual(collect([newer, older, mid]).map((u) => u.blockId), ["b2", "b3", "b1"]);
});

test("kind/summaryChars/tier 字段填充正确", () => {
  const b = mkBlock({
    blockId: "b1", summary: longSummary, effectiveMessageIds: ["h_a", "h_b"], active: true,
    createdAt: 777, startRef: "m00100", endRef: "m00999",
  });
  const u = collect([b])[0]!;
  assert.equal(u.kind, "block");
  assert.equal(u.summaryChars, longSummary.length);
  assert.equal(u.createdTurn, 777);
  assert.deepEqual(u.effectiveMessageIds, ["h_a", "h_b"]);
  assert.equal(u.startRef, "m00100");
  assert.equal(u.endRef, "m00999");
});
