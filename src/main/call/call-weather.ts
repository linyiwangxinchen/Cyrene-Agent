const weatherTopic = /天气|气温|下雨|下雪|(?:带|拿)伞|多少度|几度|穿什么/u;
const weatherQuestion = /(?:吗|么|呢|怎么样|如何|多少度|几度|穿什么|[？?])[\s。！!？?]*$/u;
const weatherRequest = /^(?:请|能不能|可不可以)?(?:帮我)?(?:查一?下|查查|查|看一?下|看看)/u;
const knownCity = /北京|上海|广州|深圳|成都|杭州|南京|武汉|西安|重庆|天津|苏州|无锡|长沙|郑州|青岛|大连|沈阳|哈尔滨|长春|济南|太原|合肥|南昌|福州|昆明|贵阳|拉萨|乌鲁木齐|呼和浩特/u;

export function isCallWeatherRequest(text: string): boolean {
  if (/^[\p{Script=Han}]{2,8}(?:的)?(?:天气|气温)[。？?]?$/u.test(text) || /^(?:天气|气温)[。？?]?$/u.test(text)) return true;
  if (/^(?:今天|外面|现在)?(?:冷不冷|热不热)[。？?]?$/u.test(text)) return true;
  if (!weatherTopic.test(text)) return false;
  return weatherRequest.test(text)
    || weatherQuestion.test(text);
}

export function getCallWeatherCity(text: string): string {
  const known = text.match(knownCity)?.[0];
  if (known) return known;
  const city = text.replace(weatherRequest, "").match(/^([\p{Script=Han}]{2,8}?)(?:的)?(?:天气|气温)/u)?.[1];
  return city && !/^(?:今天|明天|后天|今晚|今夜|现在|这儿|这里|外面|本地|当地|最近|一会儿)/u.test(city) ? city : "";
}

/** Summarize the weather tool's current conditions for the same spoken reply and transcript. */
export function toSpokenCallWeather(result: string): string {
  if (result.startsWith("[提示] 没有指定城市")) return "你想问哪个城市的天气？";
  if (result.startsWith("[错误] 找不到城市")) return "我没找到这个地方。你再说一遍城市名好吗？";
  if (result.startsWith("[错误] 天气查询功能未启用")) return "天气查询还没开，要在设置里打开。";
  try {
    const { city, weather, temperature, cached } = JSON.parse(result) as {
      city?: unknown; weather?: unknown; temperature?: unknown; cached?: unknown;
    };
    if (typeof city === "string" && city && typeof weather === "string" && weather
      && typeof temperature === "number" && Number.isFinite(temperature)) {
      const timing = cached === true ? "最近一次查到" : "现在查到";
      return timing + city + "，" + weather + "，" + temperature + "度。";
    }
  } catch {
    // Weather errors are free-form diagnostics and should never be spoken verbatim.
  }
  return "天气暂时没查到。";
}
