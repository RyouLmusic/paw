/**
 * OpenAIProvider 和 parseStream 的测试。
 */

import { test, expect, describe, afterEach } from "bun:test"
import { OpenAIProvider, parseStream } from "./openai"
import { LLMError } from "../errors"
import type { OpenAIProviderConfig } from "../types"
import { simpleMockResponse, createMockFetch } from "./test-helpers"

const originalFetch = globalThis.fetch

const sampleConfig: OpenAIProviderConfig = {
  id: "test-openai",
  type: "openai",
  label: "Test OpenAI",
  apiKey: "sk-test",
  model: "gpt-4o",
  baseURL: "https://api.openai.com/v1",
}

/** 将 SSE 数据行编码为 ReadableStream。 */
function sseStream(...lines: string[]): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(lines.join("\n\n")))
      controller.close()
    },
  })
}

describe("OpenAIProvider", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("stream: 从 SSE 响应产出数据块", async () => {
    globalThis.fetch = simpleMockResponse({
      ok: true,
      status: 200,
      body: sseStream(
        `data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}`,
        `data: {"choices":[{"delta":{"content":" world"},"index":0}]}`,
        `data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}`,
        `data: [DONE]`,
      ),
    })

    const provider = new OpenAIProvider(sampleConfig)
    const chunks: string[] = []

    for await (const chunk of provider.stream([
      { role: "user", content: "hi" },
    ])) {
      if (chunk.delta) chunks.push(chunk.delta)
      if (chunk.done) break
    }

    expect(chunks).toEqual(["Hello", " world"])
  })

  test("stream: 401 时抛出 LLMError", async () => {
    globalThis.fetch = simpleMockResponse({
      ok: false,
      status: 401,
      text: async () => '{"error":"unauthorized"}',
    })

    const provider = new OpenAIProvider(sampleConfig)
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

  test("stream: 429 时抛出 LLMError", async () => {
    globalThis.fetch = simpleMockResponse({
      ok: false,
      status: 429,
      text: async () => "Rate limit",
    })

    const provider = new OpenAIProvider(sampleConfig)
    try {
      for await (const _ of provider.stream([{ role: "user", content: "hi" }])) {
        /* 空 */
      }
      expect.unreachable("应当抛出异常")
    } catch (err) {
      expect((err as LLMError).kind).toBe("rate_limited")
    }
  })

  test("stream: 404 时抛出 LLMError", async () => {
    globalThis.fetch = simpleMockResponse({
      ok: false,
      status: 404,
      text: async () => "Not found",
    })

    const provider = new OpenAIProvider(sampleConfig)
    try {
      for await (const _ of provider.stream([{ role: "user", content: "hi" }])) {
        /* 空 */
      }
      expect.unreachable("应当抛出异常")
    } catch (err) {
      expect((err as LLMError).kind).toBe("model_not_found")
    }
  })

  test("stream: 500 时抛出 LLMError", async () => {
    globalThis.fetch = simpleMockResponse({
      ok: false,
      status: 500,
      text: async () => "Server error",
    })

    const provider = new OpenAIProvider(sampleConfig)
    try {
      for await (const _ of provider.stream([{ role: "user", content: "hi" }])) {
        /* 空 */
      }
      expect.unreachable("应当抛出异常")
    } catch (err) {
      expect((err as LLMError).kind).toBe("server_error")
    }
  })

  test("stream: 网络错误时抛出 LLMError", async () => {
    globalThis.fetch = createMockFetch(() => {
      throw new TypeError("fetch failed")
    })

    const provider = new OpenAIProvider(sampleConfig)
    try {
      for await (const _ of provider.stream([{ role: "user", content: "hi" }])) {
        /* 空 */
      }
      expect.unreachable("应当抛出异常")
    } catch (err) {
      expect(err).toBeInstanceOf(LLMError)
      expect((err as LLMError).kind).toBe("network_timeout")
      expect((err as LLMError).message).toContain("fetch failed")
    }
  })

  test("stream: AbortSignal 被中止时停止", async () => {
    globalThis.fetch = createMockFetch((_url, opts) => {
      // 模拟 fetch 因信号中止的异常
      const signal = opts?.signal
      if (signal?.aborted) {
        const err = new Error("The operation was aborted")
        err.name = "AbortError"
        throw err
      }
      return {
        ok: true,
        status: 200,
        body: sseStream(`data: [DONE]`),
      }
    })

    const provider = new OpenAIProvider(sampleConfig)
    const ac = new AbortController()
    ac.abort() // 在调用 stream 前中止

    try {
      for await (const _ of provider.stream(
        [{ role: "user", content: "hi" }],
        ac.signal,
      )) {
        /* 空 */
      }
      expect.unreachable("应当抛出异常")
    } catch (err) {
      expect(err).toBeInstanceOf(LLMError)
    }
  })

  test("parseStream: 遇到 [DONE] 标记时产出 done=true", async () => {
    const res = {
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
          controller.close()
        },
      }),
    } as unknown as Response

    const results: any[] = []
    for await (const chunk of parseStream(res)) {
      results.push(chunk)
    }

    expect(results).toHaveLength(1)
    expect(results[0].done).toBe(true)
  })

  test("parseStream: P2-17 提前 break 时安全清理", async () => {
    const res = {
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: {"choices":[{"delta":{"content":"hi"}}]}\n\n`,
            ),
          )
        },
      }),
    } as unknown as Response

    // 关键验证：提前 break 不会抛出异常
    await (async () => {
      for await (const _ of parseStream(res)) {
        break
      }
    })()

    expect(true).toBe(true) // 成功执行到此处即通过
  })
})
