/**
 * Token bucket analyzer for provider-visible input composition.
 *
 * Estimates tokens per bucket using a simple chars/4 heuristic.
 * Called inside experimental.chat.messages.transform and
 * experimental.chat.system.transform to produce a full breakdown
 * of what the provider actually receives.
 */

export interface BucketBreakdown {
  // --- Raw buckets (pre-compaction) ---
  toolOutputsRaw: number;
  assistantTextRaw: number;
  userMessagesRaw: number;

  // --- Final buckets (post-compaction) ---
  toolOutputsFinal: number;
  assistantTextFinal: number;
  userMessagesFinal: number;
  toolCalls: number;
  compactedOverhead: number;
  recentRawParts: number;

  // --- System-level (filled from system.transform) ---
  systemPrompt: number;
  pluginInserts: number;

  // --- Not visible (estimated) ---
  toolSchemas: number;
  opencodeInternal: number;
}

// Approximate tokens per character for English prose.
const PROSE_CHARS_PER_TOKEN = 4;
// Code-heavy content has more token splits (camelCase, punctuation, brackets).
const CODE_CHARS_PER_TOKEN = 3.2;

const CODE_INDICATORS = /(?:function |const |let |var |import |export |class |=>|&&|\|\||::|;\s*$|\{|\}|\[|\]|=>|\\n|0x[0-9a-f]+|[a-z][A-Z])/m;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const ratio = CODE_INDICATORS.test(text) ? CODE_CHARS_PER_TOKEN : PROSE_CHARS_PER_TOKEN;
  return Math.ceil(text.length / ratio);
}

interface TokenBucketPart {
  text?: string;
  content?: string;
  type?: string;
  state?: Record<string, unknown>;
  input?: unknown;
}

export function estimatePartTokens(part: TokenBucketPart): number {
  if (!part) return 0;
  let tokens = 0;
  if (part.text) tokens += estimateTokens(String(part.text));
  if (part.content) tokens += estimateTokens(String(part.content));
  if (part.state?.output) tokens += estimateTokens(String(part.state.output));
  if (part.state?.error) tokens += estimateTokens(String(part.state.error));
  if (part.input) tokens += estimateTokens(JSON.stringify(part.input));
  return tokens;
}

interface MessageLike {
  info?: { role?: string; [k: string]: unknown };
  parts?: unknown[];
  [k: string]: unknown;
}

/**
 * Analyze messages array and return per-bucket token counts.
 *
 * @param messages - The output.messages array from messages.transform
 * @param rawToolTokens - Total raw tool output tokens before compaction
 * @param compactedToolTokens - Total tool output tokens after compaction
 */
export function analyzeMessages(
  messages: MessageLike[],
  rawToolTokens: number,
  compactedToolTokens: number,
): BucketBreakdown {
  let userMessages = 0;
  let assistantText = 0;
  let toolCalls = 0;
  let compactedOverhead = 0;
  let recentRawParts = 0;

  for (const msg of messages) {
    const role = msg.info?.role ?? "unknown";
    for (const part of msg.parts ?? []) {
      const bucketPart = part as unknown as TokenBucketPart | undefined;
      const tokens = estimatePartTokens(bucketPart ?? {});
      const text = String(bucketPart?.text ?? bucketPart?.content ?? bucketPart?.state?.output ?? "");
      const isCompactMarker = text.startsWith("[Compacted]") || text.startsWith("[COMPA");

      if (isCompactMarker) {
        compactedOverhead += estimateTokens("[Compacted] ");
      }

      if (role === "user") {
        userMessages += tokens;
      } else if (role === "assistant") {
        if (bucketPart?.type === "tool") {
          if (bucketPart?.state?.status !== "completed" && bucketPart?.state?.status !== "error") {
            toolCalls += tokens;
          }
          // Completed/error tool parts in assistant messages: counted via compactedToolTokens
          if (!isCompactMarker) {
            recentRawParts += tokens;
          }
        } else if (bucketPart?.type === "text") {
          assistantText += tokens;
        }
      } else if (role === "tool" && bucketPart?.type === "tool" && !isCompactMarker) {
        // Tool-role messages: tracked as recent raw (not yet compacted) tool parts
        recentRawParts += tokens;
      }
    }
  }

  return {
    // Raw (pre-compaction)
    toolOutputsRaw: rawToolTokens,
    assistantTextRaw: 0,  // Filled by caller before assistant compaction
    userMessagesRaw: 0,   // Filled by caller before compaction
    // Final (post-compaction, scanned from messages at this point)
    toolOutputsFinal: compactedToolTokens,
    assistantTextFinal: assistantText,
    userMessagesFinal: userMessages,
    toolCalls,
    compactedOverhead,
    recentRawParts,
    // System-level
    systemPrompt: 0,
    pluginInserts: 0,
    // Estimated
    toolSchemas: 0,
    opencodeInternal: 0,
  };
}

/**
 * Estimate system prompt bucket from the system array.
 */
export function estimateSystemPrompt(systemParts: string[]): number {
  let total = 0;
  for (const part of systemParts) {
    if (typeof part !== "string") continue;
    total += estimateTokens(part);
  }
  return total;
}

/**
 * Format a breakdown for logging.
 */
export function formatBreakdown(
  breakdown: BucketBreakdown,
): string {
  const pad = (s: string, n: number) => s.padStart(n);
  const line = (label: string, val: number) => pad(label, 28) + pad(String(val), 8);

  const preTransformTotal =
    breakdown.toolOutputsRaw +
    breakdown.assistantTextRaw +
    breakdown.userMessagesRaw;

  const postTransformTotal =
    breakdown.toolOutputsFinal +
    breakdown.assistantTextFinal +
    breakdown.userMessagesFinal +
    breakdown.toolCalls +
    breakdown.compactedOverhead +
    breakdown.recentRawParts;

  const estimatedProviderTotal =
    postTransformTotal +
    breakdown.systemPrompt +
    breakdown.pluginInserts +
    breakdown.toolSchemas +
    breakdown.opencodeInternal;

  const lines: string[] = [
    "=== Provider Input Token Estimate ===",
    "",
    "--- Pre-transform (raw) ---",
    line("tool outputs (raw):", breakdown.toolOutputsRaw),
    line("assistant text (raw):", breakdown.assistantTextRaw),
    line("user messages (raw):", breakdown.userMessagesRaw),
    line("PRE-TRANSFORM TOTAL:", preTransformTotal),
    "",
    "--- Post-transform (final) ---",
    line("tool outputs (final):", breakdown.toolOutputsFinal),
    line("assistant text (final):", breakdown.assistantTextFinal),
    line("user messages (final):", breakdown.userMessagesFinal),
    line("tool calls (pending):", breakdown.toolCalls),
    line("compacted overhead:", breakdown.compactedOverhead),
    line("recent raw parts:", breakdown.recentRawParts),
    line("POST-TRANSFORM TOTAL:", postTransformTotal),
    "",
    "--- System-level ---",
    line("system prompt:", breakdown.systemPrompt),
    line("plugin inserts:", breakdown.pluginInserts),
    "",
    "--- Estimated (not plugin-visible) ---",
    line("tool schemas:", breakdown.toolSchemas),
    line("opencode internal:", breakdown.opencodeInternal),
    "",
    "--- Summary ---",
    line("plugin saves:", preTransformTotal - postTransformTotal),
    line("EST. PROVIDER TOTAL:", estimatedProviderTotal),
    "======================================",
  ];
  return lines.join("\n");
}
