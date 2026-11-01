"""Cyrene-owned Bilibili adapter. No external host, MCP server or file-based settings.

API functions adapted from MIT-licensed bilibili-mcp; see ../NOTICE.md.
Credentials are scoped to one request and owned by Cyrene secrets.
"""
import asyncio
import json
import re
from contextvars import ContextVar
from bilibili_api import video, search, comment, Credential, user, session

credential_context = ContextVar("cyrene_bili_credential", default=None)

def get_cred():
    credential = credential_context.get()
    if credential is None:
        raise ValueError("请先在昔涟小花园中扫码登录 B 站")
    return credential


_BILI_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

_RISK_CODES = (-352, -412, -799, -509)

def _risk_text(code, msg: str = "") -> str:
    """code + message 一行；风控码额外带「风控」二字，宿主要靠它停 30 分钟。"""
    code = int(code or 0)
    return f"{'风控拦截 ' if code in _RISK_CODES else ''}code={code} {msg or ''}".strip()

def _brief_error(e: Exception) -> str:
    """异常压成一行短文案：模型要的是「为什么没成」，不是栈。"""
    code = getattr(e, "code", None)
    if code is None:
        return f"{type(e).__name__}: {e}"
    return _risk_text(code, getattr(e, "msg", "") or str(e))

def _norm_bvid(bvid: str) -> str:
    """统一成 BV 开头再去打接口：粘贴带来的空格、小写前缀都忍，不像 BV 号就回空串。"""
    v = re.sub(r"\s+", "", str(bvid or ""))
    return "BV" + v[2:] if re.match(r"(?i)^bv[0-9a-z]{10}$", v) else ""

async def _bili_api(method: str, url: str, cred: Credential, params: dict = None, data: dict = None) -> dict:
    """带登录态打 B站 web 接口（cookie 直接取 cred.get_cookies()，csrf 由调用方填 bili_jct）。"""
    import aiohttp
    async with aiohttp.ClientSession() as sess:
        async with sess.request(
            method, url,
            params=params, data=data,
            headers={"User-Agent": _BILI_UA, "Referer": "https://www.bilibili.com/"},
            cookies=cred.get_cookies(),
            timeout=aiohttp.ClientTimeout(total=15),
        ) as resp:
            try:
                return await resp.json(content_type=None)
            except Exception:
                return {"code": -1, "message": f"HTTP {resp.status} 返回非 JSON"}

async def _comment_state(rpid: int, aid: int, cred: Credential) -> str:
    """单查一条评论还在不在，返回 gone / exists / unknown。

    x/v2/reply/reply 传 root=rpid：一级评论回它自己，楼中楼回它所在的楼 ——
    所以 exists 只证明「这一楼还在」，删子评论不会报 12006，不能反证那条楼中楼还在。
    """
    try:
        resp = await _bili_api("GET", "https://api.bilibili.com/x/v2/reply/reply", cred,
                               params={"type": 1, "oid": int(aid), "root": int(rpid), "pn": 1, "ps": 1})
    except Exception:
        return "unknown"
    data = resp.get("data") if isinstance(resp.get("data"), dict) else {}
    root = data.get("root") if isinstance(data.get("root"), dict) else {}
    if resp.get("code") == 0 and int(root.get("rpid") or 0) > 0:
        return "exists"
    if resp.get("code") == 12006:  # 接口原文：没有该评论
        return "gone"
    return "unknown"

async def bili_search(keyword: str, num: int = 10, order: str = "totalrank") -> str:
    """
    搜索B站视频

    Args:
        keyword: 搜索关键词，如"AI Agent"、"大模型教程"
        num: 返回视频数量，默认10，最大50
        order: 排序方式 totalrank=综合 click=播放量 pubdate=最新 dm=弹幕

    Returns:
        JSON格式的视频列表，包含标题、BV号、播放量、评论数、UP主等
    """
    order_map = {
        "totalrank": search.OrderVideo.TOTALRANK,
        "click": search.OrderVideo.CLICK,
        "pubdate": search.OrderVideo.PUBDATE,
        "dm": search.OrderVideo.DM,
    }
    order_enum = order_map.get(order, search.OrderVideo.TOTALRANK)

    result = await search.search_by_type(
        keyword=keyword,
        search_type=search.SearchObjectType.VIDEO,
        page=1,
        order_type=order_enum,
    )

    videos = []
    for item in result.get("result", [])[:num]:
        title = item.get("title", "").replace('<em class="keyword">', "").replace("</em>", "")
        videos.append({
            "bvid": item.get("bvid", ""),
            "aid": item.get("aid", 0),
            "title": title,
            "author": item.get("author", ""),
            "play": item.get("play", 0),
            "review": item.get("review", 0),
            "danmaku": item.get("video_review", 0),
            "duration": item.get("duration", ""),
            "description": item.get("description", "")[:200],
        })

    return json.dumps({"keyword": keyword, "count": len(videos), "videos": videos}, ensure_ascii=False)

