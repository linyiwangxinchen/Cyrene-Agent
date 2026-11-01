import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
} from "node:fs";
import path from "node:path";
import { devNull } from "node:os";
import { createHash } from "node:crypto";

const PYPI_INDEX = "https://pypi.org/simple/";
const ALIYUN_INDEX = "https://mirrors.aliyun.com/pypi/simple/";
const ASR_PACKAGES = [
  "faster-whisper>=1.2.1,<2",
  "yt-dlp",
  "--only-binary=ctranslate2,av,onnxruntime,tokenizers",
];

function packageIndex(value) {
  let url;
  try { url = new URL(value.trim()); } catch { /* validated below */ }
  if (!url || url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error("pip 镜像必须是完整的 HTTPS 索引地址，不能包含账号密码、查询参数或片段");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url.href;
}

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
    this.pipHasResume = false;
    this.pipSource = null;
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
  run(command, args, { signal, timeout = 300000, log = false, env = {} } = {}) {
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
        env: { ...process.env, PYTHONUTF8: "1", PYTHONUNBUFFERED: "1", ...env },
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
            : Object.assign(new Error(`Python 退出 ${code}：${output.slice(-600)}`), { output }),
        ),
      );
    });
  }
  async installPackages(packages, { signal, label = "依赖" } = {}) {
    const preferred = packageIndex(
      process.env.CYRENE_BILI_PIP_INDEX || process.env.PIP_INDEX_URL || PYPI_INDEX,
    );
    const previous = this.pipSource?.preferred === preferred ? this.pipSource.index : null;
    const indexes = [...new Set([previous, preferred, PYPI_INDEX, ALIYUN_INDEX].filter(Boolean))];
    for (const [attempt, index] of indexes.entries()) {
      signal?.throwIfAborted();
      this.installLog.push(`${label}安装源：${index}`);
      try {
        const result = await this.run(this.executable(), [
          "-m", "pip", "--isolated", "install", "--disable-pip-version-check",
          "--no-input", "--progress-bar", "off", "--retries", "3", "--timeout", "120",
          "--cache-dir", path.join(this.root, "pip-cache"),
          ...(this.pipHasResume ? ["--resume-retries", "5"] : []),
          "--index-url", index, ...packages,
        ], {
          signal, log: true, timeout: 900000,
          // Disable inherited pip.ini/pip.conf (including extra-index/no-index).
          // Keep proxy and certificate environment; never change global pip config.
          env: { PIP_CONFIG_FILE: devNull },
        });
        // Reuse a reachable source in subsequent phases of this runtime. A new
        // explicit source setting takes priority over this in-memory preference.
        this.pipSource = { preferred, index };
        return result;
      } catch (error) {
        signal?.throwIfAborted();
        if (this.closed) throw error;
        const output = String(error.output || error.message);
        const sourceFailure = /No matching distribution|Could not find a version|Could not fetch URL|ConnectionError|Connection refused|Connection reset|NewConnectionError|ConnectTimeout|ReadTimeout|Read timed out|SSLError|CERTIFICATE_VERIFY_FAILED|Temporary failure in name resolution|Network is unreachable|Max retries exceeded|HTTP (?:403|404|429|5\d\d)|Cannot fetch index|incomplete-download|IncompleteRead|not enough bytes|download failed.*received/i.test(output);
        if (attempt + 1 >= indexes.length || !sourceFailure) throw error;
        this.installLog.push(`${label}在当前源查找或下载失败，切换到 ${indexes[attempt + 1]}（每个源最多尝试一轮）。`);
      }
    }
  }
  async ensurePip(signal) {
    const version = async () => {
      const output = await this.run(this.executable(), ["-m", "pip", "--version"], { signal, timeout: 15000 });
      const match = /^pip (\d+)\.(\d+)(?:\.\d+)?\b/m.exec(output);
      if (!match) throw new Error("无法读取插件虚拟环境中的 pip 版本");
      return { version: match[0], resume: Number(match[1]) > 25 || (Number(match[1]) === 25 && Number(match[2]) >= 2) };
    };
    let info = await version();
    this.pipHasResume = info.resume;
    if (!info.resume) {
      this.installLog.push(`${info.version} 不支持默认断点续传，正在升级插件虚拟环境内的 pip。`);
      await this.installPackages(["--upgrade", "pip>=25.2,<27"], { signal, label: "下载器" });
      info = await version();
      if (!info.resume) throw new Error("插件 pip 升级未生效，需要 pip 25.2 或更高版本以恢复中断下载");
    }
    this.pipHasResume = true;
    this.installLog.push(`${info.version}：网络读取超时 120 秒，中断续传最多 5 次；完整下载缓存保存在插件目录。`);
  }
  async installAsrPackages(signal) {
    if (!this.pipHasResume) await this.ensurePip(signal);
    await this.installPackages(ASR_PACKAGES, { signal, label: "转写依赖" });
    await this.run(this.executable(), ["-c", "import faster_whisper, ctranslate2, av, yt_dlp"], { signal });
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
    const asrModel = this.config().asrModel;
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
      const interpreter = JSON.parse(await this.run(this.executable(), [
        "-c", "import json,sys,platform,struct; print(json.dumps({'version':list(sys.version_info[:3]),'platform':sys.platform,'arch':platform.machine(),'bits':struct.calcsize('P')*8}))",
      ], { signal, timeout: 15000 }));
      this.installLog.push(`Python ${interpreter.version.join(".")} · ${interpreter.platform}/${interpreter.arch} · ${interpreter.bits} 位`);
      if (interpreter.version[0] !== 3 || interpreter.version[1] < 10)
        throw new Error("运行环境需要 Python 3.10 或更高版本，建议使用 64 位 Python 3.11/3.12 创建插件环境");
      if (asr && interpreter.bits !== 64)
        throw new Error("本地转写需要 64 位 Python，请使用 64 位 Python 3.11/3.12 创建插件环境");
      await this.ensurePip(signal);
      await this.installPackages(["-r", path.join(this.packageRoot, "python/requirements.txt")], {
        signal, label: "基础依赖",
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
        await this.installAsrPackages(signal);
        this.installLog.push(`转写依赖检查通过，正在下载并加载 ${asrModel} 模型（与 pip 软件源独立）。`);
        await this.run(
          this.executable(),
          [
            "-c",
            'import os,sys; os.environ["HF_HOME"]=sys.argv[2]; from faster_whisper import WhisperModel; WhisperModel(sys.argv[1],device="cpu",compute_type="int8")',
            asrModel,
            path.join(this.root, "model-cache"),
          ],
          { signal, log: true, timeout: 1800000 },
        );
        writeFileSync(
          path.join(this.root, "asr-ready.json"),
          JSON.stringify({ model: asrModel }),
        );
      }
      this.installLog.push("运行环境检查通过");
      return this.status();
    } catch (error) {
      this.installLog.push(`安装未完成：${error.message}`);
      throw error;
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
