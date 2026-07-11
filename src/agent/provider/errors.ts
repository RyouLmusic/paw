/**
 * LLMError 类型定义。
 *
 * 每个 provider 实现将 HTTP 错误／网络故障映射到以下分类之一，
 * 以便 TUI 根据分类展示不同的提示信息。
 */

/** LLM API 调用失败的分类标签。 */
export type LLMErrorKind =
  | "auth_failed"       // 401 / API Key 无效
  | "rate_limited"      // 429
  | "network_timeout"   // 连接超时或 DNS 解析失败
  | "model_not_found"   // 404 / 模型名称不存在
  | "server_error"      // 5xx
  | "unknown"           // 其他所有情况

/** 携带机器可读的 `kind` 字段的结构化错误。 */
export class LLMError extends Error {
  readonly kind: LLMErrorKind

  constructor(kind: LLMErrorKind, message: string) {
    super(message)
    this.kind = kind
    this.name = "LLMError"

    // 修复原型链，确保 instanceof 检查正常工作
    Object.setPrototypeOf(this, LLMError.prototype)
  }

  // ── 工厂方法 ──────────────────────────────────────────────────────────────

  /** 根据 HTTP 响应状态码创建 LLMError。 */
  static fromHttpStatus(status: number, body?: string): LLMError {
    const msg = body ? `HTTP ${status}: ${body}` : `HTTP ${status}`
    switch (status) {
      case 401:
        return new LLMError("auth_failed", msg)
      case 429:
        return new LLMError("rate_limited", msg)
      case 404:
        return new LLMError("model_not_found", msg)
      default:
        if (status >= 500) return new LLMError("server_error", msg)
        return new LLMError("unknown", msg)
    }
  }

  /** 为网络／超时故障创建 LLMError。 */
  static fromNetworkError(cause: unknown): LLMError {
    const msg = cause instanceof Error ? cause.message : String(cause)
    return new LLMError("network_timeout", msg)
  }

  /** 将 fetch Response 映射为 LLMError（读取响应体以获取详情）。 */
  static async fromResponse(res: Response): Promise<LLMError> {
    let body = ""
    try {
      body = await res.text()
    } catch { /* 尽力读取 */ }
    return LLMError.fromHttpStatus(res.status, body.slice(0, 500))
  }
}
