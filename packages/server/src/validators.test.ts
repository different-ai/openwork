import { describe, expect, test } from "bun:test";
import {
  sanitizeCommandName,
  validateCommandName,
  validateMcpName,
  validateSkillName,
  validateMcpConfig,
} from "./validators.js";

describe("sanitizeCommandName", () => {
  test("passes through valid names", () => {
    expect(sanitizeCommandName("my-command")).toBe("my-command");
    expect(sanitizeCommandName("deploy")).toBe("deploy");
  });

  test("trims whitespace", () => {
    expect(sanitizeCommandName("  hello  ")).toBe("hello");
  });

  test("strips leading slashes", () => {
    expect(sanitizeCommandName("/deploy")).toBe("deploy");
    expect(sanitizeCommandName("///deploy")).toBe("deploy");
  });
});

describe("validateCommandName", () => {
  test("accepts valid alphanumeric names", () => {
    expect(() => validateCommandName("deploy")).not.toThrow();
    expect(() => validateCommandName("my-cmd")).not.toThrow();
    expect(() => validateCommandName("a_b_c")).not.toThrow();
    expect(() => validateCommandName("Cmd123")).not.toThrow();
  });

  test("rejects empty string", () => {
    expect(() => validateCommandName("")).toThrow();
  });

  test("rejects names with slashes", () => {
    expect(() => validateCommandName("foo/bar")).toThrow();
    expect(() => validateCommandName("foo\\bar")).toThrow();
  });

  test("rejects names with dots", () => {
    expect(() => validateCommandName("foo.bar")).toThrow();
  });

  test("rejects names with spaces", () => {
    expect(() => validateCommandName("foo bar")).toThrow();
  });
});

describe("validateMcpName", () => {
  test("accepts valid names", () => {
    expect(() => validateMcpName("my-server")).not.toThrow();
    expect(() => validateMcpName("notion")).not.toThrow();
    expect(() => validateMcpName("a_b")).not.toThrow();
  });

  test("rejects empty strings", () => {
    expect(() => validateMcpName("")).toThrow();
  });

  test("rejects names starting with dash", () => {
    expect(() => validateMcpName("-bad")).toThrow();
  });

  test("rejects names with special characters", () => {
    expect(() => validateMcpName("foo.bar")).toThrow();
    expect(() => validateMcpName("foo bar")).toThrow();
    expect(() => validateMcpName("foo/bar")).toThrow();
  });
});

describe("validateSkillName", () => {
  test("accepts kebab-case names", () => {
    expect(() => validateSkillName("my-skill")).not.toThrow();
    expect(() => validateSkillName("skill123")).not.toThrow();
    expect(() => validateSkillName("a")).not.toThrow();
  });

  test("rejects empty strings", () => {
    expect(() => validateSkillName("")).toThrow();
  });

  test("rejects uppercase", () => {
    expect(() => validateSkillName("MySkill")).toThrow();
  });

  test("rejects underscores", () => {
    expect(() => validateSkillName("my_skill")).toThrow();
  });

  test("rejects names over 64 chars", () => {
    expect(() => validateSkillName("a".repeat(65))).toThrow();
  });
});

describe("validateMcpConfig", () => {
  test("accepts valid remote config", () => {
    expect(() =>
      validateMcpConfig({ type: "remote", url: "https://example.com" }),
    ).not.toThrow();
  });

  test("accepts valid local config", () => {
    expect(() =>
      validateMcpConfig({ type: "local", command: ["npx", "my-server"] }),
    ).not.toThrow();
  });

  test("rejects unknown type", () => {
    expect(() => validateMcpConfig({ type: "unknown" })).toThrow();
  });

  test("rejects remote without url", () => {
    expect(() => validateMcpConfig({ type: "remote" })).toThrow();
  });

  test("rejects local without command", () => {
    expect(() => validateMcpConfig({ type: "local" })).toThrow();
    expect(() => validateMcpConfig({ type: "local", command: [] })).toThrow();
  });
});
