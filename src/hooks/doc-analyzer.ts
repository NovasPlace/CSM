import { PluginContext } from "../plugin-context.js";
import { promises as fs } from "fs";
import { join, normalize } from "path";

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
  const exportRegex = /export\s+(?:class|function|const|interface|type)\s+(\w+)/g;
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
  
  const isSourceFile = detectModuleChanges(change);
  const isConfigFile = detectConfigChanges(change);
  const isTestFile = detectTestChanges(change);
  
  // CHANGELOG - always update
  const date = new Date().toISOString().split("T")[0];
  plan.changelog = `### ${date} — Auto-Documented\n- **${changeType}**: \`${filePath}\``;
  
  if (isSourceFile) {
    // SYSTEM_MAP - track module structure
    const imports = extractImports(content);
    const exports = extractExports(content);
    
    if (changeType === "write" || changeType === "edit") {
      plan.systemMap = {
        action: changeType === "write" ? "add" : "update",
        section: "Module Inventory",
        content: `**${filePath}**\n- Exports: ${exports.join(", ") || "none"}\n- Imports: ${imports.slice(0, 5).join(", ")}${imports.length > 5 ? "..." : ""}\n- Type: ${isTestFile ? "test" : "source"}`
      };
    }
    
    // DECISIONS - detect architecture patterns
    if (content.includes("decision") || content.includes("architecture") || 
        content.includes("why") || content.includes("trade-off") ||
        content.includes("DECISION:") || content.includes("Rationale:")) {
      plan.decisions = {
        action: "add",
        section: "Architecture Decisions",
        content: `**${filePath}** - ${date}\n${content.slice(0, 500)}...`
      };
    }
    
    // DEBUG_NOTES - detect error patterns
    const errorPatterns = detectErrorPatterns(content);
    if (errorPatterns.length > 0) {
      plan.debugNotes = {
        action: "add",
        section: "Error Patterns",
        content: `**${filePath}** (${date})\nDetected: ${errorPatterns.join(", ")}\nContext: ${content.slice(0, 300)}...`
      };
    }
    
    // AGENT_MEMORY - detect lessons/conventions
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
    // RUNBOOK - track config/test command changes
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

async function applyDocUpdate(plan: DocUpdatePlan): Promise<void> {
  const date = new Date().toISOString().split("T")[0];
  
  if (plan.systemMap) {
    const content = await readDoc("SYSTEM_MAP.md");
    if (plan.systemMap.action === "add") {
      const marker = "## Module Inventory";
      const insertIdx = content.indexOf(marker);
      if (insertIdx !== -1) {
        const nextSection = content.indexOf("##", insertIdx + marker.length);
        const insertPoint = nextSection !== -1 ? nextSection : content.length;
        const newContent = content.slice(0, insertPoint) + 
          `\n${plan.systemMap.content}\n` + content.slice(insertPoint);
        await writeDoc("SYSTEM_MAP.md", newContent);
      }
    }
  }
  
  if (plan.decisions) {
    const content = await readDoc("DECISIONS.md");
    const marker = "## Architecture Decisions";
    const insertIdx = content.indexOf(marker);
    if (insertIdx !== -1) {
      const nextSection = content.indexOf("##", insertIdx + marker.length);
      const insertPoint = nextSection !== -1 ? nextSection : content.length;
      const newContent = content.slice(0, insertPoint) + 
        `\n${plan.decisions.content}\n` + content.slice(insertPoint);
      await writeDoc("DECISIONS.md", newContent);
    }
  }
  
  if (plan.debugNotes) {
    const content = await readDoc("DEBUG_NOTES.md");
    const marker = "## Error Patterns";
    const insertIdx = content.indexOf(marker);
    if (insertIdx !== -1) {
      const nextSection = content.indexOf("##", insertIdx + marker.length);
      const insertPoint = nextSection !== -1 ? nextSection : content.length;
      const newContent = content.slice(0, insertPoint) + 
        `\n${plan.debugNotes.content}\n` + content.slice(insertPoint);
      await writeDoc("DEBUG_NOTES.md", newContent);
    }
  }
  
  if (plan.agentMemory) {
    const content = await readDoc("AGENT_MEMORY.md");
    const marker = "## Lessons Learned";
    const insertIdx = content.indexOf(marker);
    if (insertIdx !== -1) {
      const nextSection = content.indexOf("##", insertIdx + marker.length);
      const insertPoint = nextSection !== -1 ? nextSection : content.length;
      const newContent = content.slice(0, insertPoint) + 
        `\n${plan.agentMemory.content}\n` + content.slice(insertPoint);
      await writeDoc("AGENT_MEMORY.md", newContent);
    }
  }
  
  if (plan.runbook) {
    const content = await readDoc("RUNBOOK.md");
    const marker = "## Commands";
    const insertIdx = content.indexOf(marker);
    if (insertIdx !== -1) {
      const nextSection = content.indexOf("##", insertIdx + marker.length);
      const insertPoint = nextSection !== -1 ? nextSection : content.length;
      const newContent = content.slice(0, insertPoint) + 
        `\n${plan.runbook.content}\n` + content.slice(insertPoint);
      await writeDoc("RUNBOOK.md", newContent);
    }
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

export { CodeChange, DocUpdatePlan, analyzeChange, applyDocUpdate };