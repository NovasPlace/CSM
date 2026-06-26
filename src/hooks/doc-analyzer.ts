import { PluginContext } from "../plugin-context.js";
import { promises as fs } from "fs";
import { join, normalize, sep } from "path";

interface CodeChange {
  filePath: string;
  changeType: "write" | "edit" | "delete";
  oldContent?: string;
  newContent?: string;
}

interface DocUpdatePlan {
  systemMap?: { action: "add" | "update" | "remove"; content: string; section: string };
  decisions?: { action: "add" | "update" | "remove"; content: string; section: string };
  debugNotes?: { action: "add" | "update" | "remove"; content: string; section: string };
  agentMemory?: { action: "add" | "update" | "remove"; content: string; section: string };
  runbook?: { action: "add" | "update" | "remove"; content: string; section: string };
  changelog?: string;
}

const DOCS_DIR = "docs";

const IGNORED_PATHS = [
  "docs/",
  "dist/",
  "node_modules/",
  "coverage/",
  ".git/",
  "test/fixtures/",
];

const STUB_CONTENT_THRESHOLD = 20;
const MIN_EXPORTS_FOR_ENTRY = 1;
const MIN_IMPORTS_FOR_ENTRY = 1;

function getDocsDir(): string {
  return join(process.cwd(), DOCS_DIR);
}

async function readDoc(fileName: string): Promise<string> {
  try {
    return await fs.readFile(join(getDocsDir(), fileName), "utf-8");
  } catch {
    return "";
  }
}

async function writeDoc(fileName: string, content: string): Promise<void> {
  await fs.mkdir(getDocsDir(), { recursive: true });
  await fs.writeFile(join(getDocsDir(), fileName), content, "utf-8");
}

export function isIgnoredForAnalysis(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return IGNORED_PATHS.some(p => normalized.includes(p));
}

export function isStubContent(content: string): boolean {
  if (!content || content.trim().length < STUB_CONTENT_THRESHOLD) return true;
  if (/^\/\/.*$/.test(content.trim()) && content.trim().split("\n").length <= 3) return true;
  return false;
}

function hasExistingEntry(docContent: string, filePath: string): boolean {
  const escaped = filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\`${escaped}\`|\\*\\*${escaped}\\*\\*`).test(docContent);
}

function removeExistingEntry(docContent: string, filePath: string): string {
  const escaped = filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tableRowPattern = new RegExp(
    `\\n\\|[^\\n]*\`${escaped}\`[^\\n]*\\n?`,
    "g"
  );
  docContent = docContent.replace(tableRowPattern, "\n");
  const boldEntryPattern = new RegExp(
    `\\n\\*\\*${escaped}\\*\\*[^#]*?(?=\\n\\*\\*|\\n##|$)`,
    "g"
  );
  docContent = docContent.replace(boldEntryPattern, "");
  return docContent;
}

function detectModuleChanges(change: CodeChange): boolean {
  return change.filePath.startsWith("src/") &&
    (change.filePath.endsWith(".ts") || change.filePath.endsWith(".js"));
}

function detectConfigChanges(change: CodeChange): boolean {
  return change.filePath.includes("config") ||
    change.filePath.includes(".json") ||
    change.filePath.endsWith(".yaml") ||
    change.filePath.endsWith(".yml");
}

function detectTestChanges(change: CodeChange): boolean {
  return change.filePath.includes("test") || change.filePath.includes("spec");
}

function detectErrorPatterns(content: string): string[] {
  const patterns: string[] = [];
  const errorKeywords = [
    "Error:", "Exception:", "failed:", "failure:",
    "undefined is not a function", "Cannot read property",
    "TypeError", "ReferenceError", "SyntaxError",
    "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT",
    "out of memory", "stack overflow",
    "timeout", "deadlock", "race condition"
  ];

  for (const keyword of errorKeywords) {
    if (content.toLowerCase().includes(keyword.toLowerCase())) {
      patterns.push(keyword);
    }
  }
  return [...new Set(patterns)];
}

function extractImports(content: string): string[] {
  const imports: string[] = [];
  const importRegex = /import\s+.*?from\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }
  return imports;
}

function extractExports(content: string): string[] {
  const exports: string[] = [];
  const exportRegex = /export\s+(?:class|function|const|interface|type|async\s+function)\s+(\w+)/g;
  let match;
  while ((match = exportRegex.exec(content)) !== null) {
    exports.push(match[1]);
  }
  return exports;
}

