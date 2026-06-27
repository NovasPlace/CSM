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
  if (isIgnoredForAnalysis(change.filePath)) return false;
  return (change.filePath.endsWith(".ts") || change.filePath.endsWith(".js"));
}

function isRootMarkdownDoc(change: CodeChange): boolean {
  const baseName = change.filePath.split("/").pop() || "";
  const importantRootDocs = [
    "README.md",
    "MANIFESTO.md",
    "IMPLEMENTATION_AGENT_PROTOCOL.md",
    "AGENT_BOOT_PROTOCOL.md",
    "ARCHITECTURE.md",
    "DECISIONS.md",
    "RUNBOOK.md",
    "CHANGELOG.md",
  ];
  return change.filePath === baseName && importantRootDocs.includes(baseName);
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

  // Handle root-level protocol/manifesto/architecture docs
  if (isRootMarkdownDoc(change)) {
    const sectionMap: Record<string, string> = {
      "MANIFESTO.md": "Manifesto",
      "IMPLEMENTATION_AGENT_PROTOCOL.md": "Agent Protocols",
      "AGENT_BOOT_PROTOCOL.md": "Agent Protocols",
      "ARCHITECTURE.md": "Architecture",
      "DECISIONS.md": "Architecture Decisions",
      "RUNBOOK.md": "Runbook",
      "CHANGELOG.md": "Changelog",
    };
    const section = sectionMap[filePath] || "Project Docs";
    plan.agentMemory = {
      action: changeType === "delete" ? "remove" : "add",
      section,
      content: `**${filePath}** (${date})\n${content.slice(0, 1000)}...`
    };
    if (filePath === "README.md") {
      plan.runbook = {
        action: changeType === "delete" ? "remove" : "add",
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
  if (insertIdx === -1) {
    // Section doesn't exist, append at end with new section header
    return docContent.trimEnd() + `\n\n## ${section}\n${entry}\n`;
  }
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

export async function reconcileSystemMap(docsDir?: string): Promise<{ added: number; updated: number; removed: number }> {
  const dir = docsDir ?? getDocsDir();
  const cwd = process.cwd();
  let added = 0, updated = 0, removed = 0;

  let systemMapContent: string;
  try {
    systemMapContent = await fs.readFile(join(dir, "SYSTEM_MAP.md"), "utf-8");
  } catch {
    return { added: 0, updated: 0, removed: 0 };
  }

  const sourceDirs = await detectSourceDirs(cwd);
  const allSourceFiles: Array<{ relativePath: string; dirPrefix: string }> = [];
  for (const srcDir of sourceDirs) {
    const dirName = srcDir.relativeName;
    const files = await scanSourceFiles(srcDir.absolutePath);
    for (const sf of files) {
      allSourceFiles.push({ relativePath: `${dirName}/${sf.relativePath}`, dirPrefix: dirName });
    }
  }

  const docEntries = parseSystemMapEntries(systemMapContent);
  const docFileSet = new Set(docEntries.map(e => e.filePath));
  const tableHeader = "| File | Exports | Type | Role |";

  for (const sf of allSourceFiles) {
    const relativePath = sf.relativePath;
    const existing = docEntries.find(e => e.filePath === relativePath);

    let content: string;
    try {
      content = await fs.readFile(join(cwd, relativePath), "utf-8");
    } catch {
      continue;
    }

    if (isStubContent(content)) continue;

    const exports = extractExports(content);
    const isTest = sf.relativePath.includes("test") || sf.relativePath.includes("spec");
    const modType = isTest ? "test" : guessModuleType(sf.relativePath);
    const role = guessModuleRole(sf.relativePath, exports);

    const newRow = `| \`${relativePath}\` | ${exports.join(", ") || "none"} | ${modType} | ${role} |`;

    if (!existing) {
      const insertPoint = findTableInsertPoint(systemMapContent, tableHeader);
      if (insertPoint !== -1) {
        systemMapContent = systemMapContent.slice(0, insertPoint) + newRow + "\n" + systemMapContent.slice(insertPoint);
        added++;
      }
    } else {
      const oldRow = `| \`${relativePath}\` | ${existing.exports} | ${existing.type} | ${existing.role} |`;
      if (oldRow !== newRow && systemMapContent.includes(oldRow)) {
        systemMapContent = systemMapContent.replace(oldRow, newRow);
        updated++;
      }
    }
  }

  const knownFiles = new Set(allSourceFiles.map(sf => sf.relativePath));
  for (const entry of docEntries) {
    if (knownFiles.has(entry.filePath)) continue;
    const relativeParts = entry.filePath.split("/");
    if (relativeParts.length < 2) continue;
    const rowPattern = new RegExp(`\\| \\\`${entry.filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\\`[^\\n]*\\n?`, "g");
    const before = systemMapContent;
    systemMapContent = systemMapContent.replace(rowPattern, "");
    if (systemMapContent !== before) removed++;
  }

  if (added > 0 || updated > 0 || removed > 0) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, "SYSTEM_MAP.md"), systemMapContent, "utf-8");
  }

  return { added, updated, removed };
}

interface SourceFile {
  relativePath: string;
}

interface SourceDir {
  absolutePath: string;
  relativeName: string;
}

async function detectSourceDirs(cwd: string): Promise<SourceDir[]> {
  const results: SourceDir[] = [];
  const alwaysInclude = ["src", "lib", "core", "harness", "distiller", "runtime", "vault", "engine", "modules", "packages"];
  let entries;
  try {
    entries = await fs.readdir(cwd, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git" || entry.name === "coverage") continue;
    const hasTsFiles = await dirHasCodeFiles(join(cwd, entry.name));
    if (alwaysInclude.includes(entry.name) || hasTsFiles) {
      results.push({ absolutePath: join(cwd, entry.name), relativeName: entry.name });
    }
  }
  if (results.length === 0) {
    try {
      const stat = await fs.stat(join(cwd, "src"));
      if (stat.isDirectory()) results.push({ absolutePath: join(cwd, "src"), relativeName: "src" });
    } catch {}
  }
  return results;
}

async function dirHasCodeFiles(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.some(e => e.isFile() && (e.name.endsWith(".ts") || e.name.endsWith(".js") || e.name.endsWith(".tsx") || e.name.endsWith(".jsx")));
  } catch {
    return false;
  }
}

async function scanSourceFiles(srcDir: string): Promise<SourceFile[]> {
  const results: SourceFile[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const fullPath = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(fullPath, rel);
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) {
        results.push({ relativePath: rel });
      }
    }
  }
  await walk(srcDir, "");
  return results;
}

interface SystemMapEntry {
  filePath: string;
  exports: string;
  type: string;
  role: string;
}

function parseSystemMapEntries(content: string): SystemMapEntry[] {
  const entries: SystemMapEntry[] = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const match = line.match(/^\| `([^`]+)` \| (.+?) \| (.+?) \| (.+?) \|$/);
    if (match) {
      entries.push({ filePath: match[1], exports: match[2], type: match[3], role: match[4] });
    }
  }
  return entries;
}

function findTableInsertPoint(content: string, tableHeader: string): number {
  const headerIdx = content.indexOf(tableHeader);
  if (headerIdx === -1) return -1;
  let afterHeader = headerIdx + tableHeader.length;
  const separatorLine = content.indexOf("\n", afterHeader);
  if (separatorLine === -1) return -1;
  afterHeader = content.indexOf("\n", separatorLine + 1);
  if (afterHeader === -1) return -1;
  return afterHeader + 1;
}

function guessModuleType(relativePath: string): string {
  const parts = relativePath.replace(/\\/g, "/").split("/");
  if (parts.length > 1) return parts[0];
  return "source";
}

function guessModuleRole(relativePath: string, exports: string[]): string {
  const name = relativePath.toLowerCase();
  if (name.includes("hook")) return "Hook handler";
  if (name.includes("tool")) return "Tool registration";
  if (name.includes("test") || name.includes("spec")) return "Test suite";
  if (name.includes("schema")) return "SQL schema";
  if (name.includes("config")) return "Configuration";
  if (exports.includes("Database")) return "PostgreSQL connection & schema";
  if (exports.some(e => e.includes("Compaction") || e.includes("Compactor"))) return "Context compaction engine";
  if (exports.some(e => e.includes("Memory") || e.includes("Recall"))) return "Memory & recall subsystem";
  if (exports.some(e => e.includes("Analytics"))) return "Usage analytics & reporting";
  if (exports.some(e => e.includes("Quality"))) return "Quality measurement";
  if (exports.some(e => e.includes("Prune"))) return "Memory pruning scorer";
  return "Module";
}

export {
  CodeChange, DocUpdatePlan, analyzeChange, applyDocUpdate,
  hasExistingEntry, removeExistingEntry,
  extractImports, extractExports, detectErrorPatterns,
};