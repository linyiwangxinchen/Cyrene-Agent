# 来源与许可

本插件为 Cyrene 原生实现；功能参考 YOYOLnFu/dsh-bili-pond 1.3.14，参考基线 `57765435e33a8697c7f3b3b9f317c6146cd05faa`。

`python/bilibili_backend.py` 的 B 站 API 函数由该项目内嵌的 AGI_Ananas/bilibili-mcp 裁剪适配，按 MIT 使用。保留其评论回执、增量扫描等修改。原许可证位于 `vendor/bilibili-mcp/LICENSE`；衍生版权声明保留于 `vendor/DSH-LICENSE` 和 `vendor/DSH-NOTICE.md`，这些仅为法律文档，不是运行依赖。

已移除整份 MCP 服务、工具注册器、DSH 配置与文件写入、独立凭据文件、环境变量驱动的互动开关和日志。原生适配层只保留 9 个受限 B 站接口及必要辅助函数；凭据使用请求级 ContextVar，finally 清理。`python/bridge.py` 通过私有 stdio 协议调用，昔涟统一负责人格、模型、任务、配置、密钥、数据库和对外发送规则。

本插件原生代码按主项目 LICENSE 发布；第三方部分仍遵循各自许可。
