import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setMemoryMode } from "../memory/memory-mode";
import {
  getReranker, getRerankerInstallStatus, getRerankerMode, getRerankerRuntimeStatus,
  initReranker, isRerankerReady, resetReranker,
} from "./reranker";

const mocks = vi.hoisted(() => ({
  modelDirectory: null as string | null,
  load: vi.fn(),
}));
vi.mock("./local-transformer-pipeline", () => ({ loadLocalTransformerPipeline: mocks.load }));
vi.mock("./model-status", () => ({ getModelInstallStatusDetail: () => ({ matchedAt: mocks.modelDirectory }) }));

function logits(...values: number[]) {
  return { logits: { dims: [values.length, 1], data: Float32Array.from(values) } };
}

function makePipeline() {
  const inputs = { input_ids: "paired fixture" };
  return {
    inputs,
    tokenizer: vi.fn(() => inputs),
    model: vi.fn<() => Promise<ReturnType<typeof logits>>>().mockResolvedValue(logits(0)),
    dispose: vi.fn(async () => undefined),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

describe("BGE reranker lifecycle and inference", () => {
  let modelDirectory: string;
  let weights: string;
  beforeEach(() => {
    setMemoryMode("vector");
    resetReranker();
    modelDirectory = mkdtempSync(path.join(os.tmpdir(), "cyrene-reranker-"));
    const onnx = path.join(modelDirectory, "onnx");
    weights = path.join(onnx, "model_quantized.onnx");
    mkdirSync(onnx);
    writeFileSync(weights, Buffer.from([8, 8, ...new Array(14).fill(0)]));
    mocks.modelDirectory = modelDirectory;
    mocks.load.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    resetReranker();
    setMemoryMode("vector");
    rmSync(modelDirectory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("passes each document as its own second sequence and ranks single logits with sigmoid", async () => {
    const pipeline = makePipeline();
    mocks.load.mockResolvedValue(pipeline);
    expect(await initReranker("standard")).toBe(true);
    expect(getRerankerRuntimeStatus()).toBe("ready");
    expect(getRerankerMode()).toBe("standard");
    const provider = getReranker()!;
    pipeline.model.mockResolvedValueOnce(logits(-2, 2));
    const results = await provider.rerank("红色星球", ["金星", "火星"]);
    expect(pipeline.tokenizer).toHaveBeenLastCalledWith(["红色星球", "红色星球"], {
      text_pair: ["金星", "火星"], padding: true, truncation: true,
    });
    expect(pipeline.model).toHaveBeenLastCalledWith(pipeline.inputs);
    expect(results.map(item => item.text)).toEqual(["火星", "金星"]);
    expect(results[0].score).toBeCloseTo(0.881, 3);
    expect(results[1].score).toBeCloseTo(0.119, 3);
  });

  it("distinguishes missing files, an actual prediction error, and a successful retry", async () => {
    mocks.modelDirectory = null;
    expect(await initReranker("standard")).toBe(false);
    expect(getRerankerInstallStatus()).toEqual({ standard: false });
    expect(getRerankerRuntimeStatus()).toBe("missingModel");
    expect(mocks.load).not.toHaveBeenCalled();

    mocks.modelDirectory = modelDirectory;
    const header = Buffer.from([8, 8, ...new Array(14).fill(0)]);
    writeFileSync(weights, "invalid download content");
    expect(await initReranker("standard")).toBe(false);
    expect(getRerankerRuntimeStatus()).toBe("loadFailed");
    expect(mocks.load).not.toHaveBeenCalled();
    writeFileSync(weights, header);
    const broken = makePipeline();
    broken.model.mockResolvedValueOnce(logits(Number.NaN));
    mocks.load.mockResolvedValueOnce(broken);
    expect(await initReranker("standard")).toBe(false);
    expect(getRerankerInstallStatus()).toEqual({ standard: true });
    expect(getRerankerRuntimeStatus()).toBe("loadFailed");
    expect(isRerankerReady()).toBe(false);
    expect(broken.dispose).toHaveBeenCalledOnce();

    mocks.load.mockResolvedValue(makePipeline());
    expect(await initReranker("standard")).toBe(true);
    expect(isRerankerReady()).toBe(true);
  });

  it("shares initialization between concurrent startup and settings calls", async () => {
    const load = deferred<ReturnType<typeof makePipeline>>();
    mocks.load.mockReturnValue(load.promise);
    const startup = initReranker("standard");
    const settings = initReranker("standard");
    expect(getRerankerRuntimeStatus()).toBe("loading");
    expect(isRerankerReady()).toBe(false);
    const pipeline = makePipeline();
    load.resolve(pipeline);
    expect(await Promise.all([startup, settings])).toEqual([true, true]);
    expect(mocks.load).toHaveBeenCalledOnce();
    expect(pipeline.model).toHaveBeenCalledOnce();
  });

  it("does not publish a pending load after disabling or switching memory away and back", async () => {
    const older = deferred<ReturnType<typeof makePipeline>>();
    mocks.load.mockReturnValueOnce(older.promise);
    const stale = initReranker("standard");
    await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledOnce());
    expect(await initReranker("none")).toBe(false);
    expect(getRerankerRuntimeStatus()).toBe("disabled");
    const unused = makePipeline();
    older.resolve(unused);
    expect(await stale).toBe(false);
    expect(unused.model).not.toHaveBeenCalled();
    expect(unused.dispose).toHaveBeenCalledOnce();

    const runtime = makePipeline();
    const prediction = deferred<ReturnType<typeof logits>>();
    runtime.model.mockReturnValueOnce(prediction.promise);
    mocks.load.mockResolvedValueOnce(runtime);
    const beforeModeSwitch = initReranker("standard");
    await vi.waitFor(() => expect(runtime.model).toHaveBeenCalledOnce());
    setMemoryMode("summary");
    setMemoryMode("vector");
    mocks.load.mockResolvedValueOnce(makePipeline());
    expect(await initReranker("standard")).toBe(true);
    prediction.resolve(logits(0));
    expect(await beforeModeSwitch).toBe(false);
    expect(runtime.dispose).toHaveBeenCalledOnce();
    expect(getRerankerRuntimeStatus()).toBe("ready");
  });

  it("discards a running prediction on reset and disposes only after it finishes", async () => {
    const pipeline = makePipeline();
    mocks.load.mockResolvedValue(pipeline);
    expect(await initReranker("standard")).toBe(true);
    const prediction = deferred<ReturnType<typeof logits>>();
    pipeline.model.mockReturnValueOnce(prediction.promise);
    const result = getReranker()!.rerank("问题", ["文档"]);
    resetReranker();
    expect(getReranker()).toBeNull();
    expect(pipeline.dispose).not.toHaveBeenCalled();
    prediction.resolve(logits(2));
    await expect(result).rejects.toThrow("重排模型已停用");
    expect(pipeline.dispose).toHaveBeenCalledOnce();
  });
});