async function analyzeChange(change: CodeChange): Promise<DocUpdatePlan> {
  const plan: DocUpdatePlan = {};
  const { filePath, changeType, oldContent, newContent } = change;
  const content = newContent || oldContent || "";

  if (isIgnoredForAnalysis(filePath)) return plan;
  if (isStubContent(content) && changeType !== "delete") return plan;

  const isSourceFile = detectModuleChanges(change);
  const isConfigFile = detectConfigChanges(change);
  const isTestFile = detectTestChanges(change);

  const date = new Date().toISOString().split("T")[0];
  plan.changelog = `### ${date} — Auto-Documented\n- **${changeType}**: \`${filePath}\``;

  if (isSourceFile) {
    const imports = extractImports(content);
    const exports = extractExports(content);

    if (changeType === "write" || changeType === "edit") {
      if (exports.length >= MIN_EXPORTS_FOR_ENTRY || imports.length >= MIN_IMPORTS_FOR_ENTRY) {
        plan.systemMap = {
          action: changeType === "write" ? "add" : "update",
          section: "Module Inventory",
          content: `**${filePath}**\n- Exports: ${exports.join(", ") || "none"}\n- Imports: ${imports.slice(0, 5).join(", ")}${imports.length > 5 ? "..." : ""}\n- Type: ${isTestFile ? "test" : "source"}`
        };
      }
    }

    if (changeType === "delete") {
      plan.systemMap = {
        action: "remove",
        section: "Module Inventory",
        content: filePath
      };
    }

    if (content.includes("decision") || content.includes("architecture") ||
        content.includes("why") || content.includes("trade-off") ||
        content.includes("DECISION:") || content.includes("Rationale:")) {
      plan.decisions = {
        action: "add",
        section: "Architecture Decisions",
        content: `**${filePath}** - ${date}\n${content.slice(0, 500)}...`
      };
    }

    const errorPatterns = detectErrorPatterns(content);
    if (errorPatterns.length > 0) {
      plan.debugNotes = {
        action: "add",
        section: "Error Patterns",
        content: `**${filePath}** (${date})\nDetected: ${errorPatterns.join(", ")}\nContext: ${content.slice(0, 300)}...`
      };
    }

    if (content.includes("lesson") || content.includes("convention") ||
        content.includes("don't repeat") || content.includes("DONT_REPEAT") ||
        content.includes("rule:") || content.includes("Rule:")) {
      plan.agentMemory = {
        action: "add",
        section: "Lessons Learned",
        content: `**${filePath}** (${date})\n${content.slice(0, 500)}...`
      };
    }
  }

  if (isConfigFile || isTestFile) {
    if (content.includes("npm run") || content.includes("test:") ||
        content.includes("build:") || content.includes("lint") ||
        content.includes("command") || content.includes("script:")) {
      plan.runbook = {
        action: "add",
        section: "Commands",
        content: `**${filePath}** (${date})\n${content.slice(0, 500)}...`
      };
    }
  }

  return plan;
}

export function updateDocContent(
  docContent: string,
  section: string,
  entry: string,
  filePath: string,
): string {
  if (hasExistingEntry(docContent, filePath)) {
    docContent = removeExistingEntry(docContent, filePath);
  }
  const marker = `## ${section}`;
  const insertIdx = docContent.indexOf(marker);
  if (insertIdx === -1) return docContent;
  const nextSection = docContent.indexOf("\n##", insertIdx + marker.length);
  const insertPoint = nextSection !== -1 ? nextSection : docContent.length;
  return docContent.slice(0, insertPoint) + `\n${entry}\n` + docContent.slice(insertPoint);
}

export function shouldSkipEntry(exports: string[], imports: string[]): boolean {
  return exports.length < MIN_EXPORTS_FOR_ENTRY && imports.length < MIN_IMPORTS_FOR_ENTRY;
}

async function applyDocUpdate(plan: DocUpdatePlan): Promise<void> {
  if (plan.systemMap) {
    let content = await readDoc("SYSTEM_MAP.md");
    if (plan.systemMap.action === "remove") {
      content = removeExistingEntry(content, plan.systemMap.content);
    } else {
      const filePath = plan.systemMap.content.split("\n")[0].replace(/\*\*/g, "").trim();
      content = updateDocContent(content, plan.systemMap.section, plan.systemMap.content, filePath);
    }
    await writeDoc("SYSTEM_MAP.md", content);
  }

  if (plan.decisions) {
    let content = await readDoc("DECISIONS.md");
    const filePath = plan.decisions.content.split("\n")[0].replace(/\*\*/g, "").trim();
    content = updateDocContent(content, plan.decisions.section, plan.decisions.content, filePath);
    await writeDoc("DECISIONS.md", content);
  }

  if (plan.debugNotes) {
    let content = await readDoc("DEBUG_NOTES.md");
    const filePath = plan.debugNotes.content.split("\n")[0].replace(/\*\*/g, "").trim();
    content = updateDocContent(content, plan.debugNotes.section, plan.debugNotes.content, filePath);
    await writeDoc("DEBUG_NOTES.md", content);
  }

  if (plan.agentMemory) {
    let content = await readDoc("AGENT_MEMORY.md");
    const filePath = plan.agentMemory.content.split("\n")[0].replace(/\*\*/g, "").trim();
    content = updateDocContent(content, plan.agentMemory.section, plan.agentMemory.content, filePath);
    await writeDoc("AGENT_MEMORY.md", content);
  }

  if (plan.runbook) {
    let content = await readDoc("RUNBOOK.md");
    const filePath = plan.runbook.content.split("\n")[0].replace(/\*\*/g, "").trim();
    content = updateDocContent(content, plan.runbook.section, plan.runbook.content, filePath);
    await writeDoc("RUNBOOK.md", content);
  }
}

export async function autoDocumentChange(
  filePath: string,
  changeType: "write" | "edit" | "delete",
  oldContent?: string,
  newContent?: string
): Promise<void> {
  const change: CodeChange = { filePath, changeType, oldContent, newContent };
  const plan = await analyzeChange(change);
  await applyDocUpdate(plan);
}

export {
  CodeChange, DocUpdatePlan, analyzeChange, applyDocUpdate,
  hasExistingEntry, removeExistingEntry,
  extractImports, extractExports, detectErrorPatterns,
};