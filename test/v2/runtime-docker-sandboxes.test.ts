import { describe, expect, it } from "vitest";
import { dockerLoginDiagnostic } from "../../src/v2/runtime/docker-sandboxes.ts";

function report(status: string, message: string, detail = ""): string {
  return JSON.stringify({
    version: "1.0",
    checks: [{ name: "Authentication", status, message, detail, hint: "" }],
  });
}

describe("Docker Sandboxes diagnostics", () => {
  it("reports a verified Docker login", () => {
    expect(dockerLoginDiagnostic(report("pass", "authenticated", "imre"))).toEqual({
      component: "runtime.docker-login",
      status: "ok",
      detail: "authenticated: imre",
    });
  });

  it("offers an interactive login when Docker authentication failed", () => {
    expect(dockerLoginDiagnostic(report("fail", "not authenticated"))).toEqual({
      component: "runtime.docker-login",
      status: "failed",
      detail: "not authenticated",
      remediation: { kind: "command", value: "sbx login", interactive: true },
    });
  });

  it("does not prescribe login when authentication could not be checked", () => {
    expect(dockerLoginDiagnostic(report("skip", "Skipped: Daemon failed"))).toEqual({
      component: "runtime.docker-login",
      status: "failed",
      detail: "Skipped: Daemon failed",
    });
  });

  it("fails explicitly when older or invalid diagnostics omit authentication", () => {
    expect(dockerLoginDiagnostic("not json")).toEqual({
      component: "runtime.docker-login",
      status: "failed",
      detail: "authentication status was not reported by sbx diagnose",
    });
  });
});
