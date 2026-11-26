import { createForum } from "./lib/forum.mjs";
import { speakingStyle } from "./lib/speaking-style.mjs";
import { registerReadingContext } from "./reading-context.mjs";
export { floorsFromHtml, repliesFromHtml, threadId } from "./lib/public-pages.mjs";

export function register(ctx) {
  const forum = createForum(ctx);
  ctx.registerPromptProvider({
    id: "expressions",
    privateCompanionOnly: true,
    sources: ["conversation"],
    listExpressions: forum.learnedExpressions,
    provide: input => speakingStyle(forum.learnedExpressions(), input),
  });
  registerReadingContext(ctx, forum.readings, forum.learningEnabled);
  ctx.registerIpc("forum", forum.invoke);
  const timer = setInterval(forum.backgroundTick, 60_000);
  timer.unref?.();
  ctx.onDispose(() => clearInterval(timer));
}
