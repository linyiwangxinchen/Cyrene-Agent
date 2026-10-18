# 贡献者

感谢所有通过 GitHub 为Cyrene做出贡献的开发者！

## 代码贡献

列表按**首次可追溯贡献被项目采纳或合入的时间**排序，不按 PR 编号或提交编写时间排序，排名不区分贡献大小。已合并 PR、明确的整理合入记录及共同作者记录均可作为依据。

本次核对截至 2026-10-18，基于 master 提交 [`5c4230d`](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/5c4230d177bf9cc57fa7c24d7d8c5b6d8795e305)。仅关闭但未合并的 PR 不自动计入；共同开发及参考修法的贡献保留相应说明。

---

### lll69 ([lll69](https://github.com/lll69))
- 设置面板改进：`max_token` 开关、`thinkingOverride`、`uiThemeRadius`、GPU 渲染开关等。
- 超时配置体系：为 chat-loop、搜索等功能添加可配置超时，优化首轮响应。
- AnySearch 适配、设置缓存机制与 UI 优化，移除不必要的 API Key 校验。
- 以上经 fork 仓库的 `patch-0.9.0` 分支整理合入，未走 PR；可回溯至作者提交 [`4d07213`](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/4d0721360237860a3a93571d55440e111137905a) 与维护者的整理记录 [`aaaad7e`](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/aaaad7ec5eb273c0ee86f2d64baabf63730debe5)。

