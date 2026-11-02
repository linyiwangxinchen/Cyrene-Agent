"""Bounded @-notification polling with separate new-message and paging cursors."""
import asyncio
import re
from bilibili_api import video


def positive_int(value):
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError, OverflowError):
        return 0


def cursor(value):
    value = value if isinstance(value, dict) else {}
    return {"id": positive_int(value.get("id")), "time": positive_int(value.get("time"))}


def order(value):
    return value["time"], value["id"]


def normalize_mention(item, credential):
    detail = item.get("item") or {}
    author = item.get("user") or {}
    if not isinstance(detail, dict) or not isinstance(author, dict):
        return None
    business = positive_int(detail.get("business_id"))
    if business and business != 1:
        return None  # A dynamic/article/danmaku mention is not a video comment.
    if detail.get("type") in ("dynamic", "article", "danmu", "live"):
        return None
    uri = str(detail.get("uri") or "") + " " + str(detail.get("native_uri") or "")
    match = re.search(r"BV[0-9A-Za-z]{10}", str(detail.get("bvid") or "") + " " + uri)
    av = re.search(r"(?:/video/av|/video/)(\d+)", uri)
    aid = positive_int(detail.get("subject_id")) if business == 1 else 0
    aid = aid or (positive_int(av.group(1)) if av else 0)
    rpid = positive_int(detail.get("source_id"))
    if not rpid or (not match and not aid):
        return None
    try:
        target = video.Video(bvid=match.group(0), credential=credential) if match else video.Video(aid=aid, credential=credential)
    except Exception:
        return None
    return {
        "id": positive_int(item.get("id")), "at_time": positive_int(item.get("at_time")),
        "uid": positive_int(author.get("mid")), "uname": str(author.get("nickname") or ""),
        "kind": str(detail.get("type") or "reply"), "title": str(detail.get("title") or ""),
        "bvid": target.get_bvid(), "aid": target.get_aid(), "rpid": rpid,
        "root_id": positive_int(detail.get("root_id")), "text": str(detail.get("source_content") or ""),
    }


async def scan_mentions(credential, get_at, since_id=0, since_time=0, resume=None, max_pages=3):
    floor = cursor({"id": since_id, "time": since_time})
    resume = resume if isinstance(resume, dict) else None
    page = cursor(resume) if resume else None
    if page and not page["id"] and not page["time"]:
        page = None
    head = max((floor, cursor(resume.get("head"))), key=order) if page else dict(floor)
    items, errors, seen = [], [], set()
    stats = {"pages": 0, "received": 0, "unsupported": 0}
    complete = False
    page_limit = max(1, min(10, positive_int(max_pages) or 1))
    for page_index in range(page_limit):
        try:
            # last_id/at_time mean "older than this page", not "newer than this watermark".
            response = await get_at(credential=credential, last_id=(page["id"] or None) if page else None,
                                    at_time=(page["time"] or None) if page else None)
            if not isinstance(response, dict) or not isinstance(response.get("items", []), list):
                raise ValueError("Invalid mention page")
        except Exception as error:
            errors.append(f"at: {type(error).__name__}")
            break
        stats["pages"] += 1
        raw_items = response.get("items") or []
        reached_floor = False
        for raw in raw_items:
            if not isinstance(raw, dict):
                stats["unsupported"] += 1
                continue
            mark = cursor({"id": raw.get("id"), "time": raw.get("at_time")})
            head = max((head, mark), key=order)
            older = (mark["time"] < floor["time"] if mark["time"] and floor["time"]
                     else bool(floor["id"] and mark["id"] and mark["id"] < floor["id"]))
            if older:
                reached_floor = True
                continue
            key = (mark["id"], mark["time"])
            if key in seen:
                continue
            seen.add(key)
            stats["received"] += 1
            normalized = normalize_mention(raw, credential)
            if normalized:
                items.append(normalized)
            else:
                stats["unsupported"] += 1
        raw_cursor = response.get("cursor") if isinstance(response.get("cursor"), dict) else {}
        next_page = cursor(raw_cursor)
        if not raw_items or reached_floor or raw_cursor.get("is_end") or not (next_page["id"] or next_page["time"]):
            complete = True
            break
        if page == next_page:
            errors.append("at: repeated pagination cursor")
            break
        page = next_page
        if page_index + 1 < page_limit:
            await asyncio.sleep(0.4)
    # A budget-limited scan resumes the backlog next time. New arrivals since its
    # fixed head are picked up by the next fresh scan after the backlog completes.
    continuation = {**page, "head": head} if not complete and page else None
    return {"at": items, "at_cursor": head if complete else floor, "at_resume": continuation,
            "at_stats": stats, "errors": errors}