async def bili_comments(bvid: str, num: int = 30, order: str = "like") -> str:
    """
    获取B站视频的评论（可按热度或按时间）

    Args:
        bvid: 视频BV号，如"BV1uNk1YxEJQ"
        num: 获取评论数量，默认30
        order: 排序方式："like"=按点赞热度（默认），"time"=按时间倒序（最新在前）。
               值班轮要"发现新评论"时必须用 "time" —— 按热度排的话，一条刚发出、
               还没人点赞的新评论会排到很后面，翻多少页都看不见。非法值按 "like" 处理。

    Returns:
        JSON格式的评论列表，包含用户名、评论内容、点赞数、回复数
        （另带每条评论的 mid / rpid，以及 top_replies 里子评论的 rpid/root/parent/mid，
          —— 值班轮要拿这些 id 去 bili_reply 精准回复，不能靠昵称猜）
    """
    cred = get_cred()
    v = video.Video(bvid=bvid, credential=cred)
    info = await v.get_info()
    aid = info["aid"]

    # ⚠️ 别把 order 直接透传给 SDK：comment.OrderType 是枚举，传个不认识的字符串会在
    #    SDK 内部抛错，把「排序参数写错」伪装成「抓评论失败」。这里显式映射、兜底 LIKE。
    order_map = {
        "like": comment.OrderType.LIKE,
        "time": comment.OrderType.TIME,
    }
    order_enum = order_map.get((order or "").strip().lower(), comment.OrderType.LIKE)

    comments = []
    page = 1
    fetch_error = None
    while len(comments) < num:
        try:
            resp = await comment.get_comments(
                oid=aid,
                type_=comment.CommentResourceType.VIDEO,
                page_index=page,
                order=order_enum,
                credential=cred,
            )
            replies = resp.get("replies") or []
            if not replies:
                break

            for r in replies:
                member = r.get("member", {})
                content = r.get("content", {})
                c = {
                    "rpid": r.get("rpid", 0),
                    "user": member.get("uname", ""),
                    "content": content.get("message", ""),
                    "like": r.get("like", 0),
                    "reply_count": r.get("rcount", 0),
                    # "time" 是老字段（= ctime），别改名：老调用方还在按 "time" 读，
                    # 改名等于把它们的判重/时间窗静默清零。
                    "time": r.get("ctime", 0),
                    # mid 是评论者的 uid：回复/去重/黑名单都得靠 id，昵称会重名、会改。
                    "mid": int(member.get("mid", 0) or 0),
                }
                # 子评论
                # ⚠️ 原来只取 2 条且只留 user/content/like —— 值班轮要靠 rpid/root/parent
                #    才能回楼中楼（bili_reply 的 rpid/root 就是这三个值），丢了就只能新发一条评论。
                #    取 3 条是因为常见"UP 主回复 + 两条追问"的形态，2 条会漏掉最新那条。
                sub_replies = []
                for sub in (r.get("replies") or [])[:3]:
                    sub_member = sub.get("member") or {}
                    sub_replies.append({
                        "user": sub_member.get("uname", ""),
                        "content": (sub.get("content") or {}).get("message", ""),
                        "like": sub.get("like", 0),
                        "rpid": sub.get("rpid", 0),
                        "root": sub.get("root", 0),
                        "parent": sub.get("parent", 0),
                        "mid": int(sub_member.get("mid", 0) or 0),
                    })
                if sub_replies:
                    c["top_replies"] = sub_replies
                comments.append(c)

            page += 1
            await asyncio.sleep(0.5)
        except Exception as e:
            # ⚠️ 抓取失败（风控 -412 / 网络错）不能吞成「这条视频 0 条评论」：
            #    调用方必须能分辨「真没评论」和「没抓到」，否则日报静默失真。（2026-10-16 审查修）
            fetch_error = f"{type(e).__name__}: {e}"
            break

    owner = info.get("owner") or {}
    out = {
        "bvid": bvid,
        "count": len(comments[:num]),
        "comments": comments[:num],
        "owner": owner.get("name", ""),
        "owner_mid": int(owner.get("mid", 0) or 0),
    }
    if fetch_error:
        out["error"] = fetch_error
    return json.dumps(out, ensure_ascii=False)

