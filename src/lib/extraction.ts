// Shared Zod schemas for Gemini extraction (used by the API route and client).
import { z } from "zod";
import { ALL_FIELD_KEYS } from "./fields";
import type { FieldKey } from "./types";

const fieldKeyEnum = z.enum(ALL_FIELD_KEYS as [FieldKey, ...FieldKey[]]);

export const ExtractRequest = z.object({
  category: z.enum(["medical", "fire", "police", "other"]),
  transcript: z
    .array(
      z.object({
        id: z.string().max(40),
        speaker: z.enum(["caller", "dispatcher"]),
        text: z.string().max(2000),
      }),
    )
    .min(1)
    .max(200),
  /** Fields the dispatcher already confirmed; Gemini must not contradict them. */
  confirmed: z.record(z.string(), z.string().max(500)).default({}),
});
export type ExtractRequest = z.infer<typeof ExtractRequest>;

export const GeminiExtraction = z.object({
  fields: z
    .array(
      z.object({
        key: fieldKeyEnum,
        value: z.string().min(1).max(300),
        evidenceSegmentId: z.string().max(40),
      }),
    )
    .max(40),
  missingFields: z.array(fieldKeyEnum).max(40).default([]),
  suggestedQuestions: z.array(z.string().max(200)).max(6).default([]),
});
export type GeminiExtraction = z.infer<typeof GeminiExtraction>;

/** JSON schema sent to Gemini's response_format (kept in sync with GeminiExtraction). */
export const GEMINI_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    fields: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string", enum: ALL_FIELD_KEYS },
          value: { type: "string" },
          evidenceSegmentId: { type: "string" },
        },
        required: ["key", "value", "evidenceSegmentId"],
      },
    },
    missingFields: { type: "array", items: { type: "string", enum: ALL_FIELD_KEYS } },
    suggestedQuestions: { type: "array", items: { type: "string" }, maxItems: 6 },
  },
  required: ["fields", "missingFields", "suggestedQuestions"],
} as const;

export interface ExtractResponse {
  ok: true;
  model: string;
  updates: { key: FieldKey; value: string; status: "unverified"; evidenceSegmentId: string | null }[];
  missingFields: FieldKey[];
  suggestedQuestions: string[];
}
export interface ExtractError {
  ok: false;
  error: "not_configured" | "bad_request" | "upstream_error" | "invalid_output";
  message: string;
}
