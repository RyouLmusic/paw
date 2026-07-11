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
})
