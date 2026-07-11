import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';
import { TextDecoder } from 'node:util';

const TEXT_EXTENSIONS = new Set([
  '.cjs', '.css', '.cts', '.env', '.graphql', '.gql', '.html', '.ini',
  '.js', '.json', '.jsx', '.md', '.mjs', '.mts', '.ps1', '.py', '.sh',
  '.sql', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml',
]);

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const TEXT_DOTFILES = new Set(['.env']);

export function hashArtifactContent(path: string, bytes: Buffer): string {
  const content = isTextArtifact(path) ? canonicalTextBytes(path, bytes) : bytes;
  return createHash('sha256').update(content).digest('hex');
}

export function isTextArtifact(path: string): boolean {
  const name = basename(path).toLowerCase();
  return TEXT_DOTFILES.has(name) || TEXT_EXTENSIONS.has(extname(name));
}

function canonicalTextBytes(path: string, bytes: Buffer): Buffer {
  const hasBom = bytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM);
  const payload = hasBom ? bytes.subarray(UTF8_BOM.length) : bytes;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } catch {
    throw new Error(`Immutable text artifact is not valid UTF-8: ${path}`);
  }
  const canonical = canonicalLineEndings(path, text);
  const encoded = Buffer.from(canonical, 'utf8');
  return hasBom ? Buffer.concat([UTF8_BOM, encoded]) : encoded;
}

function canonicalLineEndings(path: string, text: string): string {
  let sawCrLf = false;
  let sawLf = false;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\r') {
      if (text[index + 1] !== '\n') {
        throw new Error(`Immutable text artifact contains a bare CR line ending: ${path}`);
      }
      sawCrLf = true;
      index += 1;
    } else if (text[index] === '\n') {
      sawLf = true;
    }
  }
  if (sawCrLf && sawLf) {
    throw new Error(`Immutable text artifact contains mixed LF and CRLF line endings: ${path}`);
  }
  return sawCrLf ? text.replace(/\r\n/g, '\n') : text;
}