### Unknownuserfrommars ([Unknownuserfrommars](https://github.com/Unknownuserfrommars))
- 修复截图辅助进程先退出时主进程崩溃的问题（[#28](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/28)，cherry-pick 进 master）。
- Windows SMTC 控制 QQ 音乐、本地音乐文件夹导入与播放器入口（[#46](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/46)）；修复播放器未就绪时的拖动、多歌单滚动及拖拽区域问题（[#197](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/197)）。
- 修复切换设置时隐藏的桌宠自动出现，以及插件市场刷新未重新拉取列表的问题（[#86](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/86)、[#196](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/196)）。
- 数据目录迁移改为只执行一次，避免旧目录覆盖当前数据（[#195](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/195)）。
- 适配 Claude Haiku 5.5 与 Gemini 4 Argon 模型注册信息（[#183](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/183)、[#221](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/221)）。
- 浏览器地址栏输入省略协议时自动补全（[#213](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/213)）。

### Wang Xiaomei ([Asuna404-not-found](https://github.com/Asuna404-not-found))
- 修复构建编译过程中的 Bug（[#33](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/33)，维护者参考其修法自行合并）。

### Tobi1chi ([Tobi1chi](https://github.com/Tobi1chi))
- NapCat OneBot 频道适配器支持（[#40](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/40)）。

### boring9720 ([boring9720](https://github.com/boring9720))
- 主进程日志落盘至 `userData/logs/cyrene.log`，支持滚动 3 份 × 5 MB，方便打包版用户附日志反馈问题（[#47](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/47)）。
- 补充真实 logger → sink 链路的日志轮转、滚动上限回归测试，并整理测试标准输出（[#49](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/49)）。

### 梨衣、 ([liyi3068238601-oss](https://github.com/liyi3068238601-oss))
- 运行时插件系统 v1：清单校验、生命周期状态机、资源所有权隔离与串行队列。
- 插件 ZIP 安全导入与原子安装：staging 隔离解压、路径穿越 / ZIP 炸弹防护、失败自动回滚。
- 用户插件安全卸载、插件设置页与启停管理。
- 以上由 [#42](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/42)、[#48](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/48) 推进，最终随 [#48](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/48) 合入；[合并记录](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/c21236bad172ca3337fb264aab809d0df026ade6)明确包含 #42 的全部内容。

### LZhWi ([LZhWi](https://github.com/LZhWi))
- 插件上下文取消信号与托管清理机制：`onDispose` 逆序清理、AbortSignal 与超时防护；命名空间事件总线的防伪造、监听器超时及自动退订（[#52](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/52)、[#53](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/53)）。
- 插件动态提示词 Provider 的模式过滤与配额限制，以及仅含元数据的 `host:turn:completed` 宿主事件，统一桌面与外部渠道的完成事件契约（[#55](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/55)、[#56](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/56)）。
- 待蒸馏缓存的来源校验与 SQLite 持久化；后台 Shell 任务元数据持久化及重启后的查询恢复（[#192](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/192)、[#193](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/193)）。
- 修复图片、图表和工作区弹窗被原生网页遮挡，以及 SVG 预览关闭后的焦点恢复（[#201](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/201)、[#204](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/204)、[#211](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/211)）。
- 改善问答输入框的回车翻页 / 提交，拒绝过期的末轮回退并刷新权威会话状态（[#202](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/202)、[#219](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/219)）。
- 修复原子替换重试、朋友圈队列失败恢复、迁移失败时的启动保护，以及 Git 监视和 Windows refs 元数据事件过滤；补充相关测试与 CI 维护（[#200](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/200)、[#203](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/203)、[#206](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/206)、[#207](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/207)）。
- 修复网易云歌单分页加载、失败重试与大列表渲染，以及实际播放曲目、元数据和下载缓存标识的一致性（[#225](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/225)、[#227](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/227)）。

### lucifergzsz414 ([lucifergzsz414](https://github.com/lucifergzsz414))
- 外部聊天渠道可绑定桌面对话并共享文字上下文，支持消息双向镜像写入与绑定关系持久化（[#62](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/62)）。
- 绑定渠道消息以桌面聊天气泡展示，保留发送者和隐藏模型上下文，保护渠道镜像的末轮编辑 / 重新生成边界（[#68](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/68)）。
- 统一会话顶部的渠道来源提示，优化私聊 / 群聊发送者展示，并同步内置表情（[#69](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/69)）。

### Modusensus ([modusensus](https://github.com/modusensus))
- 修复厂商与模型家族错配时思考控制失效：托管端点按模型名跨家族找回推理规则，解决下拉禁用与请求缺字段的问题（[#67](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/67)）。
- 修复推理面板 Segmented 滑块在 antd v6 下白块盖字的问题（[#67](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/67)）。
- 动态发帖接入插件提示词 Provider，新增 `moments-post` 场景与显式 `sources` opt-in，同时保持旧插件调用范围不变（[#75](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/75)）。

### yuxingyuzhong ([yuxingyuzhong](https://github.com/yuxingyuzhong))
- 自动语音早播文本切分设置：支持按句、按段或关闭切分后整段朗读，完善设置持久化、模式 UI、短回复朗读及相关回归测试（[#65](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/65)；作者提交 [`4e11ef0`](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/4e11ef08484f8e704c83d67c472b3350e0f334fe)、[`95ebb0a`](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/95ebb0ad917ec45584269b9a6f7717c88b0d48f8)）。

### proobker ([proobker](https://github.com/proobker))
- 注册英文语言并补齐聊天窗口英文翻译，覆盖通用操作、输入框及聊天 / 面板命名空间，保留插值变量并统一提示文案（[#83](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/83)、[#89](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/89)）。

### ahwhshen ([ahwhshen](https://github.com/ahwhshen))
- 作为共同作者参与应用内更新入口调整与差分更新支持：将更新入口迁至设置页和头像菜单，完善检查 / 下载 / 安装状态及 blockmap 产物校验（[`e2d8696`](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/e2d86969d32fa24378311df1f85e2650906a4c39)、[`205d923`](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/205d923100d836000db611b560031a48a6ffa4eb) 的 `Co-authored-by` 记录）。
- 修复插件设置面板被 CSP 拦截而空白的问题，为 `frame-src` 补充 `cyrene-plugin:` 协议（[#131](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/131)）。

### 1971687396 ([1971687396](https://github.com/1971687396))
- 参与跨协议对话历史互通的问题反馈与联合排查，并作为共同作者参与统一模型执行与兼容修复（[Issue #167](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/167)、提交 [`bcedee2`](https://github.com/Playa-Cyrene/Cyrene-Agent/commit/bcedee274f73ce2d0f63b5f56d952087b73e2b9d) 的 `Co-authored-by` 记录）。

### ActorF ([ActorF](https://github.com/ActorF))
- 问答卡增加“暂不回答”入口、中英日文案和推荐选项提示，补充交互及提交链路测试（[#208](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/208)）。
- 修复已打开 Markdown 预览时的行号跳转与重复定位（[#217](https://github.com/Playa-Cyrene/Cyrene-Agent/pull/217)）。

## Issue 贡献

列表按各作者**首次提交 Issue 的时间**排序，仅记录用户名与对应 Issue 链接，不展开具体问题内容。GitHub 上共 104 条 Issue（含已关闭与仍开启），其中维护者本人提交的 6 条不计入；部分作者同时有代码贡献，已在上文「代码贡献」中列出。本次核对截至 2026-10-18，共 41 位外部反馈者。

- [@genghaosan](https://github.com/genghaosan)：[#1](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/1) [#2](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/2) [#4](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/4)
- [@yaxuan97](https://github.com/yaxuan97)：[#3](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/3) [#41](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/41) [#70](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/70)
- 高远（[@GaoYuan522](https://github.com/GaoYuan522)）：[#6](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/6) [#11](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/11) [#18](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/18) [#20](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/20) [#21](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/21)
- GimmeX（[@GimmeCyy](https://github.com/GimmeCyy)）：[#8](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/8)
- 没雷石东呢（[@MainRedstoner](https://github.com/MainRedstoner)）：[#9](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/9) [#12](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/12)
- [@Coriodu](https://github.com/Coriodu)：[#15](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/15) [#16](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/16)
- Gali_bailan（[@badtoliethalo](https://github.com/badtoliethalo)）：[#22](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/22)
- [@System1145141](https://github.com/System1145141)：[#19](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/19)
- Firefly♡Trailblazer（[@RickyYang0325](https://github.com/RickyYang0325)）：[#17](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/17)
- [@bephbin35](https://github.com/bephbin35)：[#23](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/23)
- Tianzzi（[@Unknownuserfrommars](https://github.com/Unknownuserfrommars)）：[#25](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/25) [#27](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/27) [#85](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/85) [#92](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/92) [#94](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/94) [#186](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/186) [#209](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/209) [#212](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/212)
- 雨行雨中（[@yuxingyuzhong](https://github.com/yuxingyuzhong)）：[#29](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/29) [#30](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/30) [#78](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/78)
- [@ZMKFZJ](https://github.com/ZMKFZJ)：[#34](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/34)
- [@harunaahmadwada-sudo](https://github.com/harunaahmadwada-sudo)：[#35](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/35)
- [@Tobi1chi](https://github.com/Tobi1chi)：[#39](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/39)
- Zehao Liang（[@LZhWi](https://github.com/LZhWi)）：[#58](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/58) [#191](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/191) [#199](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/199) [#215](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/215) [#218](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/218) [#222](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/222) [#226](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/226)
- 梨衣、（[@liyi3068238601-oss](https://github.com/liyi3068238601-oss)）：[#60](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/60) [#96](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/96) [#97](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/97)
- [@lucifergzsz414](https://github.com/lucifergzsz414)：[#61](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/61)
- [@Lambunge520](https://github.com/Lambunge520)：[#63](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/63) [#66](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/66) [#71](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/71) [#77](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/77) [#80](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/80) [#81](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/81) [#90](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/90)
- [@modusensus](https://github.com/modusensus)：[#72](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/72)
- wuuuuu（[@lang338](https://github.com/lang338)）：[#82](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/82) [#88](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/88) [#101](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/101) [#184](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/184)
- Fid落花（[@Fid-falling](https://github.com/Fid-falling)）：[#87](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/87)
- [@ahwhshen](https://github.com/ahwhshen)：[#98](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/98) [#118](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/118) [#153](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/153) [#169](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/169) [#177](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/177) [#181](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/181)
- [@Downfallofthedownfall](https://github.com/Downfallofthedownfall)：[#134](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/134)
- Liu Zhixing（[@samas3](https://github.com/samas3)）：[#135](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/135)
- 雩风（[@shenDyufeng](https://github.com/shenDyufeng)）：[#136](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/136)
- 被win11吃掉的磁贴（[@citie114514](https://github.com/citie114514)）：[#146](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/146) [#147](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/147) [#148](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/148) [#149](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/149) [#150](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/150) [#151](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/151)
- [@Cyrene-xl](https://github.com/Cyrene-xl)：[#137](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/137)
- [@1971687396](https://github.com/1971687396)：[#157](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/157) [#158](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/158) [#159](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/159) [#160](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/160) [#161](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/161) [#162](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/162) [#163](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/163) [#167](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/167)
- Starripple（[@starripple-lian](https://github.com/starripple-lian)）：[#154](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/154) [#164](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/164) [#165](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/165)
- [@ttttxzzzz](https://github.com/ttttxzzzz)：[#166](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/166)
- Jeffery Cai（[@superme535](https://github.com/superme535)）：[#172](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/172)
- tiansy（[@scclovez](https://github.com/scclovez)）：[#171](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/171)
- [@cjw-1007](https://github.com/cjw-1007)：[#175](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/175)
- Tianming Bi（[@TianmingBi](https://github.com/TianmingBi)）：[#173](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/173)
- done（[@berhbro](https://github.com/berhbro)）：[#180](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/180)
- 忆过往昔不得（[@Elysia0927](https://github.com/Elysia0927)）：[#182](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/182)
- [@a8068578-boop](https://github.com/a8068578-boop)：[#185](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/185)
- [@xiaolin-create](https://github.com/xiaolin-create)：[#187](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/187)
- [@GameLef](https://github.com/GameLef)：[#190](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/190)
- Ying Fang（[@ActorF](https://github.com/ActorF)）：[#194](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/194) [#216](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/216) [#223](https://github.com/Playa-Cyrene/Cyrene-Agent/issues/223)

## 插件仓库贡献

列表按各作者**首次合入 PR 的时间**排序，仅记录用户名与对应 PR 链接，不展开具体内容。仅统计已合入的 PR，关闭未合入与仍开启的 PR 不计入；维护者本人提交的记录不计入。本次核对截至 2026-10-18，范围为 [Cyrene-Plugins](https://github.com/Playa-Cyrene/Cyrene-Plugins)，共 21 个已合入 PR，其中外部贡献 20 个，来自 8 位作者。

- [@1971687396](https://github.com/1971687396)：[#4](https://github.com/Playa-Cyrene/Cyrene-Plugins/pull/4) [#5](https://github.com/Playa-Cyrene/Cyrene-Plugins/pull/5) [#7](https://github.com/Playa-Cyrene/Cyrene-Plugins/pull/7) [#14](https://github.com/Playa-Cyrene/Cyrene-Plugins/pull/14) [#15](https://github.com/Playa-Cyrene/Cyrene-Plugins/pull/15)
- [@Downfallofthedownfall](https://github.com/Downfallofthedownfall)：[#3](https://github.com/Playa-Cyrene/Cyrene-Plugins/pull/3) [#10](https://github.com/Playa-Cyrene/Cyrene-Plugins/pull/10)
- [@modusensus](https://github.com/modusensus)：[#6](https://github.com/Playa-Cyrene/Cyrene-Plugins/pull/6)
- chuxuan（[@boring9720](https://github.com/boring9720)）：[#2](https://github.com/Playa-Cyrene/Cyrene-Plugins/pull/2) [#8](https://github.com/Playa-Cyrene/Cyrene-Plugins/pull/8)
- Tianzzi（[@Unknownuserfrommars](https://github.com/Unknownuserfrommars)）：[#9](https://github.com/Playa-Cyrene/Cyrene-Plugins/pull/9) [#11](https://github.com/Playa-Cyrene/Cyrene-Plugins/pull/11) [#22](https://github.com/Playa-Cyrene/Cyrene-Plugins/pull/22)
- [@ahwhshen](https://github.com/ahwhshen)：[#12](https://github.com/Playa-Cyrene/Cyrene-Plugins/pull/12) [#13](https://github.com/Playa-Cyrene/Cyrene-Plugins/pull/13) [#23](https://github.com/Playa-Cyrene/Cyrene-Plugins/pull/23) [#24](https://github.com/Playa-Cyrene/Cyrene-Plugins/pull/24)
- 被win11吃掉的磁贴（[@citie114514](https://github.com/citie114514)）：[#19](https://github.com/Playa-Cyrene/Cyrene-Plugins/pull/19) [#20](https://github.com/Playa-Cyrene/Cyrene-Plugins/pull/20)
- Zehao Liang（[@LZhWi](https://github.com/LZhWi)）：[#25](https://github.com/Playa-Cyrene/Cyrene-Plugins/pull/25)

---

## 特别鸣谢

- [是依七哒](https://space.bilibili.com/457683484)— 制作并分享 Live2D 模型相关资源，为桌宠展示提供了重要参考与支持。

---

*本列表按可追溯记录整理，贡献摘要不代表相关功能全部由单人独立完成。社区贡献持续增长，如有遗漏或归属需要补充，欢迎提供对应 PR、提交或采纳记录。*
