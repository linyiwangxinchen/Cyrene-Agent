# 小花园大文件下载恢复（2026-11-01）

## 触发和修复

Linux Python 3.12 安装时已找到 `av-19.0.2-cp312-abi3-manylinux_2_28_x86_64.whl`，但下载 35 MB 文件时，`files.pythonhosted.org` 触发 `ReadTimeoutError`。这是下载阶段的网络故障。上一版读取超时只有 25 秒；官方源本身失败时已无后继源，旧版 pip 也不会自动恢复中断的大文件。

- 读取超时提高到 120 秒，连接重试 3 次。每个源设 15 分钟上限，保留用户取消/停用能力。
- 在插件虚拟环境内检查 pip；低于 25.2 时升级到 `pip>=25.2,<27`。升级成功后才启用 `--resume-retries 5`，不把新参数传给旧 pip，也不升级系统 pip。
- 官方源下载超时或不完整时可回退到阿里云 HTTPS 镜像；显式镜像仍优先，每个源至多尝试一轮。后续安装阶段沿用成功源，避免再次从不通的源下载。
- 使用插件目录内的 `pip-cache/` 复用完整下载。中断部分的续传限于同一条 pip 命令，跨源、跨进程不承诺恢复部分进度。
- 安装失败、取消、权限和磁盘错误仍不会伪报成功；没有禁用 TLS 或散列校验。

## 验收

27 项 Node 插件测试通过，包含官方 CDN 超时回退、成功源复用、旧 pip 升级顺序和升级失败边界。Main/Server 构建与实际宿主 ZIP 导入通过。

真实 Ubuntu / Python 3.12.3 x86_64 临时环境通过阿里云镜像安装并导入 faster-whisper 1.2.1、CTranslate2 4.8.4、PyAV 19.0.2、yt-dlp 2026.10.26；包含用户日志中相同的 35 MB PyAV wheel。pip 自动升级到 26.2.2，pip check 无冲突。只写入测试临时目录，验收后已清理，没有改动正式服务。

真实下载恢复测试在 Windows 和 Ubuntu 均通过：测试服务在 131072 字节处截断带 SHA256 的 1050971 字节 wheel，pip 实际发出 `Range: bytes=131072-` 请求并完成安装与内容检查。此测试已加入 Linux CI 流程，本次结果为本地和 SSH 执行验证，未声称远端 CI 已运行。

本次软件包安装验证不包含 Whisper 模型权重下载或音频识别。模型下载仍是后续独立阶段。

## 已部署服务的临时修复

如果暂不更新宿主，先确保页面安装任务已结束，再用运行昔涟的同一账号执行下列命令。自定义数据目录的服务需要让 `CYRENE_DATA_DIR` 与服务配置一致；默认部署无需填写路径。命令只升级插件虚拟环境的 pip 和转写依赖，不改系统 Python，也不写转写就绪标记。执行后回页面点击“安装转写环境与模型”，继续下载并验证所选模型。

```bash
(
  set -eu
  CYRENE_BILI_DIR="${CYRENE_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/cyrene-agent}/plugin-data/bili-garden"
  CYRENE_BILI_PY="$CYRENE_BILI_DIR/.venv/bin/python"
  test -x "$CYRENE_BILI_PY" || { echo "未找到插件 Python，请检查数据目录" >&2; exit 1; }
  export PIP_CONFIG_FILE=/dev/null
  "$CYRENE_BILI_PY" -m pip --isolated install --upgrade 'pip>=25.2,<27' \
    --index-url https://mirrors.aliyun.com/pypi/simple/ --timeout 120 --retries 3 \
    --cache-dir "$CYRENE_BILI_DIR/pip-cache"
  "$CYRENE_BILI_PY" -m pip --isolated install 'faster-whisper>=1.2.1,<2' yt-dlp \
    --only-binary=ctranslate2,av,onnxruntime,tokenizers \
    --index-url https://mirrors.aliyun.com/pypi/simple/ --timeout 120 --retries 3 \
    --resume-retries 5 --cache-dir "$CYRENE_BILI_DIR/pip-cache"
  "$CYRENE_BILI_PY" -c 'import faster_whisper, ctranslate2, av, yt_dlp; print("转写依赖检查通过")'
)
```
