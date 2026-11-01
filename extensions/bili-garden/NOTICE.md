# 来源与许可

本插件为 Cyrene 原生实现；产品功能参考 YOYOLnFu/dsh-bili-pond 1.3.14，源码基线 `57765435e33a8697c7f3b3b9f317c6146cd05faa`。

`vendor/bilibili-mcp/mcp_server.py` 来自该项目内嵌的 AGI_Ananas/bilibili-mcp，并包含其后续修改，以 MIT 许可使用。原许可保留在同目录 LICENSE。鱼塘的 MIT 和衍生项目版权说明保留于 vendor/DSH-LICENSE 与 vendor/DSH-NOTICE.md。

本插件不使用 DSH runtime、配置树或页面加载器。`python/bridge.py` 限制可以调用的操作，使用 stdin 传递内存凭据；host 层统一验证对外目标、证据、额度和发送状态。上游源码的开放工具注册不会直接暴露给 Cyrene 模型。

内嵌 Python 文件仅清理了空行上的尾随空格；行为适配放在独立 bridge 中。

本插件原生代码按主项目 LICENSE 发布；第三方部分仍遵循各自许可。
