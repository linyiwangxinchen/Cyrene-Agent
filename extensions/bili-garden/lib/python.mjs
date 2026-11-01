import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export function stopProcess(child, force = false) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", () => child.kill());
  } else {
    try {
      process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
    } catch {
      child.kill();
    }
  }
}
export class PythonRuntime {
  constructor(root, packageRoot, { config, credentials, log = () => {} }) {
    this.root = root;
    this.packageRoot = packageRoot;
    this.config = config;
    this.credentials = credentials;
    this.log = log;
    this.children = new Set();
    this.pending = new Map();
    this.seq = 0;
    this.closed = false;
    this.installing = false;
    this.worker = null;
    this.installLog = [];
  }
  executable() {
    return path.join(
      this.root,
      ".venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    );
  }
  status() {
    let asr = false;
    try {
      asr =
        JSON.parse(readFileSync(path.join(this.root, "asr-ready.json"), "utf8"))
          .model === this.config().asrModel;
    } catch {}
    return {
      installed:
        existsSync(this.executable()) &&
        existsSync(path.join(this.root, "environment.json")),
      installing: this.installing,
      log: this.installLog.slice(-60),
      asr,
    };
  }
  run(command, args, { signal, timeout = 300000, log = false } = {}) {
    if (this.closed) return Promise.reject(new Error("插件已停止"));
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      let output = "",
        settled = false;
      const child = spawn(command, args, {
        cwd: this.root,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" },
      });
      this.children.add(child);
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        error ? reject(error) : resolve(output);
      };
      const abort = () => {
        stopProcess(child);
        finish(new Error("操作已取消"));
      };
      const timer = setTimeout(() => {
        stopProcess(child);
        finish(new Error("Python 操作超时"));
      }, timeout);
      signal?.addEventListener("abort", abort, { once: true });
      const data = (b) => {
        const s = String(b);
        output = (output + s).slice(-10000);
        if (log) {
          this.installLog.push(s.slice(-2000));
          this.installLog = this.installLog.slice(-80);
        }
      };
      child.stdout.on("data", data);
      child.stderr.on("data", data);
      child.once("error", () => this.children.delete(child));
      child.once("exit", () => this.children.delete(child));
      child.once("error", (e) =>
        finish(
          new Error(
            `无法启动 ${path.basename(command)}：${e.code || "请检查路径"}`,
          ),
        ),
      );
      child.once("exit", (code) =>
        finish(
          code === 0
            ? null
            : new Error(`Python 退出 ${code}：${output.slice(-600)}`),
        ),
      );
    });
  }
  async downloadUv(signal) {
    const platforms = {
      win32: {
        x64: "x86_64-pc-windows-msvc.zip",
        arm64: "aarch64-pc-windows-msvc.zip",
      },
      linux: {
        x64: "x86_64-unknown-linux-gnu.tar.gz",
        arm64: "aarch64-unknown-linux-gnu.tar.gz",
      },
      darwin: {
        x64: "x86_64-apple-darwin.tar.gz",
        arm64: "aarch64-apple-darwin.tar.gz",
      },
    };
    const asset = platforms[process.platform]?.[process.arch];
    if (!asset) throw new Error("此平台请安装 Python 3.10+ 或 uv");
    const dir = path.join(this.root, "uv");
    mkdirSync(dir, { recursive: true });
    const base = `https://github.com/astral-sh/uv/releases/latest/download/uv-${asset}`;
    const request = async (url) => {
      const r = await fetch(url, {
        signal: AbortSignal.any([
          signal ?? new AbortController().signal,
          AbortSignal.timeout(120000),
        ]),
      });
      if (!r.ok) throw new Error(`uv 下载 HTTP ${r.status}`);
      return r;
    };
    const checksum = (await (await request(`${base}.sha256`)).text())
      .match(/\b[a-f0-9]{64}\b/i)?.[0]
      ?.toLowerCase();
    if (!checksum)
      throw new Error("无法取得 uv 官方摘要；请安装系统 Python 或 uv 后重试");
    const bytes = Buffer.from(await (await request(base)).arrayBuffer());
    if (bytes.length > 80 * 1024 * 1024) throw new Error("uv 发行包异常");
    if (createHash("sha256").update(bytes).digest("hex") !== checksum)
      throw new Error("uv 校验失败，未执行下载文件");
    const archive = path.join(dir, `uv-${asset}`);
    writeFileSync(archive, bytes);
    await this.run("tar", ["-xf", archive, "-C", dir], { signal });
    const file = path.join(
      dir,
      asset.endsWith(".zip") ? "" : `uv-${asset.replace(".tar.gz", "")}`,
      process.platform === "win32" ? "uv.exe" : "uv",
    );
    if (!existsSync(file)) throw new Error("uv 解压后缺少程序");
    chmodSync(file, 0o755);
    await this.run(file, ["--version"], { signal });
    return file;
  }
  async install({ asr = false, signal } = {}) {
    if (this.installing) throw new Error("运行环境正在安装");
    this.installing = true;
    this.installLog = [];
    try {
      if (!existsSync(this.executable())) {
        let python = "";
        for (const candidate of [
          ...new Set(
            [
              this.config().pythonPath,
              process.platform === "win32" ? "python" : "python3",
              "python",
            ].filter(Boolean),
          ),
        ]) {
          try {
            await this.run(
              candidate,
              ["-c", "import sys; assert sys.version_info >= (3,10)"],
              { signal, timeout: 15000 },
            );
            python = candidate;
            break;
          } catch (e) {
            if (signal?.aborted) throw e;
          }
        }
        if (python)
          await this.run(
            python,
            ["-m", "venv", path.join(this.root, ".venv")],
            { signal, log: true },
          );
        else {
          let uv = "uv";
          try {
            await this.run(uv, ["--version"], { signal, timeout: 10000 });
          } catch {
            uv = await this.downloadUv(signal);
          }
          await this.run(
            uv,
            [
              "venv",
              "--seed",
              "--python",
              "3.11",
              path.join(this.root, ".venv"),
            ],
            { signal, log: true },
          );
        }
      }
      const pip = [
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "-r",
        path.join(this.packageRoot, "python/requirements.txt"),
      ];
      const index = process.env.CYRENE_BILI_PIP_INDEX;
      if (index) {
        if (!index.startsWith("https://"))
          throw new Error("pip 镜像必须使用 HTTPS");
        pip.push("--index-url", index);
      }
      await this.run(this.executable(), pip, {
        signal,
        log: true,
        timeout: 600000,
      });
      await this.run(
        this.executable(),
        ["-c", "import bilibili_api, aiohttp, qrcode"],
        { signal },
      );
      writeFileSync(
        path.join(this.root, "environment.json"),
        JSON.stringify({ ready: true, at: Date.now() }),
      );
      if (asr) {
        await this.run(
          this.executable(),
          ["-m", "pip", "install", "faster-whisper", "yt-dlp", "av>=12,<17"],
          { signal, log: true, timeout: 600000 },
        );
        await this.run(
          this.executable(),
          [
            "-c",
            'import os,sys; os.environ["HF_HOME"]=sys.argv[2]; from faster_whisper import WhisperModel; WhisperModel(sys.argv[1],device="cpu",compute_type="int8")',
            this.config().asrModel,
            path.join(this.root, "model-cache"),
          ],
          { signal, log: true, timeout: 1800000 },
        );
        writeFileSync(
          path.join(this.root, "asr-ready.json"),
          JSON.stringify({ model: this.config().asrModel }),
        );
      }
      this.installLog.push("运行环境检查通过");
      return this.status();
    } finally {
      this.installing = false;
    }
  }
  start() {
    if (this.worker) return;
    if (this.closed) throw new Error("插件已停止");
    if (!this.status().installed) throw new Error("请先在设置中安装运行环境");
    const child = spawn(
      this.executable(),
      [path.join(this.packageRoot, "python/bridge.py")],
      {
        cwd: this.root,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PYTHONUTF8: "1",
          PYTHONUNBUFFERED: "1",
          HF_HOME: path.join(this.root, "model-cache"),
        },
      },
    );
    this.worker = child;
    this.children.add(child);
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 3000000) {
        this.stopWorker(new Error("Python 返回超过大小限制"));
        return;
      }
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
        }
      }
    });
    child.stderr.on("data", () => {}); // 第三方库 stderr 可能含请求上下文，不暴露给页面。
    const failed = () => {
      this.children.delete(child);
      if (this.worker === child) {
        this.worker = null;
        for (const p of this.pending.values())
          p.reject(new Error("B站工作进程已退出"));
        this.pending.clear();
      }
    };
    child.on("error", failed);
    child.on("exit", failed);
    child.stdin.on("error", failed);
  }
  async request(name, args = {}, { signal, timeout = 90000 } = {}) {
    signal?.throwIfAborted();
    const credential = name === "qr" ? {} : await this.credentials();
    signal?.throwIfAborted();
    this.start();
    const child = this.worker;
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const finish = (fn, value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.pending.delete(id);
        fn(value);
      };
      const abort = () => this.stopWorker(new Error("操作已取消"));
      const timer = setTimeout(
        () =>
          this.stopWorker(
            new Error("B站操作超时，发送类操作的结果可能尚不明确"),
          ),
        timeout,
      );
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: (v) => finish(resolve, v),
        reject: (e) => finish(reject, e),
      });
      child.stdin.write(
        JSON.stringify({ id, name, args, credential }) + "\n",
        (e) => {
          if (e) this.stopWorker(new Error("B站工作进程无法接收请求"));
        },
      );
    });
  }
  stopWorker(error = new Error("工作进程已停止")) {
    const child = this.worker;
    this.worker = null;
    for (const p of [...this.pending.values()]) p.reject(error);
    this.pending.clear();
    stopProcess(child);
  }
  async close() {
    this.closed = true;
    this.stopWorker();
    const children = [...this.children];
    for (const child of children) stopProcess(child);
    await Promise.all(
      children.map(
        (child) =>
          new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null)
              return resolve();
            const force = setTimeout(() => stopProcess(child, true), 1500);
            const t = setTimeout(resolve, 3000);
            child.once("exit", () => {
              clearTimeout(force);
              clearTimeout(t);
              resolve();
            });
          }),
      ),
    );
  }
}
