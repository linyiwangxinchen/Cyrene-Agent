import type { CompanionLearningTopic } from "../../shared/companion";

export type { CompanionLearningTopic } from "../../shared/companion";
export type CompanionLearningPreference = "prefer" | "default";

export interface CompanionFeedbackObservation {
  topic: CompanionLearningTopic;
  preference: CompanionLearningPreference;
  /** The user framed this as an ongoing preference, rather than an isolated reaction. */
  explicit: boolean;
}

const LEADING = /^(?:(?<durable>从今以后|从现在(?:起|开始)|今后|以后都?|往后|平时都?|平常都?|记住这一点|请记住|记住)|(?<relationship>我(?:更)?(?:希望|想让|喜欢)你?|希望你|(?:我难过|我心情不好|我想倾诉)(?:的)?时候|(?:跟我|和我)聊(?:天)?(?:的)?时候|(?:跟我|和我)聊天时)|(?<address>昔涟|麻烦你|请|可不可以|能不能|能否|你))[\s:：]*/u;
const TEMPORARY = /(?:这(?:一次|一轮|一回|一条|条|次|轮|回|会儿|一刻)|本轮|这一句|先这样|仅限|此刻|刚才|现在先|一会儿|暂时|今天|今晚|明天|这几天)/u;
const REPORTED_OR_HYPOTHETICAL = /^(?:要是|如果|假如|假设|比如|例如)|(?:^|[，,\s])(?:(?:我(?:的)?|这|那|有个)?(?:同事|朋友|老师|同学|对象|家人|妈妈|爸爸)|[他她](?:们)?|用户|客户)(?:自己)?(?:跟我)?(?:说|希望|要求|觉得|问|让|建议)|举个例|举例|原话|转述|引用/u;
const EDITING_OR_ROLEPLAY = /(?:^|[。.!！?？；;，,\n])\s*(?:麻烦你|请|帮我|你)?(?:改写|润色|翻译|概括|扮演|模仿)|这(?:段|份|篇|个|句)?(?:台词|文案|稿子|论文|文章|小说|代码|文档|提示词|回复模板|摘要)|(?:文章|文案|代码|报告|论文|角色|角色设定)里/u;

