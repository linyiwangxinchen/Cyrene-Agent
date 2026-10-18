# 更新日志

Cyrene-Agent 的版本变更记录。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
提交信息遵循 `type(scope): 描述`，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

> 本文件由 `pnpm run release` 生成，请勿手工编辑；需要调整措辞请改写对应的提交信息。

## [1.3.4](https://github.com/Playa-Cyrene/Cyrene-Agent/compare/v1.3.3...v1.3.4) (2026-10-18)

### 新增

* **工具:** 移除模型控制 Live2D 的能力 ([5f95ec3](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/5f95ec357c71772ac98f696f47c59aa384b120ae))
* **模型:** 适配 Gemini 4 Argon ([3099bff](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/3099bff3e89b0a4ed1eceba0869b0e174dbed1b1))
* **chat:** 添加暂不回答入口与推荐选项提示 ([336eb59](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/336eb5983b3f71142247d177c6509a73d1c13cf2))

### 修复

* **插件面板:** 市场视图里点刷新重新拉取市场列表 ([7414786](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/7414786b9a742a5c77d2cb189a90b32c4edeb56b))
* **代码工作区:** 过滤 Windows refs 根目录元数据事件 ([a8b36fd](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/a8b36fdbd1939264fd6a26961254a8b177b92cfc))
* **动态:** 放行 CSP 中动态配图与贴图的本地协议加载 ([147909f](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/147909f937df9d063f764b9545ed6470bf1a436a))
* **对话轨迹:** 结束回退恢复失败的加载状态 ([52e7b88](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/52e7b88f2eb4262845197792c172741e731e7e53))
* **对话轨迹:** 拒绝过期末轮回退并刷新会话 ([cb17433](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/cb17433398bbd2be6d17ed93f49fdb94642d0da3))
* **对话轨迹:** 完善过期回退的并发恢复 ([6a81969](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/6a8196945f274a6eb4f1c81d0e6edef14e6aef6a))
* **工作区:** 修复 Git 监视防抖重复通知 ([07072f1](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/07072f1239df4a18609aa1fe4c9cfafa38677be9))
* **工作区预览:** 按打开代际拒绝旧关闭回调 ([0975969](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/09759690403aef6c9c8bedf211934a7a450bea2d))
* **工作区预览:** 在 SVG 关闭完成后恢复焦点 ([ce80d8e](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/ce80d8e605081adb7cfe8829fb9287d5cb222653))
* **会话存储:** 重试短暂占用导致的原子替换失败 ([f90396f](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/f90396f1fce631047432f698118b596e6cea1d52))
* **聊天:** 清理会话切换后的 Git 弹窗 ([4454531](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/4454531626d3c5ccba12d88bdd864d69f53a9ec9)), references [#190](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/190)
* **聊天:** 修复图片和图表预览被网页遮挡 ([863c204](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/863c204b1b8709950fb8c447db7ed98816c35c78)), references [#190](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/190)
* **聊天:** 支持问答输入框回车翻页和提交 ([0efadc6](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/0efadc68d19bcbdf065d8327b4fd2e4219395f52))
* **浏览器:** 避让工作区内的可见弹窗 ([bee8434](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/bee84348857f486133e37869a686bb5f4ce546d3)), references [#190](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/190)
* **浏览器:** 单独的 home.arpa 与 .arpa 基础设施域不再补 https ([7aaca8f](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/7aaca8ff8bb58de31e4906ebec6f2d3952649111))
* **浏览器:** 单段主机名不再补全，保留后缀需前置名称 ([e7434fa](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/e7434faa1b9a28b2848dfc5097900e36721c153b))
* **浏览器:** 地址补全改为按解析器规范化后的主机分类 ([51e3808](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/51e380856d20a521d158a2b2ce55c2e19ca048bd))
* **浏览器:** 地址补全识别反斜杠路径与全角数字 ([7c39cc1](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/7c39cc12dc1a5cdebd3248d5ab157393b0cac495))
* **浏览器:** 地址补全只在主机部分拒绝空白 ([89562fe](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/89562fe15e1575a588f33a51fb36ed6a7ce11a68))
* **浏览器:** 地址栏输入省略协议时自动补全 ([3f8d530](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/3f8d530ffedf81bb6148f81fd17f84233d5a8d0d))
* **浏览器:** 地址栏提示文案不再要求输入完整 HTTP(S) 地址 ([9eb03ae](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/9eb03aeca6583b451c3663e68573d55d484bb2a0))
* **浏览器:** 内网保留域名与 CGNAT 补 http，单段主机名带端口可补全 ([bdf7b6f](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/bdf7b6ff809053c25e38eedf4fb168daa3bbc01d))
* **浏览器:** 排除非模态角色卡的网页避让 ([bf2960e](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/bf2960e9873e66a6ca0b642d70f7b19fd54eefc1))
* **浏览器:** 主机部分带 @ 时不补全，覆盖空用户信息 ([665066a](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/665066aa7b8f9b60cf4bc958994bbeac198f4e33))
* **朋友圈:** 保留落盘失败的队列任务以供重试 ([8a36444](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/8a36444334e669e14a7b979f4872677c961b567d))
* **朋友圈:** 保留删除失败任务的完成状态 ([63dcfdf](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/63dcfdf78e2430013d224396b70ea326f1218313))
* **数据迁移:** 迁移只执行一次，避免旧版重建的旧目录覆盖当前数据 ([0afb22d](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/0afb22d6047da0c048cb2c32fc1b22bc865d0328))
* **数据迁移:** 阻止迁移失败后使用不完整目录启动 ([e6289fb](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/e6289fb9d98e44daa0ec65b29f494885540f0d12))
* **贴纸:** 模型侧改用自然语言描述，避免表情包阻塞模型调用 ([a4bd441](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/a4bd4419bf298e412bd2479c5f7bfa1a3066de00))
* **文件预览:** 修复已打开 Markdown 的行号跳转 ([18ffdbb](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/18ffdbb4fe0fde1ab623c36fc984161555787314))
* **音乐:** 避免缺失歌曲标识时误判重复页 ([0c0fd55](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/0c0fd557743bf508e489420a628df2292e39154b))
* **音乐:** 补齐完整歌单的交互边界 ([eb9e292](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/eb9e2929d377e00a7192ee0d36fdf414ba8c3e98))
* **音乐:** 修复网易云歌单分页加载不完整 ([1dcde85](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/1dcde85fb4ed2325ee4284a5f78b8aa6a2766647))
* **音乐:** 修正歌单播放曲目与缓存标识错配 ([2b2b952](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/2b2b9521bfb3ea1525c9521ce35fe432516994c2))
* **音乐:** 优先显示主动播放操作的错误 ([037aa10](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/037aa10bb572be6ac0d54819e75cf50a9fb44a1e))
* **桌宠:** 修正 Live2D 动作资源解析 ([45ab1e9](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/45ab1e9e187891b1da0d1f01dd665db5d2b399fb)), references [#199](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/199)
* **chat:** 本地化暂不回答的提交内容 ([9460cd2](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/9460cd2c689aca488364061409768322542a3d7c))
* **chat:** 完善推荐选项的提示说明 ([72ad53b](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/72ad53b846e9346b1c03fe205d64beb4a296f329))
* **memory:** preserve run ownership across user adjustments ([538a5b4](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/538a5b4005b46baa8e445830f311e297335cc9f7))
* **memory:** synchronize pending turns with canonical transcript sources ([7dd2958](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/7dd2958367e8bf9c8f3ee6133f5820046c04c49f))
* **music:** 未就绪界面可拖动，歌单多时保留拖拽区并可滚动 ([6f7125d](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/6f7125d839a7c581fa38d7755f20b3f12c197cc3))
* **qq:** 解除 loopback/custom 地址解析对网卡枚举的依赖 ([f28874b](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/f28874b5cbd3ba06ddaebeaac7678c839edb8bf3))
* **shell:** drain historical initialization before shutdown ([e9b9e73](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/e9b9e73e9f599e0c67df3abab68a5030c8efa092))
* **shell:** persist background job metadata in SQLite ([1292f02](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/1292f0245ced6c25e31a41692ee800e6cf2ccd79))

### 重构

* **chat:** 精简 ask_user 工具描述 ([a217141](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/a2171418a8b26fa05bfd9a834632fb949f0b3433))
