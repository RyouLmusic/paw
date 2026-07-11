/**
 * AzureOpenAIProvider 的测试。
 */

import { test, expect, describe, afterEach } from "bun:test"
import { AzureOpenAIProvider } from "./azure"
import { LLMError } from "../errors"
import type { AzureProviderConfig } from "../types"
import { createMockFetch, simpleMockResponse } from "./test-helpers"

const originalFetch = globalThis.fetch

const sampleConfig: AzureProviderConfig = {
  id: "test-azure",
  type: "azure",
  label: "Azure GPT-4",
  apiKey: "azure-key",
  model: "gpt-4",
  baseURL: "https://my-resource.openai.azure.com",
  azureDeployment: "my-gpt4-deploy",
  azureApiVersion: "2024-02-01",
}

describe("AzureOpenAIProvider", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("stream: 使用正确的 Azure 端点 URL 和 api-key 请求头", async () => {
    let calledUrl = ""
    let sentHeaders: Record<string, string> = {}

    globalThis.fetch = createMockFetch((url, opts) => {
      calledUrl = url
      sentHeaders = (opts?.headers ?? {}) as Record<string, string>
      return {
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n`,
              ),
            )
            controller.close()
          },
        }),
      }
    })

    const provider = new AzureOpenAIProvider(sampleConfig)
    for await (const chunk of provider.stream([{ role: "user", content: "hi" }])) {
      if (chunk.done) break
    }

    expect(calledUrl).toContain("my-resource.openai.azure.com")
    expect(calledUrl).toContain("/openai/deployments/my-gpt4-deploy/chat/completions")
    expect(calledUrl).toContain("api-version=2024-02-01")

    // Azure 使用 `api-key` 请求头，而非 `Authorization: Bearer`
    expect(sentHeaders["api-key"]).toBe("azure-key")
    expect(sentHeaders["Authorization"]).toBeUndefined()
  })

  test("stream: HTTP 错误时抛出 LLMError", async () => {
    globalThis.fetch = simpleMockResponse({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    })

    const provider = new AzureOpenAIProvider(sampleConfig)
    try {
      for await (const _ of provider.stream([{ role: "user", content: "hi" }])) {
        /* 空 */
      }
      expect.unreachable("应当抛出异常")
    } catch (err) {
      expect((err as LLMError).kind).toBe("auth_failed")
    }
  })
})
