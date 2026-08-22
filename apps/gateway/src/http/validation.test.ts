import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { ApiError } from "~/http/errors";
import { parseBody, parseQuery, zodIssuesToFields } from "~/http/validation";

const schema = z.object({
  title: z.string().min(1),
  assignee: z.object({ id: z.string().uuid() }),
});

describe("zodIssuesToFields", () => {
  test("emits JSON Pointer paths for nested body fields", () => {
    const result = schema.safeParse({ title: "", assignee: { id: "nope" } });
    if (result.success) throw new Error("expected failure");
    const fields = zodIssuesToFields(result.error);
    const paths = fields.map((f) => f.path).sort();
    expect(paths).toEqual(["/assignee/id", "/title"]);
    for (const field of fields) {
      expect(typeof field.code).toBe("string");
      expect(typeof field.message).toBe("string");
    }
  });

  test("prefixes query pointers", () => {
    const result = z.object({ first: z.number() }).safeParse({ first: "x" });
    if (result.success) throw new Error("expected failure");
    expect(zodIssuesToFields(result.error, ["query"])[0]?.path).toBe("/query/first");
  });
});

describe("parseBody", () => {
  test("returns typed data on success", () => {
    const data = parseBody(z.object({ n: z.number() }), { n: 1 });
    expect(data.n).toBe(1);
  });

  test("throws 422 VALIDATION_FAILED with details.fields on failure", () => {
    let error: ApiError | undefined;
    try {
      parseBody(schema, { title: "", assignee: { id: "x" } });
    } catch (err) {
      error = err as ApiError;
    }
    expect(error?.status).toBe(422);
    expect(error?.code).toBe("VALIDATION_FAILED");
    expect(Array.isArray((error?.details as { fields: unknown[] }).fields)).toBe(true);
  });
});

describe("parseQuery", () => {
  test("throws 400 INVALID_REQUEST on failure", () => {
    let error: ApiError | undefined;
    try {
      parseQuery(z.object({ first: z.number() }), { first: "x" });
    } catch (err) {
      error = err as ApiError;
    }
    expect(error?.status).toBe(400);
    expect(error?.code).toBe("INVALID_REQUEST");
  });
});