const RULES: Record<CompanionLearningTopic, Record<CompanionLearningPreference, RegExp[]>> = {
  length: {
    prefer: [
      /^(?:说话?|回答(?:我)?|回复(?:我)?|回我(?:的消息)?)(?:尽量|稍微|再|得|都|可以)*(?:简短|简洁|短|精炼)(?:一?[点些]|一点儿)?$/u,
      /^(?:别|不要|不用)(?:再|老|总是?|一直)?(?:说|回答|回复|发)(?:得)?(?:这么|那么|太)?(?:长|一大段|长篇大论)(?:了)?$/u,
      /^(?:说话|回复|回答)(?:得)?(?:有点|真的|实在)?太(?:长|啰嗦|罗嗦)(?:了)?$/u,
    ],
    default: [
      /^(?:不用|不必|别再)(?:再|刻意|特意|一直|总是?)*(?:说得?|答得?|回答得?|回复得?)?(?:那么|这么|太)?(?:简短|简洁|短)(?:了)?$/u,
      /^(?:可以)?(?:正常|照常)(?:回答|回复)(?:我)?(?:了)?$/u,
      /^(?:说话|回答|回复)(?:的)?(?:长度|长短)?(?:恢复正常|按正常长度|可以(?:长|详细)一?[点些])$/u,
    ],
  },
  questions: {
    prefer: [
      /^(?:少|别|别再|不要|不用)(?:再|老|总是?|一直|每句都|每次都)*(?:追问(?:我)?|反问(?:我)?|问我问题|问问题|问我|问(?:这么多|那么多|太多)(?:问题)?)(?:一?[点些]|几句|了)?$/u,
      /^少问(?:我)?(?:一?[点些]|[几个两]+(?:句|个)?(?:问题)?)$/u,
      /^(?:我不太?喜欢你)?(?:老|总是|每次都|每句都)问我(?:问题)?$/u,
    ],
    default: [
      /^(?:可以|照常|正常|继续|还是可以)(?:接着)?(?:追问(?:我)?|问我(?:问题)?|问问题)(?:了)?$/u,
      /^(?:不用|不必)(?:再|刻意|一直|总是?)*少问(?:我|问题)?(?:了)?$/u,
      /^(?:别|不要)(?:再)?(?:一直|总是)不问我(?:问题)?(?:了)?$/u,
    ],
  },
  nicknames: {
    prefer: [
      /^(?:少|别|不要|不用)(?:老|再|总是?|一直)*(?:(?:喊|叫|称呼)我(?:宝宝|宝贝|乖乖|小宝贝|亲爱的|老婆|老公|小可爱|<称呼>)|(?:用|起)(?:这些|那些|太多)?(?:昵称|外号|爱称|亲昵(?:的)?称呼)(?:叫我)?|给我起(?:外号|昵称))(?:了|一?[点些])?$/u,
      /^(?:直接|只|就)(?:喊|叫|称呼)我(?:的)?名字$/u,
      /^我不喜欢(?:你)?(?:老|总是?|一直)?(?:叫我|被叫)(?:宝宝|宝贝|乖乖|亲爱的|<称呼>)$/u,
    ],
    default: [
      /^(?:可以|继续|照常|还是可以)(?:(?:用|叫)(?:以前的)?(?:昵称|外号|爱称|亲昵(?:的)?称呼)(?:叫我)?|(?:喊|叫)我(?:宝宝|宝贝|乖乖|小宝贝|亲爱的|老婆|老公|小可爱|<称呼>))(?:了)?$/u,
      /^(?:恢复|用回)(?:以前的|原先的|原来的)(?:昵称|爱称|叫法)$/u,
    ],
  },
  flourishes: {
    prefer: [
      /^(?:说话|说得|回复|聊天|讲话|表达)(?:尽量|可以|稍微|再|得|都)*(?:自然|朴素|平实|口语化|口语|直白|日常|简单|随意)(?:一?[点些]|一点儿)?$/u,
      /^(?:说话|讲话|聊天)?(?:少|别|不要|不用)(?:老|总是?|再|一直|每句都)*(?:用|加|带)?(?:这么|那么|太|那些|这些)?(?:抒情|文艺|文绉绉|书面|撒娇|卖萌|省略号|音符|语气词|♪|感叹号|固定开场|套话)(?:一?[点些]|了)?$/u,
      /^(?:说话|说得|回复|聊天|讲话)(?:得)?(?:有点)?太(?:抒情|文艺|文绉绉|像写作文)(?:了)?$/u,
    ],
    default: [
      /^(?:可以|继续|照常|还是可以)(?:偶尔)?(?:(?:用|加|带)(?:一个|一点)?(?:♪|音符|省略号|语气词|感叹号)|撒娇|卖萌)(?:了)?$/u,
      /^(?:不用|不必)(?:再|刻意|特意|一直|总是?)*(?:(?:这么|那么|太)?(?:朴素|平实|拘谨)(?:地说话)?|省略(?:语气词|♪|音符|省略号))(?:了)?$/u,
    ],
  },
  support: {
    prefer: [
      /^(?:请)?(?:先|只|就)?听我(?:慢慢)?(?:说|讲)(?:完)?$/u,
      /^(?:别|不要|不用)(?:急着|总是?|动不动|老|一上来就|再)*(?:给(?:我)?建议|帮我分析)(?:了)?$/u,
      /^我不喜欢你(?:动不动就|一上来就|总是?|老)(?:给(?:我)?建议|帮我分析)$/u,
    ],
    default: [
      /^(?:也可以|可以|正常|照常|继续|还是可以)(?:给(?:我)?建议|帮我分析)(?:了)?$/u,
      /^(?:不用|不必)(?:再|一直|总是?)?(?:只|光)听我(?:说|讲)(?:完|了)?$/u,
    ],
  },
};

