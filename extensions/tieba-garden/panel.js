(() => {
  "use strict";

  const el = id => document.getElementById(id);
  const invoke = (command, args = {}) => window.CyrenePanel.invoke("forum", command, args);
  const sectionIds = ["browse", "journal", "expressions", "settings"];
  const pageSize = { visits: 6, readings: 6, samples: 12 };
  const shown = { ...pageSize };
  const visitStatus = {
    complete: "已完成", partial: "部分完成", empty: "没有新帖",
    failed: "本轮中断", cancelled: "已取消", running: "进行中",
  };

  let state;
  let activeSection = "browse";
  let actionBusy = false;
  let readRequest;
  let importSource;
  let refreshPromise;
  let discovery;
  let pendingForget;
  let settingsDirty = false;
  let previousStatus;
  let highlightTid;
  const signatures = new Map();

  function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function btn(text, handler, className = "") {
    const button = h("button", className, text);
    button.type = "button";
    button.addEventListener("click", handler);
    return button;
  }

  function busyButton(text, handler, className = "") {
    const button = btn(text, handler, className);
    button.dataset.requiresIdle = "";
    button.disabled = actionBusy || Boolean(state?.busy);
    return button;
  }

  function threadUrl(value) {
    try {
      const url = new URL(value, "https://tieba.baidu.com");
      const isThread = /^\/p\/\d{1,20}\/?$/.test(url.pathname);
      if (url.origin === "https://tieba.baidu.com" && isThread && !url.username && !url.password) return url.href;
    } catch {}
    return "";
  }

  function sourceLink(value, text) {
    const url = value && threadUrl(value);
    return url ? externalLink(url, text) : null;
  }

  function externalLink(url, text) {
    const a = h("a", "action-link", text);
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  }

  function rowActions(parent, ...children) {
    const actions = h("div", "actions");
    actions.append(...children.filter(Boolean));
    if (actions.childNodes.length) parent.append(actions);
  }

  function barLabel(bar) {
    return bar.endsWith("吧") ? bar : bar + "吧";
  }

  function localTime(value) {
    if (typeof value !== "number" || !(value > 0)) return "";
    return new Intl.DateTimeFormat("zh-CN", {
      month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(value);
  }

  function notice(message, error = false) {
    el("notice").textContent = message ?? "";
    el("notice").dataset.level = error ? "error" : "info";
  }

  function go(section, focus = true) {
    if (!sectionIds.includes(section)) return;
    if (activeSection === "settings" && section !== "settings") el("auth-cookie").value = "";
    activeSection = section;
    for (const button of document.querySelectorAll("[data-section]")) {
      if (button.dataset.section === section) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    for (const id of sectionIds) el(id).hidden = id !== section;
    if (focus) el(section + "-heading").focus({ preventScroll: true });
    updateControls();
  }

  function configsFrom(s) {
    const config = s?.config ?? {};
    return { ...config, bars: config.bars ?? (config.bar ? [config.bar] : []) };
  }

  function showSettings(config) {
    if (!settingsDirty) {
      el("bars").value = config.bars.join("\n");
      el("learn").checked = Boolean(config.learn);
      el("replies").checked = Boolean(config.replies);
      el("auto").checked = Boolean(config.auto);
      el("interval").value = config.intervalHours ?? 4;
      el("post-limit").value = config.postsPerVisit ?? 1;
    }
    const select = el("discover-bar");
    const previous = select.value;
    const key = JSON.stringify(config.bars);
    if (select.dataset.bars === key) return;
    select.dataset.bars = key;
    select.replaceChildren(...config.bars.map(bar => new Option(barLabel(bar), bar)));
    if (!config.bars.length) select.append(new Option("请先添加常逛的吧", ""));
    if (config.bars.includes(previous)) select.value = previous;
    if (discovery?.bar !== select.value) {
      discovery = undefined;
      showDiscovery();
    }
  }

  function fill(id, items, empty, render, limit) {
    const visible = limit ? items.slice(0, limit) : items;
    const key = JSON.stringify([visible, empty]);
    if (signatures.get(id) !== key) {
      signatures.set(id, key);
      el(id).replaceChildren(...(visible.length ? visible.map(render) : [h("p", "empty", empty)]));
    }
    if (limit) el("more-" + id).hidden = items.length <= limit;
  }

  function showDiscovery() {
    const message = discovery ? discovery.empty ?? "这个吧暂时没有可读的帖子。" : "选择常逛的吧，查看候选帖子。";
    const readings = state?.history ?? (state?.reading ? [state.reading] : []);
    const displayed = (discovery?.rows ?? []).map(row => {
      const hasNote = readings.some(record => record.tid === row.id);
      return { ...row, read: row.read || hasNote, hasNote };
    });
    fill("threads", displayed, message, row => {
      const item = h("article", "entry");
      const header = h("div", "entry-head");
      header.append(h("h3", "", row.title));
      if (row.read) header.append(h("span", "chip", "已读"));
      item.append(header);
      if (row.replyCount != null) item.append(h("p", "meta", row.replyCount + " 条回复"));
      const url = row.url ?? "/p/" + row.id;
      const action = row.hasNote
        ? btn("查看手记", () => {
            highlightTid = row.id;
            render(state);
            go("journal");
          })
        : busyButton(row.read ? "再读这篇" : "读这篇", () => startRead({ url, title: row.title, bar: row.bar ?? discovery.bar }));
      rowActions(item, action, sourceLink(url, "打开原帖"));
      return item;
    });
    if (discovery?.empty && !el("threads").querySelector(".action-link")) {
      rowActions(el("threads"), externalLink("https://tieba.baidu.com/f?kw=" + encodeURIComponent(discovery.bar), "在浏览器打开这个吧"));
    }
  }

  async function showDetail(item, url, title) {
    const dialog = el("detail");
    el("detail-title").textContent = title;
    const body = el("detail-body");
    body.replaceChildren(h("p", "muted", "正在读取楼层原文…"));
    dialog.showModal();
    el("detail-title").focus();
    let reading;
    try {
      reading = item.floors ? item : await invoke("detail", { tid: item.tid });
    } catch (error) {
      body.replaceChildren(h("p", "reason", error.message));
      return;
    }
    if (!dialog.open || el("detail-title").textContent !== title) return;
    body.replaceChildren();
    rowActions(body, sourceLink(url, "打开原帖"));
    const floors = h("ol", "floor-list");
    reading.floors.forEach((floor, index) => {
      const row = h("li");
      const type = item.imported ? "导入摘录" : floor.reply ? "楼中楼" : "楼层";
      const label = [type, floor.page ? "第 " + floor.page + " 页" : "", floor.floor ? "第 " + floor.floor + " 楼" : !item.imported && !floor.reply ? String(index + 1) : ""].filter(Boolean).join(" · ");
      row.append(h("p", "meta", label), h("p", "", floor.body));
      if (floor.post && !item.imported) {
        const floorUrl = new URL(threadUrl(url));
        if (floor.page) {
          if (floor.page === 1) floorUrl.searchParams.delete("pn");
          else floorUrl.searchParams.set("pn", String(floor.page));
        }
        floorUrl.hash = "post_content_" + floor.post;
        const link = sourceLink(floorUrl.href, "查看来源楼层");
        if (link) row.append(link);
      }
      floors.append(row);
    });
    body.append(floors);
  }

  function readingEntry(item) {
    const row = h("article", "entry");
    const header = h("div", "entry-head");
    const title = item.title || "帖子 " + item.tid;
    header.append(h("h3", "", title));
    if (item.imported) header.append(h("span", "chip", "楼层摘录"));
    const floorCount = item.floorCount ?? item.floors?.length ?? 0;
    row.append(header, h("p", "meta", [
      item.bar ? barLabel(item.bar) : "",
      localTime(item.at),
      floorCount ? floorCount + " 段原文" : "",
    ].filter(Boolean).join(" · ")));
    const analysisMessages = {
      pending: "楼层已保存，正在整理手记。",
      failed: "楼层已保存，手记整理未完成。",
      unavailable: "楼层已保存，配置默认模型后可以整理手记。",
      skipped: "楼层已保存，这篇没有生成手记。",
    };
    const message = item.summary || analysisMessages[item.analysisStatus] || "展开楼层原文回看这篇帖子。";
    row.append(h("p", item.summary ? "note" : "muted", message));
    if (item.analysisError) row.append(h("p", "reason", item.analysisError));
    if (item.replyStatus) row.append(h("p", "meta", item.replyStatus));
    if (item.evidence?.length) {
      const excerpt = h("details", "fold");
      excerpt.append(h("summary", "", "手记里的原文"));
      const list = h("ul", "excerpt-list");
      for (const { quote, source } of item.evidence) {
        const line = h("li", "", "「" + quote + "」");
        const link = sourceLink(source, "查看出处");
        if (link) line.append(link);
        list.append(line);
      }
      excerpt.append(list);
      row.append(excerpt);
    }
    const expressions = (state.samples ?? []).filter(sample => item.sampleIds?.includes(sample.id));
    if (expressions.length) row.append(h("p", "meta", "记下的表达　" + expressions.map(sample => "「" + sample.quote + "」").join("、")));
    const needsAnalysis = ["failed", "unavailable"].includes(item.analysisStatus);
    const url = item.url ?? "/p/" + item.tid;
    rowActions(row,
      floorCount ? btn("看楼层原文", () => showDetail(item, url, title)) : null,
      sourceLink(url, "打开原帖"),
      needsAnalysis ? busyButton("重新整理手记", () => act("analyze", { tid: item.tid, background: true }, "正在提交手记整理…")) : null,
    );
    return row;
  }

  function visitEntry(visit) {
    const row = h("article", "entry");
    const header = h("div", "entry-head");
    const title = [localTime(visit.at), visit.trigger === "auto" ? "自动巡游" : "手动巡游"].filter(Boolean).join(" · ");
    header.append(h("h3", "", title), h("span", "chip" + (["failed", "partial"].includes(visit.status) ? " alert" : ""), visitStatus[visit.status] ?? visit.status));
    const bars = (visit.bars ?? []).map(barLabel).join("、");
    row.append(header, h("p", "meta", [
      bars, "看到 " + (visit.discovered ?? 0) + " 帖",
      "读了 " + (visit.read?.length ?? 0) + " 篇",
      visit.skipped ? "跳过 " + visit.skipped + " 篇" : "",
    ].filter(Boolean).join(" · ")));
    for (const error of visit.errors ?? []) row.append(h("p", "reason", error));
    const stored = state.history ?? (state.reading ? [state.reading] : []);
    const firstReading = visit.read?.find(id => stored.some(item => item.tid === id));
    if (firstReading) {
      rowActions(row, btn("查看本轮手记", () => {
        highlightTid = firstReading;
        render(state);
        go("journal");
      }));
    }
    return row;
  }

  function sampleEntry(sample) {
    const card = h("article", "sample");
    card.append(h("h3", "quote", "「" + sample.quote + "」"), h("p", "", sample.scene));
    if (sample.delivery) card.append(h("p", "muted", sample.delivery));
    card.append(h("p", "meta", [sample.bar ? barLabel(sample.bar) : "", localTime(sample.at)].filter(Boolean).join(" · ")));
    rowActions(card, sourceLink(sample.source, "查看出处"), busyButton("忘记", () => {
      pendingForget = sample.id;
      el("forget-quote").textContent = "「" + sample.quote + "」";
      el("forget-dialog").returnValue = "cancel";
      el("forget-dialog").showModal();
      el("forget-dialog").querySelector('[value="cancel"]').focus();
    }, "danger"));
    return card;
  }

  function updateControls() {
    const config = configsFrom(state);
    const busy = actionBusy || Boolean(state?.busy);
    el("garden").setAttribute("aria-busy", String(!state || busy));
    el("refresh").disabled = actionBusy;
    el("visit").textContent = state?.busy ? "正在处理…" : "逛一逛";
    el("visit").disabled = !state || busy || !config.bars.length;
    el("discover-bar").disabled = !config.bars.length;
    el("discover").disabled = !state || busy || !config.bars.length;
    el("save").disabled = !state || busy;
    el("read").disabled = !state || busy;
    const canEditAuth = state?.auth?.available && !busy;
    el("auth-cookie").disabled = !state?.auth?.available || actionBusy;
    el("auth-save").disabled = !canEditAuth || !el("auth-cookie").value.trim();
    el("auth-check").disabled = !canEditAuth || !state.auth.hasCookie;
    el("auth-clear").disabled = !canEditAuth || !state.auth.hasCookie;
    for (const button of document.querySelectorAll("[data-requires-idle]")) button.disabled = busy;
  }

  function showAuth(auth) {
    const check = auth?.hasCookie ? auth.check : undefined;
    el("auth-state").textContent = !auth?.available ? "凭据存储不可用" : auth.hasCookie ? "已保存 Cookie" : "公开访问";
    el("auth-form").hidden = !auth?.available;
    const result = el("auth-result");
    result.dataset.level = check && check.status !== "accessible" ? "error" : "info";
    result.textContent = check
      ? [localTime(check.at), check.bar ? barLabel(check.bar) : "", check.message].filter(Boolean).join(" · ")
      : auth?.hasCookie ? "检查连接可确认当前能否读取贴吧页面。" : "";
  }

  function authNotice(message, error = false) {
    const node = el("auth-message");
    node.dataset.level = error ? "error" : "info";
    node.textContent = message;
  }

  function render(next) {
    state = next;
    const config = configsFrom(next);
    const readings = next.history ?? (next.reading ? [next.reading] : []);
    const samples = next.samples ?? [];
    el("read-count").textContent = readings.length;
    el("sample-count").textContent = samples.length;
    el("schedule-summary").textContent = !config.auto ? "未开启" : localTime(next.nextVisitAt) || "等待巡游";
    el("learning-help").textContent = config.learn
      ? "聊到相关话题时，昔涟会参考这里存下的说法。"
      : "学习已关闭。之前的收藏仍可回看。";
    showSettings(config);
    showAuth(next.auth);
    showDiscovery();
    fill("visits", next.visits ?? [], "点击「逛一逛」，就会在这里留下巡游记录。", visitEntry, shown.visits);
    const ordered = highlightTid
      ? [...readings.filter(item => item.tid === highlightTid), ...readings.filter(item => item.tid !== highlightTid)]
      : readings;
    const sampleKey = JSON.stringify(samples.map(row => row.id));
    if (el("readings").dataset.samples !== sampleKey) {
      el("readings").dataset.samples = sampleKey;
      signatures.delete("readings");
    }
    fill("readings", ordered, "读完第一篇帖子后，就能在这里看到楼层与手记。", readingEntry, shown.readings);
    fill("samples", samples, "读到适合留存的用法后，它的原话、适用场景和出处会出现在这里。", sampleEntry, shown.samples);
    if (next.status !== previousStatus) {
      previousStatus = next.status;
      if (next.status) notice(next.status, /失败|中断|安全验证/.test(next.status));
    }
    if (readRequest && !next.busy) {
      const request = readRequest;
      readRequest = undefined;
      const saved = readings.find(item => item.tid === request.id);
      if (saved && /^(已读|楼层已保存) · /.test(next.status ?? "")) {
        highlightTid = request.id;
        render(next);
        if (activeSection === "browse") go("journal");
      } else if (next.status) {
        showReadError(next.status, request);
        if (activeSection === "browse") el("read-error").scrollIntoView({ block: "nearest" });
      }
    }
    updateControls();
  }

  async function refresh(manual = false) {
    if (refreshPromise) return refreshPromise;
    if (actionBusy) return;
    refreshPromise = (async () => {
      try {
        render(await invoke("state", { compact: true }));
        if (manual && !state.busy) notice(state.status || "已刷新");
      } catch (error) {
        if (manual || !state) notice("无法读取贴吧面板。请确认插件已开启后再刷新。 " + error.message, true);
      } finally {
        refreshPromise = undefined;
        updateControls();
      }
    })();
    return refreshPromise;
  }

  async function act(command, args, waiting, onResult = render, feedback = notice) {
    if (actionBusy) return false;
    if (refreshPromise) await refreshPromise;
    if (actionBusy) return false;
    actionBusy = true;
    updateControls();
    feedback(waiting);
    try {
      const result = await invoke(command, { ...args, compact: true });
      onResult(result);
      return true;
    } catch (error) {
      feedback(error.message, true);
      return false;
    } finally {
      actionBusy = false;
      updateControls();
    }
  }

  function showReadError(message, request) {
    const { url } = request;
    el("read-error").hidden = false;
    el("read-error-text").textContent = message;
    const recovery = el("read-recovery");
    recovery.replaceChildren();
    const original = sourceLink(url, "打开原帖");
    if (original) recovery.append(original);
    recovery.append(btn("改为导入摘录", () => {
      importSource = request;
      el("thread-url").value = url;
      el("import").open = true;
      el("excerpt").focus();
    }));
  }

  async function startRead({ url, title, bar, excerpt }) {
    const normalized = threadUrl(url);
    if (!normalized) {
      notice("请输入有效的贴吧帖子链接。", true);
      el("thread-url").focus();
      return;
    }
    const id = new URL(normalized).pathname.split("/")[2];
    const request = { id, url: normalized, title, bar };
    el("read-error").hidden = true;
    const ok = await act("read", { url: normalized, title, bar, excerpt, background: true }, "正在提交读帖任务…", next => {
      readRequest = request;
      render(next);
    });
    if (!ok && el("notice").dataset.level === "error") showReadError(el("notice").textContent, request);
  }

  el("read-form").addEventListener("submit", event => {
    event.preventDefault();
    const url = el("thread-url").value.trim();
    const source = importSource?.url === threadUrl(url) ? importSource : undefined;
    startRead({ url, title: source?.title, bar: source?.bar, excerpt: el("excerpt").value.trim() });
  });
  el("settings-form").addEventListener("input", () => {
    settingsDirty = true;
    el("bars").setCustomValidity("");
    el("settings-message").textContent = "";
  });
  el("settings-form").addEventListener("submit", event => {
    event.preventDefault();
    const input = el("bars");
    const bars = [...new Set(input.value.split(/[\r\n,，、]+/u).map(bar => bar.trim()).filter(Boolean))];
    if (bars.length > 8 || bars.some(bar => bar.length > 50)) {
      input.setCustomValidity("最多填写 8 个吧名，单个吧名最多 50 字。");
      input.reportValidity();
      return;
    }
    act("save", {
      bar: bars[0] ?? "",
      bars,
      replies: el("replies").checked,
      auto: el("auto").checked,
      learn: el("learn").checked,
      intervalHours: el("interval").valueAsNumber,
      postsPerVisit: el("post-limit").valueAsNumber,
    }, "正在保存巡游设置…", next => {
      settingsDirty = false;
      render(next);
      notice("巡游设置已保存");
      el("settings-message").textContent = "设置已保存";
    });
  });
  el("auth-cookie").addEventListener("input", updateControls);
  el("auth-form").addEventListener("submit", event => {
    event.preventDefault();
    const input = el("auth-cookie");
    const cookie = input.value.trim();
    if (!cookie || actionBusy || state?.busy) return;
    input.value = "";
    void act("auth-save", { cookie }, "正在保存 Cookie…", next => {
      render(next);
      authNotice("Cookie 已保存，可以检查连接。");
    }, (message, error) => authNotice(error ? "保存失败，请核对 Cookie 请求头后重新粘贴。" : message, error));
  });
  el("auth-check").addEventListener("click", () => {
    void act("auth-check", { bar: el("discover-bar").value || undefined }, "正在检查页面能否读取…", next => {
      render(next);
      authNotice("");
    }, authNotice);
  });
  el("auth-clear").addEventListener("click", () => {
    void act("auth-clear", {}, "正在清除已保存的 Cookie…", next => {
      el("auth-cookie").value = "";
      render(next);
      authNotice("已恢复公开访问。");
    }, authNotice);
  });
  window.addEventListener("pagehide", () => { el("auth-cookie").value = ""; });
  el("discover-bar").addEventListener("change", () => {
    discovery = undefined;
    showDiscovery();
  });
  el("discover").addEventListener("click", () => {
    const bar = el("discover-bar").value;
    void act("discover", { bar }, "正在读取帖子列表…", rows => {
      if (el("discover-bar").value !== bar) return;
      discovery = { bar, rows };
      showDiscovery();
      notice(rows.length ? "" : "这个吧暂时没有可读的帖子。");
    }).then(ok => {
      if (ok || el("discover-bar").value !== bar) return;
      discovery = { bar, empty: "可以打开这个吧，找到想读的帖子后导入楼层摘录。" };
      showDiscovery();
    });
  });
  el("refresh").addEventListener("click", () => refresh(true));
  el("visit").addEventListener("click", () => act("visit", { background: true }, "正在开始巡游…"));
  el("detail-close").addEventListener("click", () => el("detail").close());
  el("forget-dialog").addEventListener("close", event => {
    if (event.target.returnValue === "forget" && pendingForget) {
      act("forget", { id: pendingForget }, "正在移除表达…", next => {
        render(next);
        notice("已从表达收藏移除");
      });
    }
    pendingForget = undefined;
  });
  for (const button of document.querySelectorAll("[data-section], [data-go]")) {
    button.addEventListener("click", () => {
      const dest = button.dataset.section ?? button.dataset.go;
      if (dest === "journal" && state) {
        highlightTid = undefined;
        render(state);
      }
      go(dest);
    });
  }
  for (const [id, count] of Object.entries(pageSize)) {
    el("more-" + id).addEventListener("click", () => {
      shown[id] += count;
      render(state);
    });
  }

  const fallback = window.matchMedia("(prefers-color-scheme: dark)");
  document.documentElement.dataset.theme = fallback.matches ? "dark" : "light";
  window.CyrenePanel.onTheme?.(theme => {
    document.documentElement.dataset.theme = /dark|charcoal|night/i.test(theme.name || "") ? "dark" : "light";
  });
  showDiscovery();
  refresh(true);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });
  window.setInterval(() => {
    if (!document.hidden) refresh();
  }, 2500);
})();
