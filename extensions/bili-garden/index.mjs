import { fileURLToPath } from "node:url";
import { GardenService } from "./lib/service.mjs";

let service;
export async function register(ctx) {
  if (
    !ctx.deps.llm?.runGoal ||
    !ctx.deps.llm?.listProfiles ||
    !ctx.deps.secrets
  )
    throw new Error("请先更新并重新编译支持小花园宿主接口的昔涟版本");
  service = new GardenService(
    ctx,
    fileURLToPath(new URL(".", import.meta.url)),
  );
  ctx.onDispose(() => service.close());
  ctx.registerIpc("garden", (command, args) => service.dispatch(command, args));
  ctx.registerTool({
    id: "bili-garden_reading",
    name: "小花园视频任务",
    description:
      "让昔涟在 B 站小花园发现视频、查看任务状态或把 BV 号加入稍后一起看。运行会异步返回任务ID；账号、兴趣及互动开关在插件面板配置。",
    enabled: true,
    risk: "network",
    effectKind: "mutation",
    verificationPolicy: "none",
    ledgerPolicy: "bypass",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["run", "status", "queue"] },
        bvid: { type: "string" },
      },
      required: ["action"],
    },
    execute: async (a) => {
      if (a.action === "status") {
        const s = await service.snapshot();
        return JSON.stringify({
          run: s.run,
          recentRuns: s.runs.slice(0, 3),
          recentReports: s.reports.slice(0, 3),
          account: s.account.loggedIn,
        });
      }
      if (a.action === "queue")
        return JSON.stringify(
          await service.dispatch("queue", { bvid: a.bvid }),
        );
      if (a.action === "run")
        return JSON.stringify(await service.dispatch("run", { bvid: a.bvid }));
      throw new Error("任务类型无效");
    },
  });
}
export async function unregister() {
  await service?.close();
  service = null;
}
