/**
 * AnthropicProvider 的测试。
 */

import { test, expect, describe, afterEach } from "bun:test"
import { AnthropicProvider } from "./anthropic"
import { LLMError } from "../errors"
import type { AnthropicProviderConfig } from "../types"
import { simpleMockResponse, createMockFetch } from "./test-helpers"

const originalFetch = globalThis.fetch

const sampleConfig: AnthropicProviderConfig = {
  id: "test-anthropic",
  type: "anthropic",
  label: "Test Anthropic",
  apiKey: "sk-ant-test",
  model: "claude-sonnet-5",
}

describe("AnthropicProvider", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("stream: 从 Anthropic SSE 事件产出数据块", async () => {
    const events = [
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}`,
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null}}`,
      `event: message_stop\ndata: {"type":"message_stop"}`,
    ].join("\n\n")

    globalThis.fetch = simpleMockResponse({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(events))
          controller.close()
        },
      }),
    })

    const provider = new AnthropicProvider(sampleConfig)
    const chunks: string[] = []
    let finalStopReason: string | undefined

    for await (const chunk of provider.stream([
      { role: "user", content: "hi" },
    ])) {
      if (chunk.delta) chunks.push(chunk.delta)
      if (chunk.stopReason) finalStopReason = chunk.stopReason
      if (chunk.done) break
    }

    expect(chunks).toEqual(["Hello", " world"])
    expect(finalStopReason).toBe("stop")
  })

  test("stream: 处理 tool_use 停止原因", async () => {
    const events = [
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me check"}}`,
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null}}`,
      `event: message_stop\ndata: {"type":"message_stop"}`,
    ].join("\n\n")

    globalThis.fetch = simpleMockResponse({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(events))
          controller.close()
        },
      }),
    })

    const provider = new AnthropicProvider(sampleConfig)
    let stopReason: string | undefined

    for await (const chunk of provider.stream([
      { role: "user", content: "show me tools" },
    ])) {
      if (chunk.stopReason) stopReason = chunk.stopReason
      if (chunk.done) break
    }

    expect(stopReason).toBe("tool_use")
  })

  test("stream: 401 认证失败时抛出 LLMError", async () => {
    globalThis.fetch = simpleMockResponse({
      ok: false,
      status: 401,
      text: async () => '{"error":"unauthorized"}',
    })

    const provider = new AnthropicProvider(sampleConfig)
    try {
      for await (const _ of provider.stream([{ role: "user", content: "hi" }])) {
        /* 空 */
      }
      expect.unreachable("应当抛出异常")
    } catch (err) {
      expect(err).toBeInstanceOf(LLMError)
      expect((err as LLMError).kind).toBe("auth_failed")
    }
  })

  test("stream: 网络超时时抛出 LLMError", async () => {
    globalThis.fetch = createMockFetch(() => {
      throw new TypeError("fetch failed")
    })

    const provider = new AnthropicProvider(sampleConfig)
    try {
      for await (const _ of provider.stream([{ role: "user", content: "hi" }])) {
        /* 空 */
      }
      expect.unreachable("应当抛出异常")
    } catch (err) {
      expect((err as LLMError).kind).toBe("network_timeout")
    }
  })

  test("stream: 正确解析含 thinking block 的 SSE 流", async () => {
    // Fixture A：模拟 Anthropic Extended Thinking 流
    // 事件序列：message_start → content_block_start(type:thinking) →
    // content_block_delta(thinking_delta) → content_block_stop →
    // content_block_start(type:text) → content_block_delta(text_delta) →
    // content_block_stop → message_delta(end_turn) → message_stop
    const events = [
      `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_01","type":"message","role":"assistant","content":[],"model":"claude-sonnet-5"}}`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"正在思考"}}`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"如何分解这个问题"}}`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"..."}}`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"结论是：42"}}`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":1}`,
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null}}`,
      `event: message_stop\ndata: {"type":"message_stop"}`,
    ].join("\n\n")

    globalThis.fetch = simpleMockResponse({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(events))
          controller.close()
        },
      }),
    })

    const provider = new AnthropicProvider(sampleConfig)
    const thinkingDeltas: string[] = []
    const textDeltas: string[] = []
    let finalStopReason: string | undefined
    let seenThinkingDelta = false
    let seenThinkingDeltaField = false

    for await (const chunk of provider.stream([
      { role: "user", content: "深度思考问题" },
    ])) {
      if (chunk.thinkingDelta !== undefined) {
        seenThinkingDeltaField = true
      }
      if (chunk.thinkingDelta) {
        seenThinkingDelta = true
        thinkingDeltas.push(chunk.thinkingDelta)
      }
      if (chunk.delta) {
        textDeltas.push(chunk.delta)
      }
      if (chunk.done) {
        finalStopReason = chunk.stopReason
        break
      }
    }

    // 验证 thinking delta 正确产出
    expect(seenThinkingDeltaField).toBe(true)
    expect(seenThinkingDelta).toBe(true)
    expect(thinkingDeltas.join("")).toBe("如何分解这个问题...")

    // 验证 thinking delta 期间 delta 为空字符串
    // 验证文本 delta 正确产出（不含 thinkingDelta）
    expect(textDeltas).toEqual(["结论是：42"])

    // 验证 stopReason
    expect(finalStopReason).toBe("stop")
  })

  test("stream: 不含 thinking block 的普通流不产出 thinkingDelta（向后兼容）", async () => {
    // Fixture B：普通文本流，与修改前行为完全一致
    const events = [
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null}}`,
      `event: message_stop\ndata: {"type":"message_stop"}`,
    ].join("\n\n")

    globalThis.fetch = simpleMockResponse({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(events))
          controller.close()
        },
      }),
    })

    const provider = new AnthropicProvider(sampleConfig)
    const chunks: string[] = []
    let stopReason: string | undefined

    for await (const chunk of provider.stream([
      { role: "user", content: "hi" },
    ])) {
      // 验证所有 chunk 均不含 thinkingDelta
      expect(chunk.thinkingDelta).toBeUndefined()
      if (chunk.delta) chunks.push(chunk.delta)
      if (chunk.stopReason) stopReason = chunk.stopReason
      if (chunk.done) break
    }

    expect(chunks).toEqual(["Hello", " world"])
    expect(stopReason).toBe("stop")
  })
})
