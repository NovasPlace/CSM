declare module "solid-js" {
  export function createSignal<T = unknown>(value: T): [() => T, (v: T | ((prev: T) => T)) => void];
  export function createEffect(fn: () => void): void;
  export function onCleanup(fn: () => void): void;
  export function createMemo<T = unknown>(fn: () => T): () => T;
  export function onMount(fn: () => void): void;

  export namespace JSX {
    type Element = unknown;
    type IntrinsicElements = Record<string, Record<string, unknown>>;
  }
}

declare module "solid-js/h" {
  export function h(type: string | ((...args: unknown[]) => unknown), props?: Record<string, unknown> | null, ...children: unknown[]): unknown;
}

declare module "solid-js/jsx-runtime" {
  export const jsx: (tag: string | ((...args: unknown[]) => unknown), props: Record<string, unknown>) => unknown;
  export const jsxs: (tag: string | ((...args: unknown[]) => unknown), props: Record<string, unknown>) => unknown;
  export const Fragment: unique symbol;
}

declare module "@opentui/core" {
  export type RGBA = [number, number, number, number];
  export type Renderable = unknown;
  export type KeyEvent = {
    key: string;
    ctrl?: boolean;
    shift?: boolean;
    alt?: boolean;
  };
  export type SlotMode = "replace" | "append" | "prepend";
  export type CliRenderer = unknown;
}

declare module "@opentui/solid" {
  export type JSX = {
    Element: unknown;
  };

  export type SolidPlugin<Map extends Record<string, object>, Context> = {
    id?: string;
  } & {
    [K in keyof Map]?: (props: Map[K] & Context) => JSX.Element;
  };
}

declare module "@opentui/keymap" {
  export type Binding<V = unknown, E = unknown> = {
    command: string;
    value?: V;
    keys?: string[];
  };
  export type Keymap<V = unknown, E = unknown> = unknown;
  export type KeyLike = unknown;
  export type KeySequencePart = unknown;
  export type KeyStringifyInput = unknown;
  export type StringifyOptions = unknown;
  export function stringifyKeySequence(...args: unknown[]): string;
  export function stringifyKeyStroke(...args: unknown[]): string;
}

declare module "@opentui/keymap/extras" {
  export type BindingConfig<V = unknown, E = unknown> = unknown;
  export type BindingLookup<V = unknown, E = unknown> = {
    bindings: unknown[];
    get(command: string): unknown[];
    has(command: string): boolean;
    gather(name: string, commands: string[]): unknown[];
    pick(name: string, commands: string[]): unknown[];
    omit(name: string, commands: string[]): unknown[];
  };
  export type BindingValue = unknown;
  export function createBindingLookup(config: unknown, options?: unknown): BindingLookup;
  export function formatCommandBindings(...args: unknown[]): string;
  export function formatKeySequence(...args: unknown[]): string;
}
