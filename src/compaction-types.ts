/**
 * Tool-part shape interfaces extracted from context-compactor.ts
 * to keep the main compactor file under the 200-line limit.
 */

export interface ToolPartLike {
  type: string;
  tool?: string;
  text?: string;
  state?: {
    status?: string;
    output?: string;
    error?: string;
    input?: unknown;
    time?: {
      start?: number;
      end?: number;
      compacted?: number;
    };
  };
}

export interface ToolPartLocation {
  msgIndex: number;
  partIndex: number;
  part: ToolPartLike;
}
