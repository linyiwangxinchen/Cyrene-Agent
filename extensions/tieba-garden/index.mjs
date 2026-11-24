import { createForum } from "./lib/forum.mjs";
import { relevantNote } from "./lib/notes.mjs";
import { registerReadingContext } from "./reading-context.mjs";
export { floorsFromHtml, repliesFromHtml, threadId } from "./lib/public-pages.mjs";

export function register(ctx) {
  const forum = createForum(ctx);
  ctx.registerPromptProvider({
    id: "expressions",
    privateCompanionOnly: true,
    sources: ["conversation"],
    listExpressions: forum.learnedExpressions,
    provide: input => relevantNote(forum.learnedExpressions(), input),
  });
  registerReadingContext(ctx, forum.readings);
  ctx.registerIpc("forum", forum.invoke);
  const timer = setInterval(forum.backgroundTick, 60_000);
  timer.unref?.();
  ctx.onDispose(() => clearInterval(timer));
}
