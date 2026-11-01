"""Private stdio bridge. No listening socket, credential file or arbitrary tool name."""
import asyncio
import base64
import io
import json
import os
from pathlib import Path
import sys

ALLOWED = {
    'bili_search', 'bili_comments', 'bili_user_info', 'bili_user_videos',
    'bili_reply', 'bili_send_message', 'bili_like', 'bili_fav', 'bili_guard_scan',
}
def get_backend(credential):
    import bilibili_backend as backend
    from bilibili_api import Credential
    cred = Credential(**{k: str(credential.get(k, '')) for k in ('sessdata', 'bili_jct', 'buvid3', 'dedeuserid')})
    return backend, cred


async def video_data(name, args, cred):
    from bilibili_api import video
    import aiohttp
    v = video.Video(bvid=args['bvid'], credential=cred)
    info = await v.get_info()
    meta = {'bvid': info['bvid'], 'title': info.get('title', ''), 'owner': info.get('owner', {}).get('name', ''),
            'ownerUid': str(info.get('owner', {}).get('mid', '')), 'cover': info.get('pic', ''),
            'duration': info.get('duration', 0), 'views': info.get('stat', {}).get('view', 0),
            'description': info.get('desc', ''), 'published': info.get('pubdate', 0)}
    if name == 'video':
        return meta
    cid = info.get('cid') or (info.get('pages') or [{}])[0].get('cid')
    subtitles = (await v.get_subtitle(cid=cid)).get('subtitles', []) if cid else []
    if not subtitles:
        return {**meta, 'segments': [], 'text': '', 'source': 'subtitle'}
    sub = next((s for s in subtitles if s.get('lan') in ('ai-zh', 'zh-CN', 'zh')), subtitles[0])
    url = sub.get('subtitle_url', '')
    if url.startswith('//'):
        url = 'https:' + url
    from urllib.parse import urlparse
    parsed = urlparse(url)
    if parsed.scheme != 'https' or not any(parsed.hostname == h or parsed.hostname.endswith('.' + h) for h in ('bilibili.com', 'hdslb.com', 'biliapi.net')):
        raise ValueError('字幕地址不是支持的 B 站资源')
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session:
        async with session.get(url, allow_redirects=False) as response:
            response.raise_for_status()
            data = await response.json(content_type=None)
    segments = [{'from': float(s.get('from', 0)), 'to': float(s.get('to', 0)), 'text': str(s.get('content', ''))[:2000]}
                for s in data.get('body', [])[:6000]]
    return {**meta, 'segments': segments, 'text': '\n'.join(s['text'] for s in segments)[:180000], 'source': 'subtitle'}


def transcribe(args, home):
    from yt_dlp import YoutubeDL
    from asr_model import load_model
    import tempfile
    bvid = args['bvid']
    os.environ.setdefault('HF_HOME', str(home / 'model-cache'))
    model_name = args.get('model', 'small')
    if model_name not in ('tiny', 'base', 'small', 'medium'):
        raise ValueError('转写模型无效')
    model = load_model(home, model_name)
    with tempfile.TemporaryDirectory(prefix='audio-', dir=home) as tmp:
        opts = {'format': 'bestaudio/best', 'outtmpl': str(Path(tmp) / 'audio.%(ext)s'), 'noplaylist': True,
                'quiet': True, 'no_warnings': True, 'cachedir': False,
                'http_headers': {'Referer': 'https://www.bilibili.com/'}}
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info('https://www.bilibili.com/video/' + bvid, download=True)
            audio = ydl.prepare_filename(info)
        items, _ = model.transcribe(audio, language='zh', vad_filter=True)
        segments = [{'from': s.start, 'to': s.end, 'text': s.text} for s in items]
        return {'bvid': bvid, 'segments': segments[:6000], 'text': '\n'.join(s['text'] for s in segments)[:180000], 'source': 'asr'}


async def dispatch(message):
    name, args = message.get('name'), message.get('args', {})
    if name == 'qr':
        import qrcode
        out = io.BytesIO()
        qrcode.make(str(args['url'])).save(out, format='PNG')
        return {'image': 'data:image/png;base64,' + base64.b64encode(out.getvalue()).decode()}
    if name not in ALLOWED | {'video', 'subtitle', 'transcribe'}:
        raise ValueError('该操作不在小花园允许的接口中')
    import re
    if 'bvid' in args and not re.fullmatch(r'BV[0-9A-Za-z]{10}', str(args['bvid'])):
        raise ValueError('BV 号无效')
    credential = message.get('credential') or {}
    if not credential.get('sessdata'):
        raise ValueError('请先扫码登录 B 站')
    if name == 'transcribe':
        return transcribe(args, Path.cwd())
    module, cred = get_backend(credential)
    if name in ('video', 'subtitle'):
        return await video_data(name, args, cred)
    for key in ('receiver_uid', 'uid', 'rpid', 'root'):
        if key in args:
            args[key] = int(args[key])
    token = module.credential_context.set(cred)
    try:
        result = await getattr(module, name)(**args)
        return json.loads(result) if isinstance(result, str) else result
    finally:
        module.credential_context.reset(token)


async def main():
    while True:
        line = sys.stdin.readline()
        if not line:
            return
        request_id = None
        try:
            if len(line) > 1000000:
                raise ValueError('请求过大')
            message = json.loads(line)
            request_id = message.get('id')
            result = await dispatch(message)
            answer = {'id': request_id, 'result': result}
        except Exception as error:
            # Never emit a traceback or request/credential payload to the UI.
            code = getattr(error, 'code', '')
            detail = str(error) if isinstance(error, (ValueError, ModuleNotFoundError)) else type(error).__name__
            answer = {'id': request_id, 'error': f'{code} {detail}'.strip()}
        sys.stdout.write(json.dumps(answer, ensure_ascii=False) + '\n')
        sys.stdout.flush()


if __name__ == '__main__':
    asyncio.run(main())
