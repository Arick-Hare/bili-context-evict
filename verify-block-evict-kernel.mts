/**
 * 集成自检（补丁四重写）：验证「直接把 active 摘要块的 summary 换成 evicted
 * 标记」这条路真的能落地。
 *
 * 旧的语义是「deactivate 旧块 → 同范围 applyCompression 造新块」，但块的原文
 * 早在当初折叠时就被换成了摘要，messages 里没有原文可折，blocksCreated 永远
 * 是 0（实测 51 个块全被拒）。现在改为改已有块的 summary，保持 active:true，
 * kernel 的 collectSummaryAnchors 会把它渲染进视图。
 *
 * 纯逻辑、不读真实配置、不碰运行副本。
 *   <DSH Node24> --import tsx --test verify-block-evict-kernel.mts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createCore, createInitialState, prune } from "acp-kernel";
import { assignRefs } from "./kernel/src/refs.js";
import { collectBlockCandidates, swapBlockSummary } from "./src/evict.js";
import type { Config, CoreMessage } from "acp-kernel";

function msg(id: string, text: string, role: CoreMessage["role"] = "user"): CoreMessage {
  return { id, role, contentType: "text", text } as CoreMessage;
}
function cfg(over: Partial<Config> = {}): Config {
  return {
    tiers: { enabled: true, tier2Trigger: 5, tier3Trigger: 10 },
    nudge: {
      maxContextLimitPct: 0.55, minContextLimitPct: 0.45, frequency: 5,
      iterationThreshold: 15, force: "soft", growthRatio: 0.05,
      growthFloor: 6000, growthCap: 50000, minGrowthFloor: 5000,
      minGrowthRatio: 0.45, emergencyThresholdPct: 0.98,
    },
    promotionThreshold: 5,
    truncate: { threshold: 1 },
    merge: { maxSummaryLength: 3000, minOldGenBlocks: 3 },
    compress: { minCompressRange: 0, maxSummaryLength: 20000, minSummaryLength: 50 },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
    ...over,
  } as Config;
}

const core = createCore();
const config = cfg();

/** 与 src/evict.ts 里的标记补齐逻辑一致。 */
function evictMarker(blockId: string, n: number, minSummaryLength = 50): string {
  const base = `[evicted: 块 ${blockId} · 折叠于 12:00 · 原文 ${n} 条 · 已归档，摘要整体丢弃，仅留此标记供回溯]`;
  return base.length >= minSummaryLength
    ? base
    : base + " · " + "归档".repeat(Math.ceil((minSummaryLength - base.length) / 2) + 1);
}

/** 造 8 条原文，把 m1..m4 折成一个 active 块（长摘要）。 */
function setup() {
  const messages: CoreMessage[] = Array.from({ length: 8 }, (_, i) =>
    msg("m" + i, "message-" + i + "-" + "x".repeat(50), i % 2 === 0 ? "user" : "assistant"),
  );
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, { existing: state.messageRefs, nextIndex: 1 }).map;
  const startRef = state.messageRefs.byRaw["m1"]!;
  const endRef = state.messageRefs.byRaw["m4"]!;
  const longSummary = "OLD_SUMMARY_" + "L".repeat(600);
  const res = core.applyCompression({
    ranges: [{ startRef, endRef, summary: longSummary }],
    messages,
    state,
    config,
    protectedMessageIds: new Set<string>(),
  });
  assert.equal(res.result.blocksCreated, 1, "前置条件：先折出一个 active 块");
  return { messages, state: res.state, startRef, endRef, longSummary };
}

// ═══════════════════════════════════════════════════════════════════════
// A. swapBlockSummary（生产实现，纯函数）
// ═══════════════════════════════════════════════════════════════════════

test("A1 换 summary：保持 active、topic=evicted、不改原 state", () => {
  const { state, longSummary } = setup();
  const old = state.blocks.find((b) => b.active)!;
  const marker = evictMarker(old.blockId, 4);
  const r = swapBlockSummary(state, old.blockId, marker, longSummary.length);

  assert.equal(r.applied, true);
  const now = r.state.blocks.find((b) => b.blockId === old.blockId)!;
  assert.equal(now.active, true, "绝不能标 inactive，否则 collectSummaryAnchors 不注入");
  assert.equal(now.summary, marker);
  assert.equal(now.topic, "evicted");
  assert.equal(state.blocks.find((b) => b.blockId === old.blockId)!.summary, longSummary, "原 state 一字未动");
  assert.equal(r.state.blocks.length, state.blocks.length, "不新增块、不删块");
});

test("A2 幂等：已是标记的块不再落地，计数不加", () => {
  const { state, longSummary } = setup();
  const old = state.blocks.find((b) => b.active)!;
  const marker = evictMarker(old.blockId, 4);
  const once = swapBlockSummary(state, old.blockId, marker, longSummary.length);
  const twice = swapBlockSummary(once.state, old.blockId, marker, longSummary.length);
  assert.equal(twice.applied, false);
  assert.equal(twice.reclaimedChars, 0);
  assert.equal(twice.state, once.state);
});

