/**
 * 补丁二单测：块候选 seq 判据 + ref 对账（文档第三节验收 4/5/6/7）。
 * 纯逻辑，DB 用 Map stub 注入。
 *
 *   <DSH Node24> --import tsx --test verify-block-evict.mts
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  collectBlockCandidates,
  collectBlockCandidatesDetailed,
  refNumber,
  type BlockSpanRow,
} from "./src/evict.js";
import type { CompressionBlock, CompressionState } from "acp-kernel";

const mkBlock = (
  over: Partial<CompressionBlock> & Pick<CompressionBlock, "blockId" | "summary" | "effectiveMessageIds" | "active">,
): CompressionBlock =>
  ({
    runId: "r1", tier: "distilled" as CompressionBlock["tier"],
    directMessageIds: [], directBlockIds: [], compressedTokens: 1000,
    createdAt: 100, survivedCount: 0, generation: "distilled" as CompressionBlock["generation"],
    ...over,
  }) as CompressionBlock;

const mkState = (blocks: CompressionBlock[]): CompressionState =>
  ({ blocks, messageRefs: { byRaw: {} } }) as unknown as CompressionState;

const span = (over: Partial<BlockSpanRow> & { blockId: string }): BlockSpanRow => ({
  startSeq: 100, endSeq: 200, startRefNum: null, endRefNum: null, active: true, ord: 1, ...over,
});

const BOUNDARY_SEQ = 1000;
const minChars = 200;
const longSummary = "S".repeat(500);
const logs: string[] = [];
const log = (m: string) => { logs.push(m); };

const block = (id: string, over: Partial<CompressionBlock> = {}) =>
  mkBlock({ blockId: id, summary: longSummary, effectiveMessageIds: ["h_a"], active: true, ...over });

function collect(
  blocks: CompressionBlock[],
  spans: Map<string, BlockSpanRow> | null,
  opts: { seqByRef?: Map<number, number>; mode?: "strict" | "warn" | "off"; boundary?: number | null } = {},
) {
  logs.length = 0;
  return collectBlockCandidatesDetailed(
    mkState(blocks),
    opts.boundary === undefined ? BOUNDARY_SEQ : opts.boundary,
    new Set<string>(),
    minChars,
    {
      spans,
      messageSeqByRef: opts.seqByRef ?? null,
      seqRefCheck: opts.mode ?? "strict",
      log,
    },
  );
}

test("refNumber：只认 mNNNNN", () => {
  assert.equal(refNumber("m12113"), 12113);
  assert.equal(refNumber("b1"), null);
  assert.equal(refNumber("BLOCKED"), null);
  assert.equal(refNumber(undefined), null);
});

test("验收 4：endSeq < boundarySeq、ref 对账通过 → 进候选", () => {
  const b = block("b1");
  const spans = new Map([["b1", span({ blockId: "b1", startSeq: 100, endSeq: 500, startRefNum: 100, endRefNum: 500 })]]);
  const seqByRef = new Map([[100, 100], [500, 500]]);
  const r = collect([b], spans, { seqByRef });
  assert.equal(r.units.length, 1);
  assert.equal(r.units[0]!.blockId, "b1");
  assert.equal(r.units[0]!.endSeq, 500);
  assert.equal(r.stats.refMismatch, 0);
});

test("验收 5：ref 对账不一致 → 不进候选，日志里有 blockId 和两边的数", () => {
  const b = block("b1");
  const spans = new Map([["b1", span({ blockId: "b1", startSeq: 100, endSeq: 500, startRefNum: null, endRefNum: 17162 })]]);
  const seqByRef = new Map([[17162, 19372]]); // 与块的 end_seq=500 对不上
  const r = collect([b], spans, { seqByRef });
  assert.equal(r.units.length, 0);
  assert.equal(r.stats.refMismatch, 1);
  assert.equal(r.stats.mismatches[0]!.actualSeq, 19372);
  assert.equal(r.stats.mismatches[0]!.blockSeq, 500);
  assert.match(logs.join(" "), /b1/);
  assert.match(logs.join(" "), /19372/);
});

test("验收 5b：seqRefCheck=warn → 对账不一致只警告，仍进候选", () => {
  const b = block("b1");
  const spans = new Map([["b1", span({ blockId: "b1", endSeq: 500, endRefNum: 17162 })]]);
  const r = collect([b], spans, { seqByRef: new Map([[17162, 19372]]), mode: "warn" });
  assert.equal(r.units.length, 1);
  assert.equal(r.stats.refMismatch, 1);
});

test("验收 5c：seqRefCheck=off → 根本不看 ref", () => {
  const b = block("b1");
  const spans = new Map([["b1", span({ blockId: "b1", endSeq: 500, endRefNum: 17162 })]]);
  const r = collect([b], spans, { seqByRef: new Map([[17162, 19372]]), mode: "off" });
  assert.equal(r.units.length, 1);
  assert.equal(r.stats.refMismatch, 0);
});

test("验收 6：ref 缺失 / 查不到 → 进候选（seq 说了算）", () => {
  const b = block("b1");
  const spans = new Map([["b1", span({ blockId: "b1", endSeq: 500, startRefNum: null, endRefNum: null })]]);
  const r = collect([b], spans, { seqByRef: new Map() });
  assert.equal(r.units.length, 1);
  // 2 处对账 ref 缺失 + 1 处无可用 range 边界（仍进候选，执行层安全跳过）。
  assert.ok(r.stats.refMissing >= 2, `refMissing 应 >=2，实际 ${r.stats.refMissing}`);
});

test("验收 6b：ref 查不到（seqByRef 无该 ref）不算失败", () => {
  const b = block("b1");
  const spans = new Map([["b1", span({ blockId: "b1", endSeq: 500, startRefNum: 100, endRefNum: 500 })]]);
  const r = collect([b], spans, { seqByRef: new Map() });
  assert.equal(r.units.length, 1);
  assert.equal(r.stats.refUnresolved, 2);
});

test("验收 7 前置：未封盘（endSeq >= boundarySeq）不进候选", () => {
  const b = block("b1");
  const spans = new Map([["b1", span({ blockId: "b1", endSeq: 1500 })]]);
  const r = collect([b], spans);
  assert.equal(r.units.length, 0);
  assert.equal(r.stats.afterBoundary, 1);
});

test("验收 7 前置：boundarySeq=null → 一块都不扔（保守兜底）", () => {
  const b = block("b1");
  const spans = new Map([["b1", span({ blockId: "b1" })]]);
  const r = collect([b], spans, { boundary: null });
  assert.equal(r.units.length, 0);
});

test("验收 7 前置：DB spans 不可用 → 一块都不扔", () => {
  const b = block("b1");
  const r = collect([b], null);
  assert.equal(r.units.length, 0);
  assert.match(logs.join(" "), /只读视图不可用/);
});

test("验收 7 前置：boundary 指到最前（seq=1）→ 一块都不扔", () => {
  const b = block("b1");
  const spans = new Map([["b1", span({ blockId: "b1", startSeq: 100, endSeq: 500 })]]);
  const r = collect([b], spans, { boundary: 1 });
  assert.equal(r.units.length, 0);
});

test("2.4：start_seq=0 的块允许 start_ref=null（不因 ref 缺失被挡）", () => {
  const b = block("b595");
  const spans = new Map([["b595", span({ blockId: "b595", startSeq: 0, endSeq: 500, startRefNum: null, endRefNum: null })]]);
  const r = collect([b], spans);
  assert.equal(r.units.length, 1);
});

test("幂等：扔过的块 active=false / 已是 [evicted: 标记 → 不进候选", () => {
  const thrown = block("b1", { active: false });
  const marked = block("b2", { summary: "[evicted: 块 b1 · …]".padEnd(300, " ") });
  const spans = new Map([
    ["b1", span({ blockId: "b1", active: false })],
    ["b2", span({ blockId: "b2", endRefNum: 200 })],
  ]);
  const r = collect([thrown, marked], spans);
  assert.equal(r.units.length, 0);
  assert.equal(r.stats.alreadyEvicted, 1);
});

test("只选 active / 够大 / 保护区：三条过滤仍在", () => {
  const small = block("b1", { summary: "短" });
  const hit = block("b2", { effectiveMessageIds: ["m990"] });
  const spans = new Map([
    ["b1", span({ blockId: "b1" })],
    ["b2", span({ blockId: "b2" })],
  ]);
  logs.length = 0;
  const r = collectBlockCandidatesDetailed(
    mkState([small, hit]), BOUNDARY_SEQ, new Set(["m990"]), minChars,
    { spans, seqRefCheck: "strict", log },
  );
  assert.equal(r.units.length, 0);
  assert.equal(r.stats.tooSmall, 1);
  assert.equal(r.stats.protectedHit, 1);
});

test("兼容签名 collectBlockCandidates 返回列表", () => {
  const b = block("b1");
  const spans = new Map([["b1", span({ blockId: "b1", endSeq: 500 })]]);
  const units = collectBlockCandidates(mkState([b]), BOUNDARY_SEQ, new Set(), minChars, { spans });
  assert.equal(units.length, 1);
});

test("按 createdTurn 从旧到新排序", () => {
  // 候选必须带可交给 applyCompression 的 range 边界：这里给块自带 ref。
  const newer = block("b1", { createdAt: 9000, startRef: "m00100", endRef: "m00500" });
  const older = block("b2", { createdAt: 1000, startRef: "m00100", endRef: "m00400" });
  const spans = new Map([
    ["b1", span({ blockId: "b1", endSeq: 500, ord: 1 })],
    ["b2", span({ blockId: "b2", endSeq: 400, ord: 0 })],
  ]);
  const r = collect([newer, older], spans);
  assert.deepEqual(r.units.map((u) => u.blockId), ["b2", "b1"]);
});
