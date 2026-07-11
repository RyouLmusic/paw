/**
 * OllamaProvider 的测试。
 */

import { test, expect, describe, afterEach } from "bun:test"
import { OllamaProvider } from "./ollama"
import { LLMError } from "../errors"
import type { OllamaProviderConfig } from "../types"
import { createMockFetch, simpleMockResponse } from "./test-helpers"

const originalFetch = globalThis.fetch

const sampleConfig: OllamaProviderConfig = {
  id: "test-ollama",
  type: "ollama",
  label: "Ollama Local",
  model: "llama3",
  baseURL: "http://localhost:11434",
}

describe("OllamaProvider", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("stream: 从 SSE 响应产出数据块", async () => {
    globalThis.fetch = simpleMockResponse({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              [
                `data: {"choices":[{"delta":{"content":"Hello from Ollama"},"index":0}]}`,
                `data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}`,
                `data: [DONE]`,
              ].join("\n\n"),
            ),
          )
          controller.close()
        },
      }),
    })

    const provider = new OllamaProvider(sampleConfig)
    const chunks: string[] = []

    for await (const chunk of provider.stream([
      { role: "user", content: "hi" },
    ])) {
      if (chunk.delta) chunks.push(chunk.delta)
      if (chunk.done) break
    }

    expect(chunks).toEqual(["Hello from Ollama"])
  })

  test("stream: fetch 失败时抛出含 Ollama 特定提示的 network_timeout", async () => {
    globalThis.fetch = createMockFetch(() => {
      throw new TypeError("fetch failed")
    })

    const provider = new OllamaProvider(sampleConfig)
    try {
      for await (const _ of provider.stream([{ role: "user", content: "hi" }])) {
        /* 空 */
      }
      expect.unreachable("应当抛出异常")
    } catch (err) {
      expect(err).toBeInstanceOf(LLMError)
      expect((err as LLMError).kind).toBe("network_timeout")
      expect((err as LLMError).message).toContain("Ollama 服务")
    }
  })

  test("stream: 不发送任何认证请求头", async () => {
    let sentHeaders: Record<string, string> = {}

    globalThis.fetch = createMockFetch((_url, opts) => {
      sentHeaders = (opts?.headers ?? {}) as Record<string, string>
      return {
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
            controller.close()
          },
        }),
      }
    })

    const provider = new OllamaProvider(sampleConfig)
    for await (const chunk of provider.stream([{ role: "user", content: "hi" }])) {
      if (chunk.done) break
    }

    expect(sentHeaders["Authorization"]).toBeUndefined()
    expect(sentHeaders["api-key"]).toBeUndefined()
  })
})
