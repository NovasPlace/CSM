import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';

const ROOT = 'src/coordination-persistence';
const FILES = readdirSync(ROOT).filter((name) => name.endsWith('.ts')).map((name) => join(ROOT, name));

it('keeps every Coordination persistence source file at or below 200 lines', () => {
  for (const path of FILES) {
    const lines = readFileSync(path, 'utf8').split(/\r?\n/).length;
    assert.ok(lines <= 200, `${basename(path)} has ${lines} lines`);
  }
});

it('keeps every Coordination persistence function at or below 40 lines', () => {
  for (const path of FILES) {
    const source = parse(path);
    visitFunctions(source, (node) => {
      const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const end = source.getLineAndCharacterOfPosition(node.end).line + 1;
      assert.ok(end - start + 1 <= 40, `${basename(path)}:${start} spans ${end - start + 1} lines`);
    });
  }
});

it('parses every Coordination persistence source without syntax diagnostics', () => {
  for (const path of FILES) assert.equal(parse(path).parseDiagnostics.length, 0, path);
});

it('contains no forbidden persistence, execution, or production print APIs', () => {
  const forbidden = /\b(?:better-sqlite3|sqlite3|redis|sqlalchemy|eval\s*\(|exec\s*\(|print\s*\()/i;
  for (const path of FILES) assert.doesNotMatch(readFileSync(path, 'utf8'), forbidden, path);
});

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function visitFunctions(source: ts.SourceFile, check: (node: ts.Node) => void): void {
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node)) check(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function isFunctionLike(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)
    || ts.isConstructorDeclaration(node);
}
