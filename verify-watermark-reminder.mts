/**
 * 水位提醒（2026-11-11）验收。
 *
 *   <Node24> --import tsx --test verify-watermark-reminder.mts
 *
 * 覆盖（对应需求验收第 4 条）：
 *   1. 过线提醒        ratio 过阈值 → 返回带 [水位提醒] 的文本
 *   2. 冷却内不提醒    同一 session 紧接着再 decide → null
 *   3. 回落重置        水位掉回阈值以下清标记，下次过线能再提醒（不被永久冷却挡）
 *   4. enabled:false   关闭时不插
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
    clearWatermarkReminderState,
    decideWatermarkReminder,
    DEFAULT_WATERMARK_REMINDER,
    type WatermarkReminderConfig,
} from "./src/watermark-reminder.js";

const base: WatermarkReminderConfig = { ...DEFAULT_WATERMARK_REMINDER };

test("1. 过线提醒：ratio 过阈值 → 返回带 [水位提醒] 的文本", () => {
    clearWatermarkReminderState();
    const text = decideWatermarkReminder({ sessionId: "s1", ratio: 0.5, now: 1000, cfg: base, log: () => {} });
    assert.ok(text !== null, "应提醒");
    assert.ok(text!.includes("[水位提醒]"), "应有固定前缀");
    assert.ok(text!.includes("50.0%"), "应含实际百分比");
    assert.ok(text!.includes("记忆整合流程"), "应含文案");
});

test("2. 冷却内不提醒：同一 session 紧接着再 decide → null", () => {
    clearWatermarkReminderState();
    decideWatermarkReminder({ sessionId: "s2", ratio: 0.5, now: 1000, cfg: base, log: () => {} });
    const again = decideWatermarkReminder({ sessionId: "s2", ratio: 0.5, now: 1000 + 60_000 - 1, cfg: base, log: () => {} });
    assert.equal(again, null, "冷却期内不应重复提醒");
});

test("2b. 冷却结束后可再提醒", () => {
    clearWatermarkReminderState();
    decideWatermarkReminder({ sessionId: "s3", ratio: 0.5, now: 1000, cfg: base, log: () => {} });
    const again = decideWatermarkReminder({ sessionId: "s3", ratio: 0.5, now: 1000 + 60 * 60_000 + 1, cfg: base, log: () => {} });
    assert.ok(again !== null, "冷却结束后应可再次提醒");
});

test("3. 回落重置：水位掉回阈值以下 → 标记清除，下次过线能再提醒", () => {
    clearWatermarkReminderState();
    decideWatermarkReminder({ sessionId: "s4", ratio: 0.5, now: 1000, cfg: base, log: () => {} });
    // 掉回阈值以下
    const drop = decideWatermarkReminder({ sessionId: "s4", ratio: 0.1, now: 2000, cfg: base, log: () => {} });
    assert.equal(drop, null, "回落不应提醒");
    // 冷却还没过（2000-1000=1s < 60m），但因回落重置了标记，应可再次提醒
    const again = decideWatermarkReminder({ sessionId: "s4", ratio: 0.5, now: 3000, cfg: base, log: () => {} });
    assert.ok(again !== null, "回落重置后应立即能再提醒（不被永久冷却挡）");
});

test("4. enabled:false 时不插", () => {
    clearWatermarkReminderState();
    const off: WatermarkReminderConfig = { ...base, enabled: false };
    const text = decideWatermarkReminder({ sessionId: "s5", ratio: 0.9, now: 1000, cfg: off, log: () => {} });
    assert.equal(text, null, "关闭时不提醒");
});

test("clearWatermarkReminderState 清标记后冷却失效可再提醒（验收第 3 条「把标记清掉」）", () => {
    clearWatermarkReminderState("s6");
    decideWatermarkReminder({ sessionId: "s6", ratio: 0.5, now: 1000, cfg: base, log: () => {} });
    assert.equal(decideWatermarkReminder({ sessionId: "s6", ratio: 0.5, now: 2000, cfg: base, log: () => {} }), null, "冷却中本不提醒");
    clearWatermarkReminderState("s6");
    const after = decideWatermarkReminder({ sessionId: "s6", ratio: 0.5, now: 3000, cfg: base, log: () => {} });
    assert.ok(after !== null, "清标记后冷却失效，可再提醒");
});

test("崩溃回归（2026-11-11）：传入两参 log（模拟 ctx.log 签名），decide 不抛 TypeError", () => {
    clearWatermarkReminderState();
    let lastMsg: string | undefined;
    // 模拟真实 ctx.log：(level, msg) => 内部 safe.indexOf(msg) —— msg 为 undefined 会炸
    const twoArgLog = (_level: string, msg: string) => {
        if (msg === undefined) throw new Error("msg undefined (would crash kernel log)");
        lastMsg = msg;
    };
    const text = decideWatermarkReminder({ sessionId: "crash", ratio: 0.5, now: 1000, cfg: base, log: twoArgLog });
    assert.ok(text !== null, "应提醒");
    assert.ok(lastMsg !== undefined, "log 必须收到非 undefined 的 msg");
    assert.ok(lastMsg!.includes("[watermark]"), "应打印水位日志");
});
