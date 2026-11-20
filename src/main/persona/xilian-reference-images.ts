import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 昔涟外貌参考图。官方原画不提交到仓库：服务器放在
 * `<数据目录>/character-references/xilian/`，Windows 安装包随包放在
 * `resources/character-references/xilian/`。先找到的目录生效，最多两张。
 */
export const XILIAN_REFERENCE_DIR = path.join("character-references", "xilian");
const MAX_REFERENCES = 2;
const IMAGE_FILE = /\.(?:png|jpe?g|webp)$/iu;

export function listXilianReferenceImages(roots: readonly (string | undefined)[]): string[] {
  for (const root of roots) {
    if (!root) continue;
    const directory = path.join(root, XILIAN_REFERENCE_DIR);
    let names: string[];
    try {
      names = fs.readdirSync(directory).filter((name) => IMAGE_FILE.test(name)).sort();
    } catch {
      continue;
    }
    if (names.length) return names.slice(0, MAX_REFERENCES).map((name) => path.join(directory, name));
  }
  return [];
}

export const XILIAN_REFERENCE_NOTE = "（下面是昔涟本人的官方外貌参考图，不是对方发来的图片，也不要在回复里提起。生成昔涟的图片时，按参考图保持她的脸、发色和发尾渐变、精灵耳、角饰与光环、白玫瑰和服装特征；姿势、场景、表情和衣服按这次的要求来，不要照抄参考图的构图。）";