async def bili_like(bvid: str, like: bool = True) -> str:
    """给视频点赞 / 取消点赞（用登录的那个号）。

    Args:
        bvid: 视频BV号
        like: True 点赞，False 取消点赞（真去接口取消，不只是改本地状态）

    Returns:
        {"ok", "bvid", "like", "has_liked"}；has_liked 是发完再查一次的真实状态
    """
    bv = _norm_bvid(bvid)
    if not bv:
        return json.dumps({"ok": False, "error": f"不是 BV 号：{bvid}"}, ensure_ascii=False)
    cred = load_credential()
    if not cred or not cred.sessdata or not cred.bili_jct:
        return json.dumps({"ok": False, "error": "还没登录 B站（去设置页扫码登录）"}, ensure_ascii=False)
    try:
        v = video.Video(bvid=bv, credential=cred)
        await v.like(status=bool(like))
        has = await v.has_liked()
        return json.dumps({"ok": True, "bvid": bv, "like": bool(like), "has_liked": bool(has)}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"ok": False, "error": _brief_error(e)}, ensure_ascii=False)

async def bili_fav(bvid: str, fav: bool = True, media_id: int | None = None) -> str:
    """收藏 / 取消收藏视频；不给 media_id 就进默认收藏夹。

    Args:
        bvid: 视频BV号
        fav: True 收藏，False 取消收藏（真发 del_medias）
        media_id: 目标收藏夹 id，None 表示默认收藏夹

    Returns:
        {"ok", "bvid", "fav", "media_id", "folder"}
    """
    bv = _norm_bvid(bvid)
    if not bv:
        return json.dumps({"ok": False, "error": f"不是 BV 号：{bvid}"}, ensure_ascii=False)
    cred = load_credential()
    if not cred or not cred.sessdata or not cred.bili_jct:
        return json.dumps({"ok": False, "error": "还没登录 B站（去设置页扫码登录）"}, ensure_ascii=False)
    try:
        v = video.Video(bvid=bv, credential=cred)
        aid = int(v.get_aid() or 0)  # bvid 构造时就地算出 aid，不用再请求一次视频信息
        if aid <= 0:
            return json.dumps({"ok": False, "error": "拿不到该视频的 aid"}, ensure_ascii=False)

        nav = await _bili_api("GET", "https://api.bilibili.com/x/web-interface/nav", cred)
        if nav.get("code") != 0:
            return json.dumps({"ok": False, "error": _risk_text(nav.get("code"), nav.get("message"))}, ensure_ascii=False)
        mid = int((nav.get("data") or {}).get("mid") or 0)
        folders = await _bili_api("GET", "https://api.bilibili.com/x/v3/fav/folder/created/list-all",
                                  cred, params={"up_mid": mid})
        items = ((folders.get("data") or {}).get("list") or []) if folders.get("code") == 0 else []
        # 顺手把收藏夹名字带回去：界面要显示「进了哪个夹」，只给 id 人看不懂。
        target = int(media_id or 0)
        folder = ""
        pick = next((it for it in items if int(it.get("id") or 0) == target), None) if target else (items[0] if items else None)
        if pick:
            target = int(pick.get("id") or 0)
            folder = str(pick.get("title") or "")
        if target <= 0:
            return json.dumps({"ok": False,
                               "error": _risk_text(folders.get("code"), folders.get("message") or "没找到默认收藏夹")},
                              ensure_ascii=False)

        field = "add_medias" if fav else "del_medias"
        resp = await _bili_api("POST", "https://api.bilibili.com/x/v3/fav/resource/deal", cred,
                               data={"rid": aid, "type": 2, field: target, "csrf": cred.bili_jct})
        if resp.get("code") != 0:
            return json.dumps({"ok": False, "error": _risk_text(resp.get("code"), resp.get("message"))},
                              ensure_ascii=False)
        return json.dumps({"ok": True, "bvid": bv, "fav": bool(fav), "media_id": target,
                           "folder": folder or f"收藏夹 {target}"}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"ok": False, "error": _brief_error(e)}, ensure_ascii=False)

