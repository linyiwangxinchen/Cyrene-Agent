import { describe, expect, it } from "vitest";
import { AgentRuntimeError } from "../main/orchestrator/agent-runtime-error";
import { classifyModelFailure } from "../main/orchestrator/vendors/model-error-classifier";
import {
  createTranscriptCompactionRequiredError,
  getTranscriptCompactionDiagnostics,
  getTranscriptCompactionDisplayMessage,
} from "./transcript-compaction-error";
import type { ModelErrorCategory } from "./model-error";

function providerFailure(category: ModelErrorCategory, metadata: Record<string, unknown> = {}): AgentRuntimeError {
  return new AgentRuntimeError("E_MODEL_REQUEST_FAILED", "Authorization: Bearer sk-secret; prompt=private", {
    modelFailure: { provider: "fixture", model: "fixture", category, ...metadata },
  });
}

describe("摘要模型安全诊断", () => {
  it.each([
    ["INVALID_REQUEST", "请求参数"],
    ["NOT_FOUND", "接口地址不存在"],
    ["CONTENT_POLICY", "内容策略"],
    ["CONFLICT", "请求冲突"],
  ] as const)("%s 不再回退为无法判断原因的泛化提示", (category, text) => {
    const error = createTranscriptCompactionRequiredError(providerFailure(category), "model_request_failed");
    const display = getTranscriptCompactionDisplayMessage(error);
    expect(display).toContain(text);
    expect(display).toContain("E_MODEL_REQUEST_FAILED");
    expect(display).toContain("原始会话记录已保留");
    expect(display).not.toContain("sk-secret");
    expect(display).not.toContain("private");
  });

  it("未知供应商也根据数值 HTTP 状态诊断，不依赖供应商报错原文", () => {
    const raw = Object.assign(new Error("unsupported request body: private prompt and sk-secret"), {
      statusCode: 400,
      responseBody: "private prompt and sk-secret",
    });
    const modelFailure = classifyModelFailure({ provider: "unmapped-relay", model: "fixture", error: raw });
    expect(modelFailure.category).toBe("UNKNOWN");
    const cause = new AgentRuntimeError("E_MODEL_REQUEST_FAILED", "model failure", { cause: raw, modelFailure });
    const display = getTranscriptCompactionDisplayMessage(createTranscriptCompactionRequiredError(cause, "model_request_failed"));
    expect(display).toContain("请求参数");
    expect(display).toContain("HTTP 400");
    expect(display).not.toContain("private prompt");
    expect(display).not.toContain("sk-secret");
  });

  it("保留没有 modelFailure 的运行时解析错误而不输出解析正文", () => {
    const parseError = new AgentRuntimeError("E_MODEL_RESPONSE_PARSE_FAILED", "private response body with sk-secret");
    const error = createTranscriptCompactionRequiredError(new Error("wrapper", { cause: parseError }), "model_request_failed");
    expect(error.displayMessage).toContain("响应格式不完整");
    expect(error.displayMessage).toContain("E_MODEL_RESPONSE_PARSE_FAILED");
    expect(error.displayMessage).not.toContain("private response");
    expect(error.displayMessage).not.toContain("sk-secret");
    expect(createTranscriptCompactionRequiredError(error)).toBe(error);
  });

  it("只向日志暴露固定错误码和严格格式的请求 ID，界面不显示供应商字符串", () => {
    const cause = providerFailure("INVALID_REQUEST", {
      status: 400, vendorCode: "unsupported_parameter", requestId: "req_0123456789abcdef0123456789abcdef",
    });
    const error = createTranscriptCompactionRequiredError(cause, "model_request_failed");
    expect(getTranscriptCompactionDiagnostics(error)).toEqual({
      category: "INVALID_REQUEST", httpStatus: 400, runtimeCode: "E_MODEL_REQUEST_FAILED",
      vendorCode: "unsupported_parameter", requestId: "req_0123456789abcdef0123456789abcdef",
    });
    expect(error.displayMessage).not.toContain("unsupported_parameter");
    expect(error.displayMessage).not.toContain("req_");
  });

  it.each([
    ["sk-secret", "sk-secret"],
    ["privateprompt", "privateprompt"],
    ["Authorization: Bearer sk-secret", "req_privateprompt"],
    ["user_supplied_code", "req_0123456789abcdef\nprivateprompt"],
  ])("丢弃正文或凭据伪装的元数据 %s", (vendorCode, requestId) => {
    const diagnostics = getTranscriptCompactionDiagnostics(providerFailure("UNKNOWN", { vendorCode, requestId }));
    expect(diagnostics.vendorCode).toBeUndefined();
    expect(diagnostics.requestId).toBeUndefined();
    expect(JSON.stringify(diagnostics)).not.toContain("sk-secret");
    expect(JSON.stringify(diagnostics)).not.toContain("privateprompt");
  });

  it("错误 cause 循环和无效状态不会让诊断失败或输出任意值", () => {
    const cyclic: Record<string, unknown> = {
      code: "privateprompt", status: "HTTP 401 Authorization: Bearer sk-secret", message: "privateprompt",
    };
    cyclic.cause = cyclic;
    expect(getTranscriptCompactionDiagnostics(cyclic)).toEqual({});
    const error = createTranscriptCompactionRequiredError(cyclic, "model_request_failed");
    expect(error.displayMessage).toContain("摘要模型请求失败");
    expect(error.displayMessage).not.toContain("sk-secret");
  });
});
