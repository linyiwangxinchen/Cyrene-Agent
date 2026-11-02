/* Native panel, no external scripts, HTML injection or desktop APIs. */
(() => {
  const $ = (id) => document.getElementById(id),
    state = { tab: "discover", data: null, dirty: false, busy: false, queueDraft: "" };
  let pageSignature = "", statusSignature = "", queueView = null;
  const videoView = (v) => [v.bvid, v.cover, v.title, v.owner, v.duration, v.summary,
    v.reason, v.queueStatus, v.available, v.picked, v.feedback];
  const tabs = [
    ["discover", "发现"],
    ["queue", "一起看"],
    ["notes", "手记"],
    ["actions", "互动"],
    ["settings", "设置"],
  ];
  const replace = (element, ...children) =>
    element.replaceChildren(
      ...children.flat().filter((child) => child != null),
    );
  const labels = {
    running: "进行中",
    success: "已完成",
    failed: "未完成",
    cancelled: "已取消",
    interrupted: "已中断",
    draft: "草稿",
    sending: "发送中",
    sent: "已发送",
    uncertain: "结果不明",
  };
  const invoke = (command, args = {}) =>
    window.CyrenePanel.invoke("garden", command, args);
  const h = (tag, props = {}, ...children) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") e.className = v;
      else if (k.startsWith("on"))
        e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "text") e.textContent = v;
      else if (k in e) e[k] = v;
      else e.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c !== undefined && c !== null)
        e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return e;
  };
  const button = (label, fn, kind = "") =>
    h("button", { type: "button", class: kind, onClick: fn }, label);
  const notice = (text, error = false) => {
    $("notice").textContent = text;
    $("notice").className = error ? "error" : "";
  };
  async function action(command, args = {}, message = "已完成") {
    try {
      const r = await invoke(command, args);
      notice(["guard", "guard-retry"].includes(command) && r?.message ? r.message : message);
      await refresh(true);
      return r;
    } catch (e) {
      notice(e.message || String(e), true);
      throw e;
    }
  }
  const safely =
    (fn) =>
    async (...args) => {
      const target = args[0]?.currentTarget;
      const control =
        target instanceof HTMLButtonElement
          ? target
          : target instanceof HTMLFormElement
            ? target.querySelector('button[type="submit"]')
            : null;
      if (control) control.disabled = true;
      try {
        return await fn(...args);
      } catch (error) {
        notice(error.message || String(error), true);
      } finally {
        if (control)
          control.disabled =
            control.id === "run" &&
            Boolean(state.data?.run || state.data?.environment?.installing);
      }
    };
  function show(title, content) {
    $("detail-title").textContent = title;
    $("detail-body").replaceChildren(content);
    if (!$("detail").open) $("detail").showModal();
  }
  const empty = (text) => h("div", { class: "empty" }, text);
  const fmtTime = (n) => (n ? new Date(n).toLocaleString("zh-CN") : "");
  const link = (bvid, label = "去 B 站看", from = 0) =>
    h(
      "a",
      {
        href: `https://www.bilibili.com/video/${bvid}${from ? "?t=" + Math.floor(from) : ""}`,
        target: "_blank",
        rel: "noopener noreferrer",
      },
      label,
    );
  function cite(c) {
    return h(
      "div",
      { class: "quote" },
      c.text,
      " ",
      link(
        c.bvid || "",
        `${Math.floor(c.from / 60)}:${String(Math.floor(c.from % 60)).padStart(2, "0")}`,
        c.from,
      ),
    );
  }
  function reportExport(args) {
    return safely(async () => {
      const r = await invoke("export", args);
      const box = h(
        "div",
        {},
        h("textarea", {
          class: "export",
          readOnly: true,
          value: r.markdown,
          "aria-label": "Markdown 导出内容",
        }),
      );
      box.prepend(
        button("下载 Markdown", () => {
          const url = URL.createObjectURL(
            new Blob([r.markdown], { type: "text/markdown;charset=utf-8" }),
          );
          const a = h("a", { href: url, download: r.filename }, "下载");
          document.body.append(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 2000);
        }),
      );
      show("导出手记", box);
    });
  }
  function videoCard(v) {
    let cover;
    try {
      const u = new URL(v.cover);
      if (
        u.protocol === "https:" &&
        /(^|\.)hdslb\.com$|(^|\.)bilibili\.com$/.test(u.hostname)
      )
        cover = h("img", {
          class: "cover",
          src: u.href,
          alt: v.title || v.bvid,
          loading: "lazy",
          referrerPolicy: "no-referrer",
        });
    } catch {}
    cover ??= h(
      "div",
      { class: "cover cover-placeholder", "aria-hidden": "true" },
      "和昔涟一起看",
    );
    const body = h(
      "div",
      { class: "body" },
      h("h3", {}, v.title || v.bvid),
      h(
        "div",
        { class: "meta" },
        v.owner || "待读取",
        v.duration ? " · " + Math.ceil(v.duration / 60) + " 分钟" : "",
      ),
      v.summary ? h("p", {}, v.summary) : null,
      v.reason ? h("p", { class: "reason" }, v.reason) : null,
    );
    const buttons = h(
      "div",
      { class: "buttons" },
      link(v.bvid),
      button(
        v.queueStatus === "queued" ? "已在待看" : "稍后一起看",
        safely(() => action("queue", { bvid: v.bvid }, "已加入待看")),
      ),
      button(
        "读这条",
        safely(() => action("run", { bvid: v.bvid }, "正在阅读这条视频")),
      ),
    );
    if (v.available || v.picked) {
      buttons.append(
        button(
          "字幕与追问",
          safely(() => evidence(v)),
        ),
        button(
          v.feedback === "like" ? "喜欢 ✓" : "感兴趣",
          safely(() =>
            action(
              "feedback",
              { bvid: v.bvid, value: "like" },
              "已记住你的偏好",
            ),
          ),
        ),
        button(
          "不感兴趣",
          safely(() =>
            action(
              "feedback",
              { bvid: v.bvid, value: "dislike" },
              "以后会减少类似内容",
            ),
          ),
        ),
      );
    }
    if (state.tab === "queue")
      buttons.append(
        button(
          "标记已看",
          safely(() =>
            action("queue", { bvid: v.bvid, status: "watched" }, "已标记看过"),
          ),
        ),
        button(
          "移出待看",
          safely(() =>
            action("queue", { bvid: v.bvid, status: "removed" }, "已移出待看"),
          ),
        ),
      );
    body.append(buttons);
    return h("article", { class: "card" }, cover, body);
  }
  async function evidence(v) {
    const e = await invoke("evidence", { bvid: v.bvid });
    const q = h("textarea", {
      placeholder: "这段内容里，有什么想再问问昔涟的？",
      "aria-label": "视频问题",
    });
    const box = h(
      "div",
      {},
      h(
        "p",
        { class: "muted" },
        `来源：${e.source === "asr" ? "本地转写" : "字幕"} · ${e.segments.length} 个片段`,
      ),
      q,
      button(
        "问问昔涟",
        safely(async () => {
          await action(
            "question",
            { bvid: v.bvid, question: q.value },
            "昔涟正在结合字幕回答",
          );
          $("detail").close();
        }),
      ),
      h(
        "div",
        {},
        e.segments.slice(0, 250).map((s) => cite({ ...s, bvid: v.bvid })),
      ),
    );
    show(v.title || v.bvid, box);
  }
  function renderStatus() {
    const d = state.data;
    if (!d) return;
    $("garden").setAttribute("aria-busy", "false");
    const elapsed = d.run ? Math.floor((Date.now() - d.run.started) / 1000) : null;
    const signature = JSON.stringify([d.account, d.stats.picked, d.config.perDay,
      d.environment.installing, d.environment.installed, d.config.autoRun, d.run?.id, d.run?.phase, elapsed]);
    if (signature !== statusSignature) replace(
      $("status"),
      h(
        "span",
        {},
        "账号 ",
        h(
          "strong",
          {},
          d.account.loggedIn
            ? d.account.name || d.account.uid
            : d.account.error
              ? "待检查"
              : "未登录",
        ),
      ),
      h(
        "span",
        {},
        "今天收录 ",
        h("strong", {}, `${d.stats.picked} / ${d.config.perDay}`),
      ),
      h(
        "span",
        {},
        "环境 ",
        h(
          "strong",
          {},
          d.environment.installing
            ? "安装中"
            : d.environment.installed
              ? "已就绪"
              : "待安装",
        ),
      ),
      h(
        "span",
        {},
        "自动发现 ",
        h("strong", {}, d.config.autoRun ? "已开启" : "未开启"),
      ),
      d.run
        ? h(
            "div",
            { class: "progress" },
            "昔涟正在忙：",
            d.run.phase,
            " · ",
            elapsed,
            " 秒",
          )
        : null,
    );
    statusSignature = signature;
    $("run").disabled = Boolean(d.run || d.environment.installing);
    $("cancel").hidden = !d.run && !d.environment.installing;
    if ($("environment-log")) {
      const log = (d.environment.log || []).join("\n");
      if ($("environment-log").textContent !== log) $("environment-log").textContent = log;
      $("environment-log").hidden = !d.environment.log?.length;
    }
  }
  function renderTabs() {
    replace(
      $("tabs"),
      tabs.map(([id, label]) =>
        button(label, () => {
          if (id === state.tab) return;
          if (state.dirty) {
            notice("设置尚未保存，请先保存或放弃修改。", true);
            return;
          }
          state.dirty = false;
          state.tab = id;
          renderTabs();
          render();
        }),
      ),
    );
    [...$("tabs").children].forEach((e, i) => {
      if (tabs[i][0] === state.tab) e.setAttribute("aria-current", "page");
    });
  }
  function discover() {
    const d = state.data,
      box = h("div");
    box.append(
      h(
        "div",
        { class: "section-head" },
        h("h2", {}, "最近想和你分享的"),
        h(
          "div",
          { class: "buttons" },
          ...[10, 30, 60].map((n) =>
            button(
              `${n} 分钟精选`,
              safely(async () => {
                const r = await invoke("playlist", { minutes: n });
                show(
                  `${n} 分钟的小旅行`,
                  r.items.length
                    ? h("div", { class: "grid" }, r.items.map(videoCard))
                    : empty("暂时没有符合时长的已读视频。先让昔涟发现几条吧。"),
                );
              }),
            ),
          ),
        ),
      ),
    );
    const videos = d.videos.filter((v) => v.picked && v.feedback !== "dislike");
    box.append(
      videos.length
        ? h("div", { class: "grid" }, videos.map(videoCard))
        : empty(
            "花园还等着第一条发现。先在设置里准备环境和账号，再点“去发现视频”。",
          ),
    );
    if (d.questions.length)
      box.append(
        h("div", { class: "section-head" }, h("h2", {}, "聊过的片段")),
        ...d.questions.slice(0, 8).map((q) =>
          h(
            "article",
            { class: "entry" },
            h("h3", {}, q.question),
            h("p", {}, q.answer),
            q.citations.map((c) => cite({ ...c, bvid: q.bvid })),
          ),
        ),
      );
    return box;
  }
  function queue() {
    if (queueView?.box.isConnected) {
      updateQueue();
      return queueView.box;
    }
    const input = h("input", {
      placeholder: "BV 号或 B 站视频链接",
      "aria-label": "添加视频",
      value: state.queueDraft,
      onInput: (event) => { state.queueDraft = event.target.value; },
    });
    const box = h(
      "div",
      {},
      h("h2", {}, "稍后一起看"),
      h(
        "p",
        { class: "muted" },
        "这里的喜好和待看只记录在小花园里，不会直接操作 B 站账号。",
      ),
      h(
        "form",
        {
          class: "row",
          onSubmit: safely(async (e) => {
            e.preventDefault();
            const submitted = input.value;
            await action("queue", { bvid: submitted }, "已收进待看清单");
            // Keep a different link typed while this request was in flight.
            if (state.queueDraft === submitted) {
              state.queueDraft = "";
              if (queueView) queueView.input.value = "";
            }
          }),
        },
        input,
        h("button", { type: "submit", class: "primary" }, "加入待看"),
      ),
    );
    const list = h("div");
    queueView = { box, input, list, cards: new Map(), empty: empty("遇到想一起看的视频，把链接放在这里。") };
    box.append(list);
    updateQueue();
    return box;
  }
  function updateQueue() {
    const items = state.data.videos.filter(v => v.queueStatus === "queued");
    const cards = new Map();
    const nodes = items.map(v => {
      const signature = JSON.stringify(videoView(v));
      const previous = queueView.cards.get(v.bvid);
      const card = previous?.signature === signature ? previous : { signature, node: videoCard(v) };
      cards.set(v.bvid, card);
      return card.node;
    });
    if (!nodes.length) nodes.push(queueView.empty);
    queueView.list.className = items.length ? "grid" : "";
    // Reuse unchanged nodes, including covers; inserting another card never detaches the form.
    for (const child of [...queueView.list.children]) if (!nodes.includes(child)) child.remove();
    nodes.forEach((node, index) => {
      if (queueView.list.children[index] !== node) queueView.list.insertBefore(node, queueView.list.children[index] ?? null);
    });
    queueView.cards = cards;
  }
  function notes() {
    const d = state.data,
      box = h("div");
    box.append(
      h(
        "div",
        { class: "section-head" },
        h("h2", {}, "我们的发现手记"),
        h(
          "div",
          { class: "buttons" },
          button("一周发现", reportExport({ week: true })),
          button("导出全部", reportExport({})),
        ),
      ),
    );
    if (!d.reports.length)
      box.append(empty("读完一轮视频后，昔涟会在这里留下手记。"));
    for (const r of d.reports)
      box.append(
        h(
          "article",
          { class: "entry" },
          h(
            "div",
            { class: "chips" },
            h("span", { class: "chip" }, r.day),
            h("span", { class: "muted" }, `${r.items.length} 条视频`),
          ),
          h("p", {}, r.summary),
          r.diary ? h("p", {}, r.diary) : null,
          r.say ? h("div", { class: "quote" }, r.say) : null,
          button("导出当天", reportExport({ day: r.day })),
        ),
      );
    box.append(h("div", { class: "section-head" }, h("h2", {}, "记住的小事")));
    box.append(
      d.memories.length
        ? h(
            "div",
            {},
            d.memories.map((m) =>
              h(
                "div",
                { class: "entry" },
                h("p", {}, m.text),
                h("span", { class: "muted" }, m.day || ""),
                button(
                  "忘记这条",
                  safely(() =>
                    action("memory-delete", { id: m.id }, "已忘记这条小事"),
                  ),
                ),
              ),
            ),
          )
        : empty("有帮助的兴趣线索会留在这里，并进入下一轮选片。"),
    );
    return box;
  }
  function interactions() {
    const d = state.data,
      box = h(
        "div",
        {},
        h(
          "div",
          { class: "section-head" },
          h("h2", {}, "互动与回音"),
          button(
            "扫描 @ 与评论",
            safely(() => action("guard", {}, "评论扫描已完成")),
          ),
        ),
        h(
          "p",
          { class: "muted" },
          "开关在设置中。每一条是否发出，以平台回执为准；结果不明的动作不会自动重发。",
        ),
      );
    if (d.guard) {
      const scan = d.guard.lastScan;
      box.append(h("section", { class: "entry", "aria-label": "评论守护扫描状态" },
        h("strong", {}, "评论守护扫描状态"),
        h("p", {}, `${d.guard.message} · ${d.guard.autoSend ? "自动发送已开启" : "仅生成草稿，需确认发送"}`),
        d.guard.whitelistEmpty ? h("p", { class: "muted" }, "允许 @ 的用户 UID 为空，目前不会处理其他视频中的 @。") : null,
        scan ? h("p", { class: "muted" }, `最近扫描：${fmtTime(scan.at)}；读取 @ ${scan.receivedAt} 条，白名单通过 ${scan.allowedAt} 条，白名单外 ${scan.filteredAt} 条，新入队 ${scan.queued} 条。`) : h("p", { class: "muted" }, "尚无扫描记录。"),
        scan?.unsupported || scan?.invalid ? h("p", { class: "muted" }, `跳过 ${Number(scan.unsupported || 0) + Number(scan.invalid || 0)} 条非视频评论或无法定位的通知。`) : null,
        scan?.backlog ? h("p", { class: "muted" }, "还有历史 @ 待扫描，下轮继续；已入队的消息不会丢失。") : null,
        ...(scan?.errors ?? []).map(message => h("p", { class: "error" }, message)),
        d.guard.retryable ? h("div", { class: "buttons" },
          h("span", {}, `${d.guard.retryable} 条 @ 多次处理未成功，已暂停重试。`),
          button("重试未回复的 @", safely(() => action("guard-retry"))),
        ) : null,
      ));
    }
    if (d.cooldown?.until > Date.now())
      box.append(
        h("p", { class: "error" }, `互动冷却至 ${fmtTime(d.cooldown.until)}`),
      );
    if (!d.actions.length)
      box.append(empty("还没有互动。昔涟可以先留下草稿，等你看过再发。"));
    for (const a of d.actions) {
      const buttons = h("div", { class: "buttons" });
      if (a.status === "draft")
        buttons.append(
          button(
            "确认发送",
            safely(() => action("send", { id: a.id }, "已取得发送结果")),
            "primary",
          ),
          button(
            "放弃",
            safely(() => action("discard", { id: a.id }, "已放弃")),
          ),
        );
      if (a.status === "failed")
        buttons.append(
          button(
            "重新送审",
            safely(() => action("retry", { id: a.id }, "已放回草稿")),
          ),
        );
      if (a.status === "sent" && ["like", "fav"].includes(a.kind) && !a.undone)
        buttons.append(
          button(
            "撤销这次赞藏",
            safely(() => action("undo", { id: a.id }, "已撤销")),
          ),
        );
      if (a.status === "sent" && ["comment", "reply"].includes(a.kind))
        buttons.append(
          button(
            "查询评论",
            safely(() => action("verify", { id: a.id }, "已更新查询结果")),
          ),
        );
      box.append(
        h(
          "article",
          { class: "entry" },
          h(
            "div",
            { class: "chips" },
            h("span", { class: "chip" }, labels[a.status] || a.status),
            h(
              "strong",
              {},
              {
                comment: "评论",
                reply: "回复",
                dm: "私信",
                like: "点赞",
                fav: "收藏",
              }[a.kind],
            ),
            a.undone ? h("span", {}, "已撤销") : null,
          ),
          h(
            "div",
            { class: "meta" },
            fmtTime(a.created),
            a.bvid ? " · " + a.bvid : "",
            a.targetUid ? " · 接收 UID " + a.targetUid : "",
          ),
          h("p", {}, a.sentText || a.text || a.reason),
          a.text ? h("p", { class: "muted" }, a.reason) : null,
          a.error ? h("p", { class: "error" }, a.error) : null,
          a.visibility ? h("p", {}, a.visibility) : null,
          buttons,
        ),
      );
    }
    return box;
  }
  const fields = [
    [
      "口味与模型",
      [
        ["interests", "你关心什么", "textarea", "昔涟选片时会参考这些兴趣。"],
        ["exclusions", "暂时不想看什么", "textarea"],
        ["keywords", "搜索关键词", "textarea", "每行一个，最多 20 个。"],
        ["modelProfileId", "运行模型", "profiles"],
      ],
    ],
    [
      "自动运行与时间",
      [
        ["autoRun", "开启自动发现", "checkbox"],
        [
          "timezone",
          "时区",
          "text",
          "默认 Asia/Shanghai，与服务器系统时区无关。",
        ],
        ["runsPerDay", "每天最多运行几轮", "number"],
        ["gapMinutes", "两轮间隔（分钟）", "number"],
        ["perRound", "每轮最多收录几条", "number"],
        ["perDay", "每天最多收录几条", "number"],
        ["quietStart", "静默开始", "time"],
        ["quietEnd", "静默结束", "time"],
        ["valleyOnly", "仅在谷时时段运行", "checkbox"],
        ["reserveNoon", "夜间预留一轮给中午", "checkbox"],
      ],
    ],
    [
      "内容与转写",
      [
        ["minMinutes", "最短视频（分钟）", "number"],
        ["maxMinutes", "最长视频（分钟）", "number", "0 表示不限最长时长。"],
        ["subtitleProbeMax", "每轮最多探查字幕数", "number"],
        ["transcribe", "无字幕时使用本地转写", "checkbox"],
        ["transcribePerDay", "每天最多转写次数", "number"],
        [
          "asrModel",
          "Whisper 模型",
          "select",
          ["tiny", "base", "small", "medium"],
        ],
        ["maxRounds", "模型最多工具轮数", "number"],
        ["maxRunMinutes", "单轮最长时间（分钟）", "number"],
      ],
    ],
    [
      "评论、私信与赞藏",
      [
        [
          "commentMode",
          "评论模式",
          "select",
          [
            ["off", "关闭"],
            ["normal", "普通评论"],
            ["invited", "仅回复 UP 邀请"],
          ],
        ],
        [
          "autoSend",
          "允许按下列开关自动发送",
          "checkbox",
          "关闭时仅创建草稿，需要逐条确认。",
        ],
        ["commentsPerRound", "本轮评论上限", "number"],
        ["commentsPerDay", "每日评论上限", "number"],
        [
          "mentionUid",
          "普通评论中提及的用户 UID",
          "text",
          "可留空。会解析昵称并写入正文；是否推送通知由 B 站决定。",
        ],
        ["dmOn", "允许私信给唯一接收人", "checkbox"],
        ["dmUid", "私信接收 UID", "text"],
        ["dmPerDay", "每日私信上限", "number"],
        ["likeOn", "允许点赞", "checkbox"],
        ["likesPerRound", "本轮点赞上限", "number"],
        ["likesPerDay", "每日点赞上限（最多 10）", "number"],
        ["favOn", "允许收藏", "checkbox"],
        ["favsPerDay", "每日收藏上限（最多 8）", "number"],
        [
          "likeRule",
          "赞藏判据",
          "select",
          [
            ["strict", "严格"],
            ["standard", "标准"],
            ["loose", "宽松"],
          ],
        ],
        ["likeRuleExtra", "补充赞藏判据", "textarea"],
      ],
    ],
    [
      "评论守护",
      [
        ["guardOn", "开启后台评论守护", "checkbox", "同时扫描其他视频中白名单用户发来的 @；不要求当前账号自己投稿。"],
        ["guardOwnerUid", "守护哪位 UP 的视频", "text", "留空时使用当前账号。"],
        [
          "guardWhitelist",
          "允许 @ 的用户 UID",
          "textarea",
          "填写发起 @ 的用户 UID，每行一个；这些用户可以在其他 UP 的视频评论中呼唤昔涟。",
        ],
        ["guardOwnAll", "目标 UP 的视频下回复有内容的评论", "checkbox"],
        ["guardVideos", "最近几条视频", "number"],
        ["guardMinutes", "扫描间隔（分钟）", "number"],
        ["guardPerRound", "每轮回复上限", "number"],
        ["guardPerDay", "每日回复上限", "number"],
      ],
    ],
  ];
  function settings() {
    const d = state.data,
      form = h("form", {
        onInput: (event) => {
          if (event.target.name) state.dirty = true;
        },
        onSubmit: safely(async (e) => {
          e.preventDefault();
          const patch = {};
          for (const input of form.querySelectorAll("[name]")) {
            const k = input.name;
            patch[k] =
              input.type === "checkbox"
                ? input.checked
                : input.type === "number"
                  ? Number(input.value)
                  : ["keywords", "guardWhitelist"].includes(k)
                    ? input.value
                        .split("\n")
                        .map((s) => s.trim())
                        .filter(Boolean)
                    : input.value;
          }
          await invoke("config", patch);
          state.dirty = false;
          notice("设置已保存");
          await refresh(true);
        }),
      });
    const account = h(
      "fieldset",
      {},
      h("legend", {}, "账号与运行环境"),
      h(
        "p",
        {},
        d.account.loggedIn
          ? `已登录：${d.account.name} · ${d.account.uid}`
          : "在运行昔涟的机器上保存账号，浏览器只显示二维码和操作结果。",
      ),
      h(
        "div",
        { class: "buttons" },
        button(
          "安装运行环境",
          safely(() => action("install", {}, "正在安装，进度显示在下方")),
        ),
        button(
          "安装转写环境与模型",
          safely(() =>
            action("install", { asr: true }, "正在安装转写环境与模型"),
          ),
        ),
        button(d.account.loggedIn ? "重新扫码" : "扫码登录", safely(login)),
        d.account.loggedIn
          ? button(
              "退出 B 站账号",
              safely(() => action("logout", {}, "已退出 B 站账号")),
            )
          : null,
      ),
    );
    account.append(
      h("p", { class: "muted" }, "转写模型从魔搭 ModelScope 下载，下载完成后在运行昔涟的机器上离线加载。"),
      h(
        "label",
        { class: "field" },
        h("span", {}, "可选 Python 路径"),
        h("input", {
          name: "pythonPath",
          value: d.config.pythonPath,
          placeholder: "服务端 Python 3.10+ 可执行文件路径",
        }),
      ),
    );
    account.append(
      h(
        "pre",
        {
          id: "environment-log",
          class: "log",
          hidden: !d.environment.log?.length,
        },
        (d.environment.log || []).join("\n"),
      ),
    );
    form.append(account);
    for (const [title, group] of fields) {
      const grid = h("div", { class: "fields" });
      for (const [key, label, type, extra] of group) {
        let input;
        if (type === "select" || type === "profiles") {
          input = h("select", { name: key });
          const choices =
            type === "profiles"
              ? [
                  ["", "跟随昔涟默认模型"],
                  ...d.profiles.map((p) => [
                    p.id,
                    `${p.name} · ${p.model}${p.isDefault ? "（默认）" : ""}`,
                  ]),
                ]
              : extra;
          for (const c of choices) {
            const [value, name] = Array.isArray(c) ? c : [c, c];
            input.append(
              h("option", { value, selected: d.config[key] === value }, name),
            );
          }
        } else if (type === "checkbox")
          input = h("input", { name: key, type, checked: d.config[key] });
        else if (type === "textarea")
          input = h("textarea", {
            name: key,
            value: Array.isArray(d.config[key])
              ? d.config[key].join("\n")
              : d.config[key],
          });
        else
          input = h("input", {
            name: key,
            type,
            value: d.config[key],
            ...(type === "number" ? { min: "0", step: "1" } : {}),
          });
        input.setAttribute("aria-label", label);
        grid.append(
          h(
            "label",
            {
              class: `field ${type === "checkbox" ? "switch" : ""} ${type === "textarea" ? "wide" : ""}`,
            },
            h("span", {}, label),
            input,
            typeof extra === "string"
              ? h("small", { class: "hint" }, extra)
              : null,
          ),
        );
      }
      form.append(h("fieldset", {}, h("legend", {}, title), grid));
    }
    form.append(
      h(
        "div",
        { class: "savebar" },
        h("button", { type: "submit", class: "primary" }, "保存设置"),
        button("放弃修改", () => {
          state.dirty = false;
          render(true);
          notice("已恢复为保存的设置");
        }),
        h("span", { class: "muted" }, "额度 0 表示禁止；时长上限 0 表示不限。"),
      ),
    );
    const charter = h("textarea", {
      value: d.charter,
      "aria-label": "任务章程",
    });
    form.append(
      h(
        "details",
        {},
        h("summary", {}, "自定义任务约定"),
        h(
          "p",
          { class: "muted" },
          "昔涟的人格仍由宿主设置提供，这里只写选片和互动的任务约定。",
        ),
        charter,
        button(
          "保存任务约定",
          safely(() =>
            action("charter", { text: charter.value }, "任务约定已保存"),
          ),
        ),
      ),
    );
    const logs = h(
      "div",
      {},
      h("div", { class: "section-head" }, h("h2", {}, "运行记录")),
      d.runs.map((r) =>
        h(
          "div",
          { class: "entry" },
          h(
            "strong",
            {},
            `${labels[r.status] || r.status} · ${r.kind === "guard" ? "评论守护" : r.kind === "question" ? "视频追问" : "发现视频"}`,
          ),
          h("div", { class: "meta" }, fmtTime(r.started)),
          r.error ? h("p", { class: "error" }, r.error) : null,
          r.usage
            ? h(
                "p",
                {},
                `输入 ${r.usage.input} · 缓存命中 ${r.usage.cachedInput} · 输出 ${r.usage.output}`,
              )
            : null,
        ),
      ),
      h(
        "pre",
        { class: "log" },
        d.events.map((e) => `${fmtTime(e.at)} ${e.message}`).join("\n"),
      ),
    );
    return h("div", {}, form, logs);
  }
  async function login() {
    const data = await invoke("login-start");
    const box = h(
      "div",
      {},
      data.image
        ? h("img", {
            class: "qr",
            src: data.image,
            alt: "用手机 B 站扫描此二维码",
          })
        : h("p", { class: "error" }, "二维码图片需要先安装运行环境。"),
      h("p", {}, "用手机 B 站扫一扫，并确认登录。"),
      h(
        "a",
        { href: data.url, target: "_blank", rel: "noopener noreferrer" },
        "打开登录链接",
      ),
      h("p", { class: "muted" }, "二维码约三分钟有效。"),
    );
    const status = h("p", {}, "等待扫码…");
    box.append(status);
    show("登录 B 站", box);
    const poll = async () => {
      try {
        if (!$("detail").open || !status.isConnected) return;
        const r = await invoke("login-poll", { key: data.key });
        status.textContent =
          {
            waiting: "等待扫码…",
            scanned: "已扫码，请在手机上确认",
            expired: "二维码已过期，请关闭后重新生成",
            ok: "登录成功",
          }[r.state] || r.state;
        if (["ok", "expired"].includes(r.state)) {
          if (r.state === "ok") {
            notice("B 站登录成功");
            await refresh(true);
          }
        } else setTimeout(poll, 2500);
      } catch (e) {
        status.textContent = e.message;
      }
    };
    setTimeout(poll, 2500);
  }
  function render(force = false) {
    if (!state.data) return;
    const d = state.data;
    // Polling unrelated task progress must not redraw the user's current page.
    const view = state.tab === "queue" ? d.videos.filter(v => v.queueStatus === "queued").map(videoView)
      : state.tab === "discover" ? [d.videos.filter(v => v.picked && v.feedback !== "dislike").map(videoView), d.questions.slice(0, 8)]
      : state.tab === "notes" ? [d.reports, d.memories]
      : state.tab === "actions" ? [d.actions, d.guard, d.cooldown?.until > Date.now() ? d.cooldown : null]
      : [d.config, d.account, d.environment, d.profiles, d.charter, d.runs, d.events];
    const signature = JSON.stringify([state.tab, view]);
    if (!force && signature === pageSignature) return;
    const content = { discover, queue, notes, actions: interactions, settings }[state.tab]();
    if ($("page").firstElementChild !== content) $("page").replaceChildren(content);
    if (state.tab !== "queue") queueView = null;
    pageSignature = signature;
  }
  let refreshPromise = null, forceRefreshRequested = false;
  function refresh(force = false) {
    if (refreshPromise) {
      if (force) forceRefreshRequested = true;
      return refreshPromise;
    }
    refreshPromise = (async () => {
      do {
        const updateForm = force || forceRefreshRequested;
        force = false;
        forceRefreshRequested = false;
        try {
          state.data = await invoke("snapshot");
          renderStatus();
          if (!state.dirty && (updateForm || state.tab !== "settings")) render(updateForm);
        } catch (e) {
          notice(`无法读取小花园：${e.message}。请确认插件仍已启用，然后重试。`, true);
        }
      } while (forceRefreshRequested);
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }
  $("detail-close").onclick = () => $("detail").close();
  $("refresh").onclick = () => refresh(true);
  $("run").onclick = safely(() => action("run", {}, "昔涟出发去找视频了"));
  $("cancel").onclick = safely(() => action("cancel", {}, "已请求停止本轮"));
  window.CyrenePanel.onTheme?.((theme) => {
    document.documentElement.dataset.theme = /dark|charcoal|night/i.test(
      theme.name || "",
    )
      ? "dark"
      : "light";
  });
  renderTabs();
  refresh(true);
  setInterval(() => {
    if (!document.hidden) refresh();
  }, 4000);
})();
