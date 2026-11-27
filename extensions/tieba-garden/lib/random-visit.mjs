import { randomInt } from "node:crypto";
import { DIRECTORY_INDEX_PATH, directoryPathsFromHtml, forumsFromDirectoryHtml, TiebaPageError } from "./public-pages.mjs";

const CATEGORY_PAGE_LIMIT = 3;

export async function chooseRandomVisitBar(readPage, { signal, canContinue, randomIndex = randomInt }) {
  const pool = new Map();
  const result = { candidateCount: 0, categoriesAvailable: 0, pagesRead: 0, errors: [] };
  const captureError = error => {
    signal.throwIfAborted();
    const message = error instanceof TiebaPageError ? error.message : "暂时无法读取公开目录";
    result.errors.push("公开目录 · " + message);
  };

  let categories;
  try { categories = directoryPathsFromHtml(await readPage(DIRECTORY_INDEX_PATH, signal)); }
  catch (error) { captureError(error); return result; }
  signal.throwIfAborted();
  result.categoriesAvailable = categories.length;
  if (!categories.length) {
    result.errors.push("公开目录 · 贴吧分类页未返回可用的分类链接");
    return result;
  }

  for (let attempt = 0; attempt < CATEGORY_PAGE_LIMIT && categories.length && canContinue(); attempt++) {
    const [path] = categories.splice(randomIndex(categories.length), 1);
    try {
      const html = await readPage(path, signal);
      signal.throwIfAborted();
      const names = forumsFromDirectoryHtml(html);
      result.pagesRead++;
      for (const name of names) {
        const key = name.normalize("NFC").toLowerCase();
        if (!pool.has(key)) pool.set(key, name);
      }
    } catch (error) {
      captureError(error);
      if (error instanceof TiebaPageError && error.pauseVisit) return { ...result, candidateCount: pool.size };
    }
  }

  result.candidateCount = pool.size;
  if (!pool.size || !canContinue()) return result;
  return { ...result, bar: [...pool.values()][randomIndex(pool.size)] };
}
