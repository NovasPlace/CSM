import { Database } from "./database.js";

export type ExtractedConcept = {
  type: "file" | "function" | "error" | "decision" | "tool" | "concept" | "dependency";
  value: string;
  confidence: number;
  context?: string;
};

export type ExtractionResult = {
  concepts: ExtractedConcept[];
  filePaths: string[];
  functionNames: string[];
  errorMessages: string[];
  decisions: string[];
  toolsUsed: string[];
  dependencies: string[];
};

const FILE_PATH_REGEX = /(?:src|lib|test|app)\/[a-zA-Z0-9_\-./]+\.(ts|js|tsx|jsx|py|rs|go|java|cs|php|rb|swift|kt|scala|clj|ex|erl|hs|ml|fs|vim|sql|json|yaml|yml|toml|ini|cfg|conf|md|txt)/g;
const FUNCTION_REGEX = /\b(?:function|const|let|var|async\s+function|export\s+(?:async\s+)?function|export\s+const)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
const ERROR_REGEX = /(?:Error|Exception|Fail|Failed|panic|crash|traceback|stack trace)[:\s]+([^\n]{10,200})/gi;
const DECISION_KEYWORDS = ["decided", "decision", "chose", "selected", "picked", "will use", "going to use", "switching to", "migrating to", "adopted", "replaced with"];
const TOOL_PATTERNS = ["memory_search", "memory_save", "memory_recall", "context_compact", "checkpoint_create", "checkpoint_list", "auto_docs"];

export function extractConcepts(text: string, sessionId?: string): ExtractionResult {
  const concepts: ExtractedConcept[] = [];

  // Extract file paths
  const filePaths: string[] = [];
  let match;
  while ((match = FILE_PATH_REGEX.exec(text)) !== null) {
    const path = match[0];
    if (!filePaths.includes(path)) {
      filePaths.push(path);
      concepts.push({
        type: "file",
        value: path,
        confidence: 0.9,
        context: text.slice(Math.max(0, match.index - 50), match.index + match[0].length + 50),
      });
    }
  }

  // Extract function names
  const functionNames: string[] = [];
  while ((match = FUNCTION_REGEX.exec(text)) !== null) {
    const fn = match[1];
    if (!functionNames.includes(fn)) {
      functionNames.push(fn);
      concepts.push({
        type: "function",
        value: fn,
        confidence: 0.8,
        context: text.slice(Math.max(0, match.index - 50), match.index + match[0].length + 50),
      });
    }
  }

  // Extract error messages
  const errorMessages: string[] = [];
  while ((match = ERROR_REGEX.exec(text)) !== null) {
    const err = match[1].trim();
    if (!errorMessages.includes(err)) {
      errorMessages.push(err);
      concepts.push({
        type: "error",
        value: err,
        confidence: 0.85,
        context: text.slice(Math.max(0, match.index - 50), match.index + match[0].length + 50),
      });
    }
  }

  // Extract decisions
  const decisions: string[] = [];
  for (const keyword of DECISION_KEYWORDS) {
    const regex = new RegExp(`\\b${keyword}\\b[^.]*\\.`, "gi");
    while ((match = regex.exec(text)) !== null) {
      const decision = match[0].trim();
      if (!decisions.includes(decision)) {
        decisions.push(decision);
        concepts.push({
          type: "decision",
          value: decision,
          confidence: 0.7,
          context: text.slice(Math.max(0, match.index - 50), match.index + match[0].length + 50),
        });
      }
    }
  }

  // Extract tools used
  const toolsUsed: string[] = [];
  for (const tool of TOOL_PATTERNS) {
    if (text.includes(tool) && !toolsUsed.includes(tool)) {
      toolsUsed.push(tool);
      concepts.push({
        type: "tool",
        value: tool,
        confidence: 0.95,
      });
    }
  }

  // Extract dependencies (package imports, etc.)
  const dependencies: string[] = [];
  const importRegex = /(?:import|require|from)\s+['"]([^'"]+)['"]/g;
  while ((match = importRegex.exec(text)) !== null) {
    const dep = match[1];
    if (!dep.startsWith(".") && !dep.startsWith("/") && !dependencies.includes(dep)) {
      dependencies.push(dep);
      concepts.push({
        type: "dependency",
        value: dep,
        confidence: 0.75,
        context: text.slice(Math.max(0, match.index - 50), match.index + match[0].length + 50),
      });
    }
  }

  // General concept extraction (technical terms, patterns)
  const conceptPatterns = [
    /\b(?:async|await|promise|callback|event|stream|observable|reactive)\b/gi,
    /\b(?:database|db|sql|postgres|sqlite|mysql|redis|mongodb)\b/gi,
    /\b(?:api|rest|graphql|grpc|websocket|http|https)\b/gi,
    /\b(?:auth|authentication|authorization|jwt|oauth|session|cookie)\b/gi,
    /\b(?:test|testing|jest|vitest|mocha|cypress|playwright)\b/gi,
    /\b(?:docker|kubernetes|k8s|container|deployment|ci|cd|pipeline)\b/gi,
    /\b(?:plugin|hook|middleware|interceptor|decorator|wrapper)\b/gi,
    /\b(?:vector|embedding|semantic|similarity|search|index|retrieval)\b/gi,
    /\b(?:compaction|compression|token|context|window|summary|digest)\b/gi,
  ];

  for (const pattern of conceptPatterns) {
    while ((match = pattern.exec(text)) !== null) {
      const concept = match[0].toLowerCase();
      if (!concepts.some(c => c.type === "concept" && c.value === concept)) {
        concepts.push({
          type: "concept",
          value: concept,
          confidence: 0.6,
          context: text.slice(Math.max(0, match.index - 50), match.index + match[0].length + 50),
        });
      }
    }
  }

  return {
    concepts,
    filePaths,
    functionNames,
    errorMessages,
    decisions,
    toolsUsed,
    dependencies,
  };
}

export function mergeConcepts(existing: ExtractedConcept[] | undefined, newConcepts: ExtractedConcept[]): ExtractedConcept[] {
  if (!existing) return newConcepts;
  const seen = new Set(existing.map(c => `${c.type}:${c.value}`));
  const merged = [...existing];
  for (const c of newConcepts) {
    const key = `${c.type}:${c.value}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(c);
    }
  }
  return merged;
}