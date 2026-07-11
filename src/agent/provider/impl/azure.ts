/**
 * Azure OpenAI provider 实现。
 *
 * 复用 `openai.ts` 的 SSE 解析器；与标准 OpenAI 协议的区别仅在于
 * 端点 URL 的构建方式和认证请求头的不同。
 *
 * URL 格式：{baseURL}/openai/deployments/{azureDeployment}/chat/completions?api-version={azureApiVersion}
 * 认证：使用 `api-key` 请求头，而非 `Authorization: Bearer`。
 */

import type { ChatMessage, LLMProvider, StreamChunk } from "../types"
import type { AzureProviderConfig } from "../types"
import { LLMError } from "../errors"
import { parseStream } from "./openai"

export class AzureOpenAIProvider implements LLMProvider {
  readonly id: string
  readonly label: string
  readonly model: string
  readonly config: AzureProviderConfig

  constructor(config: AzureProviderConfig) {
    this.id = config.id
    this.label = config.label
    this.model = config.model
    this.config = config
  }

  async *stream(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const baseURL = (this.config.baseURL ?? "").replace(/\/$/, "")
    const deployment = this.config.azureDeployment
    const apiVersion = this.config.azureApiVersion

    const url = `${baseURL}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "api-key": this.config.apiKey ?? "",
    }

    const body = JSON.stringify({
      model: this.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    })

    let response: Response | undefined

    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal,
      })
    } catch (err) {
      if (err instanceof TypeError || (err instanceof Error && err.name === "AbortError")) {
        throw LLMError.fromNetworkError(err)
      }
      throw err
    }

    if (!response.ok) {
      throw await LLMError.fromResponse(response)
    }

    yield* parseStream(response, signal)
  }
}
