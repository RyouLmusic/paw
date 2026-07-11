/**
 * 快速端到端测试：用真实 API 密钥测试 provider streaming。
 *
 * 用法：
 *   bun run scripts/test-provider.ts
 *
 * 先确保 ~/.paw/settings.json 已配置好 API Key。
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
  console.log(`   文件路径: ${result.path}`)
  console.log(`   当前 provider: ${providerRegistry.getActiveProviderId()}`)

  // 列出所有可用 provider
  const allProviders = providerRegistry.listProviders()
  console.log(`\n📋 可用 provider (${allProviders.length} 个):`)
  allProviders.forEach((p) => {
    const active = p.id === providerRegistry.getActiveProviderId()
    console.log(`   ${active ? "→" : " "} ${p.label} (${p.model})${active ? " [当前]" : ""}`)
  })

  // 用当前 provider 发起一次 streaming 请求
  const provider = providerRegistry.getActiveProvider()
  console.log(`\n🚀 向 ${provider.label} 发起 streaming 请求...`)
  console.log(`   模型: ${provider.model}`)
  console.log("--- 响应开始 ---")

  let fullText = ""
  try {
    const signal = providerRegistry.beginStream()
    for await (const chunk of provider.stream(
      [{ role: "user", content: "用一句话介绍你自己" }],
      signal,
    )) {
      if (chunk.delta) {
        fullText += chunk.delta
        process.stdout.write(chunk.delta)
      }
      if (chunk.done) {
        providerRegistry.endStream()
        console.log() // 换行
        if (chunk.stopReason) {
          console.log(`\n📌 停止原因: ${chunk.stopReason}`)
        }
      }
    }

    console.log(`\n✅ 请求成功！收到 ${fullText.length} 个字符`)
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

  // 测试 provider 切换
  if (allProviders.length > 1) {
    const targetId = allProviders.find((p) => p.id !== providerRegistry.getActiveProviderId())?.id
    if (targetId) {
      console.log(`\n🔄 测试切换到 provider: ${targetId}`)
      try {
        await providerRegistry.switchProvider(targetId)
        console.log(`✅ 切换成功，当前 provider: ${providerRegistry.getActiveProviderId()}`)
      } catch (err) {
        console.error(`❌ 切换失败: ${err}`)
      }
    }
  }

  console.log("\n🎉 测试完成")
}

main().catch(console.error)
