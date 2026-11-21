// .gitignore 规则解析与匹配（纯字符串运算，不读文件、不起 git 子进程）。
//
// 覆盖 glob 工具需要的常用语义：注释与空行、`!` 取反、尾部 `/` 只匹配目录、
// 含 `/` 的模式相对 .gitignore 所在目录锚定、`*` `?` `[...]` `**`。
// 规则按出现顺序求值，最后一条命中的规则决定结果（与 git 一致）。
// 父目录被忽略后其下文件不再单独判断——调用方在遍历时剪枝目录即可得到 git 的
// "无法重新包含被忽略目录下的文件" 语义。

export interface GitignoreRule {
  /** 规则所在 .gitignore 的目录，相对工作区根，POSIX 分隔；根目录为 ""。 */
  base: string;
  negate: boolean;
  dirOnly: boolean;
  regex: RegExp;
}

/** 把 gitignore 片段（不含首尾 `/`）编译成正则；`*` 与 `?` 可以匹配以点开头的名字。 */
function compileSegmentPattern(pattern: string): string {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) {
      out += escapeRegex(pattern[i + 1]);
      i += 2;
      continue;
    }
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        const atStart = i === 0 || pattern[i - 1] === "/";
        const atEnd = i + 2 === pattern.length || pattern[i + 2] === "/";
        if (atStart && atEnd) {
          if (i + 2 === pattern.length) {
            // 末尾 `/**`：目录下的一切（至少一层）
            out += ".*";
            i += 2;
          } else {
            // 开头或中间的 `**/`：零到多层目录
            out += "(?:.*/)?";
            i += 3;
          }
          continue;
        }
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if (ch === "[") {
      const close = pattern.indexOf("]", i + 2);
      if (close > i) {
        let body = pattern.slice(i + 1, close);
        if (body.startsWith("!")) body = "^" + body.slice(1);
        out += "[" + body.replace(/\\/g, "\\\\") + "]";
        i = close + 1;
        continue;
      }
    }
    out += escapeRegex(ch);
    i += 1;
  }
  return out;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** 解析一份 .gitignore 文本。base 为该文件所在目录（相对工作区根，POSIX）。 */
export function parseGitignore(text: string, base: string): GitignoreRule[] {
  const rules: GitignoreRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    // 行尾未转义的空白不算模式的一部分
    let line = rawLine.replace(/(?<!\\)\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith("\\!") || line.startsWith("\\#")) {
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.replace(/\/+$/, "");
    }
    if (!line) continue;
    // 中间或开头含 `/` 的模式相对 base 锚定；否则在任意层级匹配名字
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    const body = compileSegmentPattern(line);
    const source = anchored ? `^${body}$` : `^(?:.*/)?${body}$`;
    rules.push({ base, negate, dirOnly, regex: new RegExp(source) });
  }
  return rules;
}

/**
 * 判断条目是否被忽略。relPath 为相对工作区根的 POSIX 路径。
 * 只看条目自身；父目录的忽略由调用方遍历剪枝负责。
 */
export function isIgnoredByRules(rules: readonly GitignoreRule[], relPath: string, isDir: boolean): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    let candidate: string;
    if (rule.base === "") {
      candidate = relPath;
    } else if (relPath.startsWith(rule.base + "/")) {
      candidate = relPath.slice(rule.base.length + 1);
    } else {
      continue;
    }
    if (rule.regex.test(candidate)) ignored = !rule.negate;
  }
  return ignored;
}
