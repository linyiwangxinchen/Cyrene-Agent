import { localClock, videoId } from "./config.mjs";
const riskPattern = /-352|-412|-799|-509|风控|risk/i;
export function invitation(text) {
  const s = String(text || "").trim();
  return (
    !/(不要|别|不许|禁止|拒绝|滚|别刷)/.test(s) &&
    /^(?:@[^\s]+\s*)?(?:昔涟|小昔|花园|鱼|大肥鱼).{0,8}(?:来|看看|聊聊|说说)|^(?:快来|请来).{0,8}(?:昔涟|小昔|大肥鱼)/.test(
      s,
    ) &&
    !/(来了|来过)/.test(s)
  );
}
export function worthwhile(text) {
  const s = String(text || "")
    .replace(/@[^\s]+/g, "")
    .trim();
  return (
    s.length >= 4 &&
    !/(https?:|www\.|加群|代刷|互粉|优惠券)/i.test(s) &&
    !/^(哈|6|顶|赞|[\p{P}\p{S}\s])+$/u.test(s)
  );
}
export class InteractionPolicy {
  constructor({ store, client, config, account, now = () => Date.now() }) {
    Object.assign(this, { store, client, config, account, now });
    this.tail = Promise.resolve();
  }
  async draft(input, run) {
    const config = this.config(),
      account = await this.account();
    if (!account.loggedIn) throw new Error("请先登录");
    const kind = String(input.kind),
      allowed = ["comment", "reply", "dm", "like", "fav"];
    if (!allowed.includes(kind)) throw new Error("互动类型无效");
    const bvid =
      kind === "dm"
        ? input.bvid
          ? videoId(input.bvid)
          : ""
        : videoId(input.bvid);
    const text = String(input.text ?? "").trim(),
      reason = String(input.reason ?? "").trim();
    if (reason.length < 6 || reason.length > 500)
      throw new Error("请给出至少 6 字的具体理由");
    if (
      ["comment", "reply", "dm"].includes(kind) &&
      (!text || text.length > (kind === "dm" ? 500 : 300))
    )
      throw new Error("发送正文为空或过长");
    if (kind !== "dm" && !this.store.get("evidence", bvid)?.text)
      throw new Error("还没有这条视频的内容证据，请先读字幕或转写");
    const target =
      kind === "dm"
        ? String(input.targetUid || config.dmUid)
        : String(input.rpid || "");
    if (kind === "dm" && (!config.dmUid || target !== config.dmUid))
      throw new Error("私信只允许发送给设置中的唯一接收 UID");
    const day = localClock(new Date(this.now()), config.timezone).day;
    const key =
      kind === "dm"
        ? `${account.uid}:dm:${run?.id || day}`
        : `${account.uid}:${kind}:${bvid}:${target}`;
    const action = this.store.draft({
      idem: key,
      day,
      runId: run?.id,
      kind,
      bvid,
      targetUid: kind === "dm" ? target : "",
      rpid: kind === "reply" ? target : "",
      root: String(input.root || ""),
      reason,
      text,
      accountUid: account.uid,
      guard: Boolean(input.guard),
      invited: Boolean(input.invited),
    });
    const pending = input.guard
      ? this.store.get("guard", `${account.uid}:${target}`)
      : null;
    if (
      input.guard &&
      action.status === "failed" &&
      pending?.status === "pending" &&
      pending.attempts <= 3
    ) {
      return this.store.updateAction(action.id, "draft", { text, reason });
    }
    return action;
  }
  execute(id, { signal, runId } = {}) {
    const promise = this.tail.then(() => this.perform(id, { signal, runId }));
    this.tail = promise.catch(() => {});
    return promise;
  }
  async perform(id, { signal, runId }) {
    signal?.throwIfAborted();
    const a = this.store.action(id);
    if (!a) throw new Error("互动不存在");
    const config = this.config(),
      account = await this.account();
    signal?.throwIfAborted();
    const policySignature = JSON.stringify(config);
    if (!account.loggedIn || account.uid !== a.accountUid)
      throw new Error("登录账号已变更，请重新生成互动草稿");
    if (a.status !== "draft")
      throw new Error("该互动已处理或状态尚不明确，不能重复发送");
    if (
      Number(this.store.get("meta", "cooldown", { until: 0 }).until) >
      this.now()
    )
      throw new Error("B站风控冷却中，请稍后再试");
    if (a.kind !== "dm" && !this.store.get("evidence", a.bvid)?.text)
      throw new Error("没有有效内容证据");
    let daily = 0,
      round,
      tool,
      args;
    if (a.kind === "dm") {
      if (!config.dmOn || !config.dmUid || a.targetUid !== config.dmUid)
        throw new Error("私信未启用或接收人已变化");
      daily = config.dmPerDay;
      tool = "bili_send_message";
      args = { receiver_uid: Number(config.dmUid), text: a.text };
    } else if (a.kind === "like" || a.kind === "fav") {
      if (!(a.kind === "like" ? config.likeOn : config.favOn))
        throw new Error("该互动开关已关闭");
      daily = Math.min(
        a.kind === "like" ? 10 : 8,
        a.kind === "like" ? config.likesPerDay : config.favsPerDay,
      );
      if (a.kind === "like" && runId) round = Math.min(5, config.likesPerRound);
      const opposite = this.store
        .actions(5000)
        .find(
          (x) =>
            x.accountUid === a.accountUid &&
            x.bvid === a.bvid &&
            x.kind !== a.kind &&
            ["like", "fav"].includes(x.kind) &&
            x.status === "sent" &&
            !x.undone,
        );
      if (opposite) throw new Error("这条视频已经有另一种表态；先撤销后再选择");
      tool = a.kind === "like" ? "bili_like" : "bili_fav";
      args = { bvid: a.bvid, [a.kind === "like" ? "like" : "fav"]: true };
    } else {
      if (a.guard) {
        if (!config.guardOn) throw new Error("评论守护已关闭");
        const pending = this.store.get("guard", `${a.accountUid}:${a.rpid}`);
        if (!pending || pending.bvid !== a.bvid || pending.status === "sent")
          throw new Error("评论不在本轮待回复清单");
        if (
          (pending.kind === "at" || !config.guardOwnAll) &&
          !config.guardWhitelist.includes(String(pending.uid))
        )
          throw new Error("该用户已不在守护白名单");
        if (
          pending.kind === "comment" &&
          pending.ownerUid &&
          pending.ownerUid !== (config.guardOwnerUid || account.uid)
        )
          throw new Error("守护 UP 已变更");
        daily = config.guardPerDay;
        round = runId ? config.guardPerRound : undefined;
      } else {
        if (config.commentMode === "off") throw new Error("评论已关闭");
        daily = config.commentsPerDay;
        round = runId ? config.commentsPerRound : undefined;
      }
      if (config.commentMode === "invited" && !a.guard) {
        if (a.kind !== "reply" || !a.rpid)
          throw new Error("仅受邀模式只允许回复邀请楼层");
        const info = await this.client.info(a.bvid, { signal });
        const comments = await this.client.call(
          "bili_comments",
          { bvid: a.bvid, num: 100, order: "time" },
          { signal },
        );
        const target = (comments.comments ?? comments ?? []).find(
          (c) => String(c.rpid) === a.rpid,
        );
        if (
          !target ||
          String(target.mid ?? target.uid) !== String(info.ownerUid) ||
          !invitation(target.content ?? target.text)
        )
          throw new Error("未核实到 UP 主本人的有效邀请，未发送");
      }
      tool = "bili_reply";
      args = {
        bvid: a.bvid,
        text: a.text,
        rpid: Number(a.rpid) || 0,
        root: Number(a.root) || 0,
      };
      if (a.guard)
        args.root =
          Number(this.store.get("guard", `${a.accountUid}:${a.rpid}`).root) ||
          0;
      else if (config.commentMode === "invited") args.root = 0;
      if (a.kind === "reply" && !args.rpid)
        throw new Error("回复缺少目标评论 ID");
      if (a.kind === "comment" && config.mentionUid) {
        const target = await this.client.call(
          "bili_user_info",
          { uid: config.mentionUid },
          { signal },
        );
        const name = String(target.name || "")
          .replace(/[\r\n@]/g, "")
          .slice(0, 100);
        if (!name) throw new Error("无法识别要提及的用户，请检查 UID");
        if (!args.text.includes(`@${name}`))
          args.text = `@${name} ${args.text}`;
      }
    }
    signal?.throwIfAborted();
    if (JSON.stringify(this.config()) !== policySignature)
      throw new Error("配置在检查期间发生变化，请按当前设置重新确认");
    const day = localClock(new Date(this.now()), config.timezone).day;
    this.store.reserveAction(id, {
      day,
      daily,
      round,
      runId: runId ?? a.run_id,
    });
    try {
      const receipt = await this.client.call(tool, args, { signal });
      if (!receipt || (receipt.success !== true && receipt.ok !== true && !(a.kind === "like" && receipt.has_liked === true)))
        throw new Error("没有取得明确的成功回执，请到 B 站核对后再操作");
      if (a.kind === "like" && receipt.has_liked !== true)
        throw new Error("接口未确认点赞状态，请核对后再操作");
      const result = this.store.updateAction(id, "sent", {
        receipt,
        ...(args.text ? { sentText: args.text } : {}),
        finished: this.now(),
      });
      if (a.guard)
        this.store.put("guard", `${a.accountUid}:${a.rpid}`, {
          ...this.store.get("guard", `${a.accountUid}:${a.rpid}`),
          status: "sent",
        });
      return result;
    } catch (e) {
      if (riskPattern.test(e.message))
        this.store.put("meta", "cooldown", {
          until: this.now() + 1800000,
          reason: "B站暂时限制互动",
        });
      this.store.updateAction(id, e.definitive ? "failed" : "uncertain", {
        error: String(e.message).slice(0, 500),
      });
      throw e;
    }
  }
  undo(id, signal) {
    const promise = this.tail.then(() => this.performUndo(id, signal));
    this.tail = promise.catch(() => {});
    return promise;
  }
  async performUndo(id, signal) {
    const a = this.store.action(id);
    if (
      !a ||
      !["like", "fav"].includes(a.kind) ||
      a.status !== "sent" ||
      a.undone
    )
      throw new Error("只能撤销本插件确认成功的赞藏");
    if (["sending", "uncertain"].includes(a.undoStatus))
      throw new Error("撤销操作的结果尚不明确，请先到 B 站核对");
    const account = await this.account();
    if (account.uid !== a.accountUid)
      throw new Error("当前账号不是执行该操作的账号");
    signal?.throwIfAborted();
    this.store.updateAction(id, "sent", { undoStatus: "sending" });
    try {
      const result = await this.client.call(
        a.kind === "like" ? "bili_like" : "bili_fav",
        { bvid: a.bvid, [a.kind === "like" ? "like" : "fav"]: false },
        { signal },
      );
      if (!result || (result.ok !== true && result.success !== true)) throw new Error("未取得撤销成功的回执");
      if (a.kind === "like" && result.has_liked !== false) throw new Error("未确认点赞已撤销，请核对 B 站状态");
      return this.store.updateAction(id, "sent", {
        undone: true,
        undoStatus: "sent",
        undoReceipt: result,
      });
    } catch (e) {
      this.store.updateAction(id, "sent", {
        undoStatus: e.definitive ? "failed" : "uncertain",
        undoError: String(e.message).slice(0, 300),
      });
      throw e;
    }
  }
}