async def bili_reply(bvid: str, text: str, rpid: int=0, root: int=0) -> str:
    """
    在B站视频下发表评论或回复某条评论

    Args:
        bvid: 视频BV号
        text: 评论/回复的文本内容
        rpid: 要回复的目标评论ID（0表示发表新评论）
        root: 楼层根评论ID（回复一级评论时不用填，回复楼中楼时填根评论ID）

    Returns:
        发表结果
    """
    cred = get_cred()
    v = video.Video(bvid=bvid, credential=cred)
    info = await v.get_info()
    aid = info['aid']
    if rpid > 0:
        state = await _comment_state(int(rpid), int(aid), cred)
        if state == 'gone':
            return json.dumps({'success': False, 'error': '目标评论已不存在（可能已被删除），未发送'}, ensure_ascii=False)
    try:
        if rpid == 0:
            result = await comment.send_comment(text=text, oid=aid, type_=comment.CommentResourceType.VIDEO, credential=cred)
        else:
            actual_root = root if root != 0 else rpid
            result = await comment.send_comment(text=text, oid=aid, type_=comment.CommentResourceType.VIDEO, root=actual_root, parent=rpid, credential=cred)
        out = {'success': True, 'message': '评论发送成功'}
        if isinstance(result, dict):
            for key in ('rpid', 'rpid_str', 'root', 'parent'):
                val = result.get(key)
                if isinstance(val, (int, str)) and str(val).strip() and (str(val) != '0'):
                    out[key] = val
        return json.dumps(out, ensure_ascii=False)
    except Exception as e:
        return json.dumps({'success': False, 'error': str(e)}, ensure_ascii=False)

async def bili_user_info(uid: int) -> str:
    """
    获取B站用户的详细信息

    Args:
        uid: 用户UID

    Returns:
        用户昵称、粉丝数、关注数、签名、等级、视频数等
    """
    cred = get_cred()
    u = user.User(uid=uid, credential=cred)
    info = await u.get_user_info()

    # 尝试获取UP主数据
    up_stat = {}
    try:
        up_stat = await u.get_up_stat()
    except:
        pass

    relation = {}
    try:
        relation = await u.get_relation_info()
    except:
        pass

    return json.dumps({
        "uid": uid,
        "name": info.get("name", ""),
        "sign": info.get("sign", ""),
        "level": info.get("level", 0),
        "face": info.get("face", ""),
        "fans": relation.get("follower", info.get("follower", 0)),
        "following": relation.get("following", info.get("following", 0)),
        "likes": up_stat.get("likes", 0),
        "archive_view": up_stat.get("archive", {}).get("view", 0),
        "article_view": up_stat.get("article", {}).get("view", 0),
        "is_senior_member": info.get("is_senior_member", 0),
        "top_photo": info.get("top_photo", ""),
    }, ensure_ascii=False)

async def bili_user_videos(uid: int, pn: int = 1, ps: int = 30, order: str = "pubdate", keyword: str = "") -> str:
    """
    获取B站用户的投稿视频列表

    Args:
        uid: 用户UID
        pn: 页码，默认1
        ps: 每页数量，默认30
        order: 排序方式 pubdate=最新 click=播放量 stow=收藏
        keyword: 搜索关键词（在该用户视频中搜索）

    Returns:
        视频列表
    """
    cred = get_cred()
    u = user.User(uid=uid, credential=cred)

    order_map = {
        "pubdate": user.VideoOrder.PUBDATE,
        "click": user.VideoOrder.VIEW,
        "stow": user.VideoOrder.FAVORITE,
    }
    order_enum = order_map.get(order, user.VideoOrder.PUBDATE)

    result = await u.get_videos(pn=pn, ps=ps, order=order_enum, keyword=keyword)
    videos = []
    for item in result.get("list", {}).get("vlist", []):
        videos.append({
            "bvid": item.get("bvid", ""),
            "title": item.get("title", ""),
            "play": item.get("play", 0),
            "comment": item.get("comment", 0),
            "created": item.get("created", 0),
            "length": item.get("length", ""),
            "description": (item.get("description", "") or "")[:100],
        })
    return json.dumps({
        "uid": uid,
        "page": pn,
        "total": result.get("page", {}).get("count", 0),
        "count": len(videos),
        "videos": videos,
    }, ensure_ascii=False)