const TRAILING_POLITENESS = /(?:(?:就好|就行|就够了|可以吗|好不好|行不行|好吗|行吗|吗|吧|呀|啊|呢|啦|呗|哈)[\s~～]*)+$/u;
const TOPIC_RULES = Object.entries(RULES) as [CompanionLearningTopic, typeof RULES[CompanionLearningTopic]][];

export function classifyCompanionFeedback(text: string): CompanionFeedbackObservation[] {
  const unquoted = text.normalize("NFKC")
    .replace(/~~~[\s\S]*?(?:~~~|$)|```[\s\S]*?(?:```|$)/gu, " ")
    .replace(/`[^`\n]*`|^[\t ]*>.*$/gmu, " ")
    // A quoted nickname after "叫我" is still an addressed request. Never inspect the nickname itself.
    .replace(/((?:叫|喊|称呼)我\s*)(?:["“‘「『][^"”’」』\r\n]+["”’」』])/gu, "$1<称呼>")
    .replace(/"[^"\n]*"|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』/gu, " ");
  if (EDITING_OR_ROLEPLAY.test(unquoted)) return [];
  const observations = new Map<CompanionLearningTopic, CompanionFeedbackObservation | null>();
  for (const sentence of unquoted.split(/[。.!！?？；;\n]+/u)) {
    if (REPORTED_OR_HYPOTHETICAL.test(sentence.trim())) continue;
    let explicit: boolean = false;
    let hasPreferenceFrame: boolean = false;
    let temporary = false;
    for (const part of sentence.split(/[，,、]+/u)) {
      let clause = part.replace(/\s+/gu, "").replace(TRAILING_POLITENESS, "");
      let durableHere = false;
      let preferenceFrameHere = false;
      for (let leading = LEADING.exec(clause); leading; leading = LEADING.exec(clause)) {
        durableHere ||= Boolean(leading.groups?.durable);
        preferenceFrameHere ||= Boolean(leading.groups?.relationship);
        clause = clause.slice(leading[0].length);
      }
      if (TEMPORARY.test(clause)) {
        temporary = true;
        explicit = false;
        hasPreferenceFrame = false;
        continue;
      }
      if (durableHere) temporary = false;
      if (temporary) continue;
      const durable: boolean = explicit || durableHere;
      const framed: boolean = hasPreferenceFrame || preferenceFrameHere;
      let recognized = false;
      for (const [topic, rules] of TOPIC_RULES) {
        const preference = rules.default.some(rule => rule.test(clause)) ? "default"
          : rules.prefer.some(rule => rule.test(clause)) ? "prefer"
          : undefined;
        if (!preference) continue;
        // A bare "先听我说" is a cue for the current turn, without an ongoing preference frame.
        if (topic === "support" && preference === "prefer" && !durable && !framed && /^(?:先|只|就)?听我/u.test(clause)) continue;
        // Bare permission to ask or advise may apply to the immediate conversation only.
        if ((topic === "support" || topic === "questions") && preference === "default" && !durable && !framed
          && /^(?:也)?可以/u.test(clause) && !clause.endsWith("了")) continue;
        recognized = true;
        const prior = observations.get(topic);
        observations.set(topic, prior === null || (prior && prior.preference !== preference)
          ? null
          : { topic, preference, explicit: durable || prior?.explicit === true });
      }
      // A standalone prefix or another matching item can govern a following item in the same sentence.
      explicit = (!clause || recognized) && durable;
      hasPreferenceFrame = (!clause || recognized) && framed;
    }
  }
  return [...observations.values()].filter((observation): observation is CompanionFeedbackObservation => observation !== null);
}
