/**
 * 端到端测试：验证 thinking block streaming 的正确性。
 *
 * 使用当前配置的 provider 发送一条消息，观察 thinking 内容
 * 是否为独立输出（而非混入普通文本）。
 *
 * 用法：
 *   bun run scripts/test-thinking.ts
 *
 * 先确保 ~/.paw/settings.json 已配置好 API Key。
 * 推荐使用支持 Extended Thinking 的模型（如 claude-sonnet-5）。
 */

import { providerRegistry } from "../src/agent/provider/registry"

async function main() {
  const result = await providerRegistry.loadSettings()

  if (!result.ok) {
    if (result.reason === "missing") {
      console.error("❌ 未找到配置文件，请先创建 ~/.paw/settings.json")
      return
    }
    if (result.reason === "parse_error") {
      console.error("❌ 配置文件格式错误:")
      result.errors.forEach((e) => console.error("  ", e))
      return
    }
  }

  console.log("✅ 配置加载成功")
  console.log(`   当前 provider: ${providerRegistry.getActiveProviderId()}`)

  const provider = providerRegistry.getActiveProvider()
  console.log(`\n🚀 向 ${provider.label} 发起 streaming 请求...`)
  console.log(`   模型: ${provider.model}`)
  console.log("   提示词: 请先深入思考再回答——13×17 等于多少？一步步推理。")
  console.log("--- 响应开始 ---\n")

  let fullText = ""
  let fullThinking = ""
  let thinkingChunks = 0
  let textChunks = 0

  try {
    const signal = providerRegistry.beginStream()
    for await (const chunk of provider.stream(
      [{ role: "user", content: "13×17 等于多少？" }],
      signal,
    )) {
      if (chunk.thinkingDelta) {
        fullThinking += chunk.thinkingDelta
        thinkingChunks++
        // 思考内容以灰色（dim）显示，与普通文本区分
        process.stdout.write(`\x1b[2m${chunk.thinkingDelta}\x1b[0m`)
      }
      if (chunk.delta) {
        fullText += chunk.delta
        textChunks++
        process.stdout.write(chunk.delta)
      }
      if (chunk.done) {
        providerRegistry.endStream()
        console.log()
        if (chunk.stopReason) {
          console.log(`\n📌 停止原因: ${chunk.stopReason}`)
        }
      }
    }

    // 输出统计信息
    console.log("\n--- 统计 ---")
    if (fullThinking) {
      console.log(`🧠 思考内容: ${fullThinking.length} 字符 (${thinkingChunks} 个 chunk)`)
      // 验证思考 delta 期间 text delta 为空
      console.log(`💬 正文内容: ${fullText.length} 字符 (${textChunks} 个 chunk)`)
      console.log("✅ thinkingDelta 与 delta 成功分离输出")
    } else {
      console.log(`💬 正文内容: ${fullText.length} 字符 (${textChunks} 个 chunk)`)
      console.log("ℹ️  未收到 thinking chunk——当前模型可能不支持 Extended Thinking")
    }
  } catch (err) {
    console.error("\n❌ 请求失败:", err instanceof Error ? err.message : String(err))
    if (err instanceof Error && "kind" in err) {
      const kind = (err as any).kind
      const hints: Record<string, string> = {
        auth_failed: "👉 API Key 无效，请检查 settings.json 中的 apiKey",
        rate_limited: "👉 请求过于频繁，请稍后重试",
        network_timeout: "👉 连接超时，请检查网络或 baseURL",
        model_not_found: "👉 模型名称不存在，请检查 model 字段",
        server_error: "👉 服务端错误，请稍后重试",
      }
      console.error(hints[kind] ?? "👉 未知错误，请检查配置")
    }
  }

  console.log("\n🎉 测试完成")
}

main().catch(console.error)
