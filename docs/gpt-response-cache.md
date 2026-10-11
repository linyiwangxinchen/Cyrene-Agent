# GPT Responses 缓存与中转兼容

## 本次修复

- 原生 GPT Responses 中转不再仅因域名不是 `api.openai.com` 而丢弃缓存提示和加密推理请求。`gpt-6.1-sol` 等 GPT 模型默认启用；未知模型保留原有兼容策略。
- `store: false` 保持无状态运行，同时请求 `include: ["reasoning.encrypted_content"]`，将返回的推理信息保存到 transcript，同一来源下一轮原生回放。端点、Key、模型或协议变更后仍隔离私有推理，不能跨来源回放。
- 在底层统一应用缓存提示与工具排序，覆盖 Harness、Web 直调和辅助请求；修复 ChatLoop 将提示词层元数据错写为 `metadata`，导致缓存身份没有使用实际稳定前缀的问题。
- 模型档案新增“原生 OpenAI Responses 兼容”开关。已知 GPT 模型自动开启，无需重新保存旧档案；只支持部分 Responses 字段的服务可显式关闭。此项随档案保存，Windows 与 Web 共用。

## 使用

更新源码、重新构建并重启服务后，GPT + Responses 档案自动使用修复后的策略。在模型设置中可查看或覆盖“原生 OpenAI Responses 兼容”。旧历史缺少加密推理时无法补造；验证多轮缓存请从更新后的新回复开始。

`prompt_cache_key` 不是启用缓存的开关，也不保证命中。缓存依赖服务端复用一致的输入前缀；对 GPT-5.6 及以后模型，该键主要划分缓存统计。切换工具、模型、人设，压缩或裁剪历史，都可能导致部分前缀无法复用。

以服务商返回的 `usage.input_tokens_details.cached_tokens` 判断缓存读取量。总输入 Token 包括缓存输入，不能仅根据总输入仍很大判断未命中。服务商实际收费以其账单为准。

官方参考：https://developers.openai.com/api/docs/guides/prompt-caching

## 验证边界

自动测试验证中转端点实际收到缓存提示、加密推理参数；流式与非流式响应经持久化后，下一轮保留旧输入前缀及加密推理，工具顺序变化不会改变工具定义。测试验证请求和回放行为，不模拟或证明远端缓存命中率。
