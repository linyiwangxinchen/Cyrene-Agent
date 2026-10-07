import fs from "node:fs";
import path from "node:path";

/** One-way, idempotent import. Legacy files remain as a rollback snapshot. */
export function migrateWebData(root: string): void {
  const marker = path.join(root, "shared-core-migration.json");
  if (fs.existsSync(marker)) return;
  const read = (name: string) => { const file = path.join(root, name); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null; };
  const data = read("web-data.json"), features = read("web-features.json");
  const backup = path.join(root, "backups", `web-before-shared-core-${Date.now()}`);
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
  for (const name of ["web-data.json", "web-features.json", "web-media.json", "web-channel-state.json"]) if (fs.existsSync(path.join(root, name))) fs.copyFileSync(path.join(root, name), path.join(backup, name));
  const writeMissing = (name: string, value: unknown) => {
    const file = path.join(root, name);
    if (fs.existsSync(file) || value == null) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.migrating`, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(`${file}.migrating`, file);
  };
  if (data) {
    writeMissing("model-settings.json", { ...data.settings?.config, modelProfiles: data.settings?.modelProfiles ?? [], defaultModelProfileId: data.settings?.defaultModelProfileId });
    writeMissing("app-settings.json", { ...data.settings?.general, recentProjects: data.recentProjects ?? [], plugins: features?.enabledPlugins ?? {} });
    writeMissing("timeout-settings.json", data.settings?.timeout);
    const rawLevel = data.settings?.permissionLevel;
    const level = ({ ask: "per-action", "confirm-write": "per-action", "full-access": "full" } as Record<string, string>)[rawLevel] ?? rawLevel;
    if (["read-only", "scoped", "per-action", "full"].includes(level)) writeMissing("agent-permission.json", { level });
    const index = (data.sessions ?? []).map((session: any) => {
      // Keep the original stable IDs; the desktop transcript migration converts v1 lazily.
      const migrated = { schemaVersion: 1, ...session };
      if (!/^[\w-]+$/.test(session.id)) throw new Error("Invalid legacy session id");
      writeMissing(`cyrene-chats/sessions/${session.id}.json`, migrated);
      const { messages, ...meta } = migrated;
      return { ...meta, messageCount: messages?.length ?? 0, workspaceRoot: migrated.workspaceBinding?.workspaceRoot, workspaceDisplayName: migrated.workspaceBinding?.displayName };
    });
    writeMissing("cyrene-chats/index.json", index);
    writeMissing("cyrene-chats/sidebar-organization.json", data.sidebar);
  }
  if (features) {
    writeMissing("user-profile.json", features.profile);
    writeMissing("channels-settings.json", features.channels);
    writeMissing("memory.json", { ...features.memory, schemaVersion: 2, reflectionLogs: features.memory?.reflectionLogs ?? features.memory?.reflections ?? [], l0: { ...features.memory?.l0, isPinned: false, updatedAt: Date.now() }, l1: { ...features.memory?.l1, generatedAt: Date.now(), roundCount: 0 } });
    if (features.memory && (features.memory.vaultPath || features.memory.autoSync)) {
      writeMissing("obsidian-vault-config.json", { vaultPath: features.memory.vaultPath ?? "", autoSync: Boolean(features.memory.autoSync), lastSyncAt: Number(features.memory.lastSyncAt ?? 0) });
    }
    writeMissing("scheduled-tasks.json", { tasks: (features.schedules ?? []).map((task: any) => ({ ...task, workspaceBinding: task.workspaceBinding ?? (task.workspaceRoot ? { workspaceRoot: task.workspaceRoot, displayName: path.basename(task.workspaceRoot) } : undefined) })) });
    const historyPath = path.join(root, "scheduled-tasks-history.jsonl");
    if (!fs.existsSync(historyPath) && features.scheduleHistory?.length) fs.writeFileSync(historyPath, features.scheduleHistory.map((entry: unknown) => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600 });
    writeMissing("moments.json", { schemaVersion: 2, ...features.moments });
  }
  const media = read("web-media.json");
  if (media) {
    writeMissing("sticker-settings.json", media.enabled ?? {});
    const stickers: Record<string, unknown> = {};
    for (const item of media.stickers ?? []) {
      if (!/^[A-Za-z0-9_-]+$/.test(item.id) || path.basename(item.file) !== item.file) continue;
      const source = path.join(root, "web-media", item.file);
      if (!fs.existsSync(source)) continue;
      const name = `${item.id}${path.extname(item.file)}`;
      const target = path.join(root, "stickers", name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (!fs.existsSync(target)) fs.copyFileSync(source, target);
      stickers[item.id] = { ...item, file: name };
    }
    writeMissing("sticker-manifest.json", { schemaVersion: 1, stickers });
    for (const kind of ["user", "cyrene"]) {
      const name = media.avatars?.[kind];
      if (typeof name !== "string" || path.basename(name) !== name) continue;
      const source = path.join(root, "web-media", name);
      const target = path.join(root, kind === "user" ? "avatar.png" : `cyrene-avatar${path.extname(name)}`);
      if (fs.existsSync(source) && !fs.existsSync(target)) fs.copyFileSync(source, target);
    }
  }
  const channelState = read("web-channel-state.json");
  if (channelState) {
    writeMissing("channels/context-bindings.json", { version: 1, externalChats: channelState.externalChats ?? [], bindings: channelState.bindings ?? [] });
    const logPath = path.join(root, "channels", "log.jsonl");
    if (!fs.existsSync(logPath) && channelState.logs?.length) {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, channelState.logs.map((entry: any) => JSON.stringify({ ...entry, dir: entry.dir ?? entry.direction, at: typeof entry.at === "number" ? new Date(entry.at).toISOString() : entry.at })).join("\n") + "\n", { mode: 0o600 });
    }
  }
  // Imported KB metadata is replayed through the actual indexer after initialization.
  fs.writeFileSync(marker, JSON.stringify({ version: 1, importedAt: Date.now(), backup, knowledge: features?.knowledge ?? null }), { mode: 0o600 });
}