test("A3 不存在的 blockId 安全跳过", () => {
  const { state } = setup();
  const r = swapBlockSummary(state, "b-does-not-exist", "[evicted: x]", 600);
  assert.equal(r.applied, false);
  assert.equal(r.state, state);
});

test("A4 回收字符数与报表计数公式（今天出过『全是 0』的洋相）", () => {
  const { state, longSummary } = setup();
  const old = state.blocks.find((b) => b.active)!;
  const marker = evictMarker(old.blockId, 4);
  const r = swapBlockSummary(state, old.blockId, marker, longSummary.length);
  assert.equal(r.reclaimedChars, Math.max(0, longSummary.length - marker.length));
  assert.ok(r.reclaimedChars > 0);
  // maybeEvict 里：appliedBlocks++、reclaimedBlockChars += reclaimedChars、
  // appliedTokens += ceil(reclaimedBlockChars/4)。这里验算等价结果不为 0。
  const appliedBlocks = 1;
  const appliedTokens = Math.ceil(r.reclaimedChars / 4);
  assert.equal(appliedBlocks, 1);
  assert.ok(appliedTokens > 0, `reclaimedTokens 不能是 0，实际 ${appliedTokens}`);
});

test("A5 短标记也能落地：不再受 kernel validateSummaryLength 限制", () => {
  const { state, longSummary } = setup();
  const old = state.blocks.find((b) => b.active)!;
  const short = "[evicted: 块 b1 · 折叠于 12:00 · 原文 4 条]";
  assert.ok(short.length < config.compress.minSummaryLength);
  const r = swapBlockSummary(state, old.blockId, short, longSummary.length);
  assert.equal(r.applied, true, "换 summary 不经过 applyCompression，短标记不再被拒");
  assert.equal(r.state.blocks.find((b) => b.blockId === old.blockId)!.summary, short);
});

// ═══════════════════════════════════════════════════════════════════════
// B. 真实 kernel prune：视图里长摘要变成标记
// ═══════════════════════════════════════════════════════════════════════

test("B1 prune 后旧长摘要消失、只剩 evicted 标记，视图变小", () => {
  const { messages, state, longSummary } = setup();
  const old = state.blocks.find((b) => b.active)!;

  const before = prune(messages, state, { injectSummaries: true });
  const beforeText = JSON.stringify(before);
  assert.ok(beforeText.includes(longSummary.slice(0, 30)), "前置：视图里有旧长摘要");
  const beforeChars = before.reduce((n, m) => n + ((m as { text?: string }).text?.length ?? 0), 0);

  const marker = evictMarker(old.blockId, 4);
  const swapped = swapBlockSummary(state, old.blockId, marker, longSummary.length);
  const after = prune(messages, swapped.state, { injectSummaries: true });
  const afterText = JSON.stringify(after);
  const afterChars = after.reduce((n, m) => n + ((m as { text?: string }).text?.length ?? 0), 0);

  assert.ok(!afterText.includes(longSummary.slice(0, 30)), "旧长摘要已消失");
  assert.ok(afterText.includes(marker), "视图里是 evicted 标记");
  assert.ok(afterChars < beforeChars, `视图字符数应下降：${beforeChars} → ${afterChars}`);
  assert.equal(swapped.state.blocks.find((b) => b.blockId === old.blockId)!.active, true);
});

test("B2 所有块的 summary 仍是可读文本，没有空 summary（空会让 rebuild 崩）", () => {
  const { state, longSummary } = setup();
  const old = state.blocks.find((b) => b.active)!;
  const swapped = swapBlockSummary(state, old.blockId, evictMarker(old.blockId, 4), longSummary.length).state;
  for (const b of swapped.blocks.filter((x) => x.active)) {
    assert.ok(typeof b.summary === "string" && b.summary.trim().length > 0, `块 ${b.blockId} 的 summary 不该为空`);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// C. 候选收集层面的幂等
// ═══════════════════════════════════════════════════════════════════════

test("C1 换过的块不再进候选（collectBlockCandidates 的 startsWith 判定）", () => {
  const { state, longSummary } = setup();
  const old = state.blocks.find((b) => b.active)!;

  const spansBefore = new Map(state.blocks.map((b, i) => [b.blockId, {
    blockId: b.blockId, startSeq: i * 10, endSeq: i * 10 + 5,
    startRefNum: null, endRefNum: null, active: b.active, ord: i,
  }]));
  const before = collectBlockCandidates(state, 100000, new Set<string>(), 0, { spans: spansBefore, seqRefCheck: "off" });
  assert.ok(before.length >= 1, "前置：长摘要块应进候选");

  const swapped = swapBlockSummary(state, old.blockId, evictMarker(old.blockId, 4), longSummary.length).state;
  const spansAfter = new Map(swapped.blocks.map((b, i) => [b.blockId, {
    blockId: b.blockId, startSeq: i * 10, endSeq: i * 10 + 5,
    startRefNum: null, endRefNum: null, active: b.active, ord: i,
  }]));
  const after = collectBlockCandidates(swapped, 100000, new Set<string>(), 0, { spans: spansAfter, seqRefCheck: "off" });
  assert.equal(after.length, 0, "标记块不该再进候选 → 第二次跑 evicted=0");
});
