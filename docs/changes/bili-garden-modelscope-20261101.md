# 小花园改用魔搭下载 Whisper 模型（2026-11-01）

## 改动

原流程 `WhisperModel("small")` 会访问 Hugging Face 下载权重。用户服务器连接被重置，最终抛出 LocalEntryNotFoundError；pip 软件源切换不能改变这一模型下载地址。

新增 `python/asr_model.py`，通过官方 ModelScope SDK 下载指定 CTranslate2 仓库的权重、配置、分词器及词表。只取所需文件，不下载或执行仓库代码。四档仓库已通过 ModelScope API 核对文件列表及校验信息：

| 配置 | 魔搭仓库 | 权重文件大小 |
| --- | --- | --- |
| tiny | pengzhendong/faster-whisper-tiny | 75.5 MB |
| base | pengzhendong/faster-whisper-base | 145.2 MB |
| small | pengzhendong/faster-whisper-small | 483.5 MB |
| medium | pengzhendong/faster-whisper-medium | 1527.9 MB |

来源：[魔搭模型下载说明](https://modelscope.cn/docs/models/download)、[tiny 模型仓库](https://modelscope.cn/models/pengzhendong/faster-whisper-tiny)。

文件保存在插件自己的 `model-cache/modelscope/`。安装阶段实际离线加载成功后才写入 `asr-ready.json`，记录 `source: modelscope`；正式转写使用同一个本地目录加载器，并设置 `HF_HUB_OFFLINE=1` 和 `TRANSFORMERS_OFFLINE=1`。缺少文件会提示重新安装，不会转去联网补取分词器。旧版完整的本地 Hugging Face 缓存通过读取本地 ref/snapshot 继续复用，不调用 Hub API。

同时修复实测发现的 PyAV 19 兼容问题：它移除了当前 faster-whisper 1.2.x 调用的 `av.open(metadata_errors=...)` 参数，安装阶段约束 `av>=12,<19`，修正已安装的不兼容版本。新增界面来源说明、模型文件完整性/离线加载/旧缓存兼容测试，以及真正封禁网络的识别验收脚本。

## 验收

- 28 项 Node 插件测试通过；6 项 Python 模型边界测试通过，涵盖四档仓库映射、缺文件、下载失败、离线加载和旧缓存。
- Ubuntu Python 3.12：在隔离临时目录完成依赖安装、魔搭 tiny 下载、CPU/int8 加载；封禁网络连接后正确识别 3.55 秒测试语音 “Hello, this is a speech recognition test.”。
- Windows 官方 CPython 3.11：在独立虚拟环境完成安装/就绪检查，使用相同魔搭权重，在封禁网络的条件下正确识别同一测试句。旧 Conda 3.11.7 环境的原生库加载异常另行记录，未掩盖成下载成功；推荐官方 CPython。
- Main/Server 构建、实际 ZIP 导入、无桌面 Agent 和认证 Web/手机面板回归通过；Python B 站后端原有 6 项测试继续通过。
- 本轮未下载全部四档大模型，四档文件映射已核对，真实下载/识别以 tiny 为验收模型。

生产服务仍由用户按既有更新流程拉取、构建并重启，然后在小花园设置点击“安装转写环境与模型”。无需配置 Hugging Face token；已有 Python 依赖与下载缓存会被复用。