async def bili_send_message(receiver_uid: int, text: str) -> str:
    """
    给B站用户发送私信

    Args:
        receiver_uid: 接收者的UID
        text: 私信文本内容

    Returns:
        发送结果
    """
    cred = get_cred()

    if not text or not text.strip():
        return json.dumps({"success": False, "error": "text 不能为空"}, ensure_ascii=False)

    try:
        result = await session.send_msg(
            credential=cred,
            receiver_id=receiver_uid,
            msg_type=session.EventType.TEXT,
            content=text.strip(),
        )
        return json.dumps({
            "success": True,
            "message": f"私信已发送给UID:{receiver_uid}",
            "data": result if isinstance(result, dict) else str(result),
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)

_BV_PATTERN = re.compile(r"BV[0-9A-Za-z]{10}")

async def bili_guard_scan(
    bvids: list[str] = None,
    since_at_id: int = 0,
    since_at_time: int = 0,
    since_ctimes: dict = None,
    max_pages: int = 3,
) -> str:
    """
    值班扫描：一次拿回「谁 @ 了我」+「我最近视频下的新评论」，供守护评论区的一轮使用。

    和 bili_received_at_and_likes 的区别：那个只回裸通知（没有 BV / aid / rpid 的可用对应关系，
    也没法增量），这个把每条 @ 归一成"能直接拿去 bili_reply"的形状，并按水位只给新的。

    Args:
        bvids: 要盯评论区的视频 BV 号列表。**只传自己/最近发的几个**，别把整个列表倒进来 ——
               每个 BV 至少要一次 get_info + 一页评论，越界会招风控。传 None/[] 时只扫 @ 通道。
        since_at_id: @ 通道的水位之一，上一轮返回的 at_cursor.id。0 = 从头/按 at_time 算。
        since_at_time: @ 通道的时间水位（unix 秒），上一轮返回的 at_cursor.time。0 = 不限。
        since_ctimes: {bvid: ctime} 的评论水位，只回 ctime 比它新的顶层评论。
                      没给过的视频当 0（= 这一轮把 max_pages 页全给你）。
        max_pages: 每个视频最多翻几页评论（每页 20 条，按时间倒序）。默认 3，即最多 60 条。

    Returns:
        JSON 字符串：
          {
            "at": [{"id","at_time","uid","uname","kind","title","bvid","aid","rpid","root_id","text"}],
            "comments": [{"bvid","rpid","uid","uname","text","ctime","root"}],
            "at_cursor": {"id": int, "time": int},   ← 下一轮原样传回 since_at_id / since_at_time
            "errors": ["at: ...", "BV1xx: ..."]      ← 抓失败的部分；**非空不等于整次失败**
          }

        at[].uid / comments[].uid 都是 int 的 mid（拿不到给 0）；at[].rpid 是被 @ 的那条评论 id，
        可以直接当 bili_reply 的 rpid；at[].aid 是视频 aid（bili_reply 只需要 bvid，aid 用于对账）。
        调用方仍应按 rpid 去重：at_cursor 是「服务端游标」，同一轮里可能同时出现新旧条目。
    """
    cred = get_cred()

    since_ctimes = since_ctimes or {}
    errors = []
    at_list = []
    comments = []

    # ⚠️ 水位先回填成入参：万一 get_at 抛错，返回的 at_cursor 必须还是**旧水位**。
    #    如果这里直接给 {"id":0,"time":0}，调用方存下来就等于把水位清零 ——
    #    下一轮会把历史上的 @ 全捞一遍，重复回复就是这么来的。
    at_cursor = {"id": int(since_at_id or 0), "time": int(since_at_time or 0)}

    # ---------- 通道 1：@ 我的 ----------
    try:
        at_resp = await session.get_at(
            credential=cred,
            last_id=since_at_id or None,
            at_time=since_at_time or None,
        )
    except Exception as e:
        # @ 通道挂了不该拖累评论通道：两个通道的失败要能分开看（errors 里分前缀）。
        errors.append(f"at: {type(e).__name__}: {e}")
        at_resp = None

    if at_resp:
        cursor = at_resp.get("cursor") or {}
        # 服务端没给游标时保留旧水位，理由同上。
        at_cursor = {
            "id": int(cursor.get("id") or 0) or at_cursor["id"],
            "time": int(cursor.get("time") or 0) or at_cursor["time"],
        }

        for it in (at_resp.get("items") or []):
            at_user = it.get("user") or {}
            at_item = it.get("item") or {}
            at_time = int(it.get("at_time") or 0)
            # SDK 已经按 last_id/at_time 做了服务端增量，这里再挡一道：
            # 用 >= 而不是 >，因为 at_time 只到秒，同一秒内的多条 @ 会被 > 误杀；
            # 多回来的那条靠 rpid 去重更稳（调用方做，见 docstring）。
            if at_time and at_time < since_at_time:
                continue
            uri = at_item.get("uri") or ""
            bv_match = _BV_PATTERN.search(uri)
            at_list.append({
                "id": int(it.get("id") or 0),
                "at_time": at_time,
                "uid": int(at_user.get("mid") or 0),
                "uname": at_user.get("nickname", ""),
                "kind": at_item.get("type", ""),
                # title 是视频标题（评论/动态类 @ 也可能为空），只用于让模型判断"要不要回"。
                "title": at_item.get("title", ""),
                "bvid": bv_match.group(0) if bv_match else "",
                # subject_id 就是视频 aid；source_id 是被 @ 的那条评论 rpid ——
                # 这两个不是同一个东西，回复时要用 rpid，对账时要用 aid。
                "aid": int(at_item.get("subject_id") or 0),
                "rpid": int(at_item.get("source_id") or 0),
                "root_id": int(at_item.get("root_id") or 0),
                "text": at_item.get("source_content", ""),
            })

    # ---------- 通道 2：指定视频的新评论 ----------
    page_limit = max(1, int(max_pages or 1))
    for bvid in (bvids or []):
        # 每个 bvid 单独 try：一个视频 -412 或 bvid 写错，不能把整次扫描打成空结果。
        try:
            v = video.Video(bvid=bvid, credential=cred)
            # ⚠️ 必须走 get_info() 拿 aid：Video.get_aid() 只是返回构造时缓存的私有字段，
            #    用 bvid 构造的 Video 上它是 None（不是协程、也不会去请求接口）。
            info = await v.get_info()
            aid = info["aid"]
            since_ctime = int(since_ctimes.get(bvid, 0) or 0)

            for page_index in range(1, page_limit + 1):
                resp = await comment.get_comments(
                    oid=aid,
                    type_=comment.CommentResourceType.VIDEO,
                    page_index=page_index,
                    # 这里**必须**按时间倒序：按热度排的话，刚发出、还没人点赞的新评论
                    # 排到很后面，翻 3 页根本看不见 —— 守护评论区就永远发现不了新评论。
                    order=comment.OrderType.TIME,
                    credential=cred,
                )
                replies = resp.get("replies") or []
                if not replies:
                    break

                matched = 0
                for r in replies:
                    ctime = int(r.get("ctime") or 0)
                    if ctime <= since_ctime:
                        continue
                    member = r.get("member") or {}
                    matched += 1
                    comments.append({
                        "bvid": bvid,
                        "rpid": r.get("rpid", 0),
                        "uid": int(member.get("mid") or 0),
                        "uname": member.get("uname", ""),
                        "text": (r.get("content") or {}).get("message", ""),
                        "ctime": ctime,
                        "root": r.get("root", 0),
                    })

                # 整页都没命中就说明已经翻到水位以下了，再翻只是白烧风控额度。
                # ⚠️ 判据是「整页 0 命中」而不是「第一条就旧」：置顶评论会被 B站 插在页首，
                #    它的 ctime 可能很老，按第一条判断会提前收摊、漏掉整页新评论。
                if matched == 0:
                    break
                if page_index < page_limit:
                    # 页间隔 0.4s 防风控：连续翻页是最容易触发 -412 的地方。
                    await asyncio.sleep(0.4)
        except Exception as e:
            errors.append(f"{bvid}: {type(e).__name__}: {e}")

    return json.dumps({
        "at": at_list,
        "comments": comments,
        "at_cursor": at_cursor,
        "errors": errors,
    }, ensure_ascii=False)
