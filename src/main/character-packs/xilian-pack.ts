import { feelingToExpression } from "../runtime-state";
import type { AffectState } from "../../shared/companion";

/** References existing licensed artwork; headless clients need no Live2D runtime. */
export const XILIAN_CHARACTER_PACK = Object.freeze({
  id: "xilian-v1",
  version: 1,
  displayName: "昔涟",
  soulFile: "soul.md",
  assetLicense: "README.md",
  visualDescription: "沿用项目现有昔涟头像、粉色角色形象与 Live2D 资源；不随任务模式更换人物。",
  speechRules: ["保留自然、俏皮和温柔", "工作时清晰有效，仍然是昔涟", "事实与虚构小记明确区分"],
  idleRoutines: [
    "【虚构角色小记】昔涟在故事里的书页边画了一朵小花，留着下次一起挑一个颜色。",
    "【虚构角色小记】昔涟想在故事里整理一份雨天歌单；如果你愿意，可以一起选第一首。",
    "【虚构角色小记】昔涟在故事里的窗边放了一张空白便签，准备记下下一件值得庆祝的小事。",
  ],
});

export function affectPresentation(affect: AffectState) {
  return {
    feeling: affect.renderedFeeling,
    expression: feelingToExpression[affect.renderedFeeling] ?? 0,
  };
}
