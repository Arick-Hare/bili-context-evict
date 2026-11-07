/**
 * 集成自检：用真实 kernel 验证「deactivate 旧块 → applyCompression 造 evicted
 * 标记块 → prune」这条路径真的能落地（而不是被判 noop / 把原文恢复出来）。
 * 纯逻辑、不读真实配置、不碰运行副本。
 *
 *   <DSH Node24> --import tsx --test verify-block-evict-kernel.mts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createCore, createInitialState, prune, deactivateBlock } from "acp-kernel";
import { assignRefs } from "./kernel/src/refs.js";
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
    // 补丁一：真实生效配置的 minSummaryLength=50。上轮这里设成 0，掩盖了
    // 「一行 evicted 标记太短被 kernel 整批拒」的 bug —— 必须用真实值。
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

/** 与 src/evict.ts 里的标记补齐逻辑一致（含 minSummaryLength 动态补齐）。 */
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

test("deactivate 旧块后，同范围 applyCompression 能造出新块（不被判 noop）", () => {
  const { messages, state, startRef, endRef } = setup();
  const old = state.blocks.find((b) => b.active)!;
  const trial = deactivateBlock(state, [old.blockId]);
  assert.equal(trial.blocks.find((b) => b.blockId === old.blockId)!.active, false, "旧块已标 inactive");

  const marker = evictMarker("b1", 4);
  assert.ok(marker.length >= config.compress.minSummaryLength, "标记长度必须过 kernel 校验");
  const res = core.applyCompression({
    ranges: [{ startRef, endRef, summary: marker }],
    messages,
    state: trial,
    config,
    protectedMessageIds: new Set<string>(),
  });
  assert.equal(res.result.blocksCreated, 1, "同范围应能造出 evicted 标记块");
  assert.equal(res.state.blocks.find((b) => b.blockId === old.blockId)!.active, false, "旧块仍 inactive");
  const created = res.state.blocks.filter((b) => b.active);
  assert.ok(created.some((b) => b.summary === marker), "新块 summary 是那行标记");
});

test("prune 后旧长摘要消失、只剩 evicted 标记（视图真的变小）", () => {
  const { messages, state, startRef, endRef, longSummary } = setup();
  const old = state.blocks.find((b) => b.active)!;

  const before = prune(messages, state, { injectSummaries: true });
  const beforeText = JSON.stringify(before);
  assert.ok(beforeText.includes(longSummary.slice(0, 30)), "前置：视图里有旧长摘要");
  const beforeChars = before.reduce((n, m) => n + ((m as { text?: string }).text?.length ?? 0), 0);

  const trial = deactivateBlock(state, [old.blockId]);
  const marker = evictMarker("b1", 4);
  const res = core.applyCompression({
    ranges: [{ startRef, endRef, summary: marker }],
    messages,
    state: trial,
    config,
    protectedMessageIds: new Set<string>(),
  });
  assert.equal(res.result.blocksCreated, 1);
  const after = prune(messages, res.state, { injectSummaries: true });
  const afterText = JSON.stringify(after);
  const afterChars = after.reduce((n, m) => n + ((m as { text?: string }).text?.length ?? 0), 0);

  assert.ok(!afterText.includes(longSummary.slice(0, 30)), "旧长摘要已消失");
  assert.ok(afterText.includes(marker), "视图里是 evicted 标记");
  assert.ok(afterChars < beforeChars, `视图字符数应下降：${beforeChars} → ${afterChars}`);
});

test("不会重复扔：新块已是 evicted 标记，旧块 inactive 不再被 collectBlockCandidates 选中", async () => {
  const { collectBlockCandidates, refNumber } = await import("./src/evict.js");
  const { messages, state, startRef, endRef } = setup();
  const old = state.blocks.find((b) => b.active)!;
  const trial = deactivateBlock(state, [old.blockId]);
  const marker = evictMarker("b1", 4);
  const res = core.applyCompression({
    ranges: [{ startRef, endRef, summary: marker }],
    messages,
    state: trial,
    config,
    protectedMessageIds: new Set<string>(),
  });
  // 补丁一新签名：boundary 用 ref 数值（放到很大，所有块都算已封盘）
  const units = collectBlockCandidates(
    res.state,
    Math.max(...res.state.blocks.map((b) => refNumber(b.endRef) ?? 0)) + 1000,
    new Set<string>(),
    200,
  );
  assert.equal(units.length, 0, "旧块 inactive + 新块是标记，都不该再进候选");
});

test("补丁一回归：短标记被 kernel 拒，补齐后才成功（真实 minSummaryLength=50）", () => {
  const { messages, state, startRef, endRef } = setup();
  const old = state.blocks.find((b) => b.active)!;
  const trial = deactivateBlock(state, [old.blockId]);
  const short = "[evicted: 块 b1 · 折叠于 12:00 · 原文 4 条]";
  assert.ok(short.length < config.compress.minSummaryLength, "前置：短标记确实短于 50");
  const rejected = core.applyCompression({
    ranges: [{ startRef, endRef, summary: short }],
    messages, state: trial, config, protectedMessageIds: new Set<string>(),
  });
  assert.equal(rejected.result.blocksCreated, 0, "短标记应被 summary-length 校验拒掉");
  assert.match((rejected.result.errors ?? []).join(" "), /summary-length/i);

  const long = evictMarker("b1", 4);
  assert.ok(long.length >= config.compress.minSummaryLength);
  const accepted = core.applyCompression({
    ranges: [{ startRef, endRef, summary: long }],
    messages, state: trial, config, protectedMessageIds: new Set<string>(),
  });
  assert.equal(accepted.result.blocksCreated, 1, "补齐后应能造块");
});
