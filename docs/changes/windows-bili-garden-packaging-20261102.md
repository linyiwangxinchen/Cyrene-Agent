# Windows 安装包中的小花园修复

## 问题与修改

- `electron-builder.yml`：将小花园的 Python 脚本解包到 `app.asar.unpacked`，使外部 Python 解释器能够读取这些文件。
- `extensions/bili-garden/lib/python.mjs`：在打包环境下定位解包后的脚本；脚本缺失时给出明确的安装错误。源码和 Linux 运行时仍使用原有路径。
- `extensions/bili-garden/index.mjs`：清理回调持有对应的服务实例，避免卸载后宿主再次清理时访问空对象。
- `extensions/bili-garden/test/python-install.test.mjs` 和 `scripts/packaging/electron-builder-config.test.mjs`：覆盖脚本解包与路径选择。
- `extensions/bili-garden/test/lifecycle.test.mjs`：覆盖卸载后执行宿主清理的顺序。

## 验证与交付范围

- 已构建 Windows x64 1.3.5 安装包；安装包未签名，安装时 Windows 可能提示发布者未知。
- 小花园与打包配置的 43 项针对性测试通过。对打包应用执行了 25 项隔离运行检查，包含设置页滚动、重启后会话持久化和小花园 Python 运行；另完成 33 项包内容及更新元数据检查。
- 未在当前用户配置中实际执行 NSIS 安装与卸载，也未使用真实微信、B 站账号或模型服务验收。
- 应用版本仍为 1.3.5。已安装旧版 1.3.5 的用户需要手动下载安装新包，同版本不会触发常规自动更新。
- 安装包 SHA-256：`F3E7B95397F5491DB1223D000A531B7D801FE6DAE35FA9F01B9847A829E2EE92`。
