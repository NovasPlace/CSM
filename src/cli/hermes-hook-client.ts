#!/usr/bin/env node
import net from 'node:net';
import { codexHookEndpoint } from '../codex-hook-relay.js';
import { HERMES_HOST_PROFILE } from '../native-host-profile.js';
import {
  buildCanonicalPayload,
  mapHermesEvent,
  translateResponse,
  type HermesHookPayload,
} from '../hermes-hook-mapping.js';

/**
 * Hermes lifecycle hook client.
 *
 * Hermes shells this out once per lifecycle event with a JSON payload on stdin
 * (see the Hermes "Shell Hooks" wire protocol). The pure translation logic
 * (event-name + field mapping, response shaping) lives in
 * `src/hermes-hook-mapping.ts`; this file is the I/O shell that reads stdin,
 * forwards the canonical payload to the hermes-profiled lifecycle relay, and
 * writes the Hermes-shaped response to stdout. If the relay is unreachable it
 * emits a safe no-op so the Hermes session is never blocked.
 */
await run();

async function run(): Promise<void> {
  const source = await readStdin();
  let hermesEvent = '';
  let payload: HermesHookPayload = {};
  try {
    payload = JSON.parse(source) as HermesHookPayload;
    hermesEvent = typeof payload.hook_event_name === 'string' && payload.hook_event_name.trim()
      ? payload.hook_event_name.trim()
      : '';
  } catch {
    process.stdout.write('{}\n');
    return;
  }

  const canonical = mapHermesEvent(hermesEvent);
  if (!canonical) {
    process.stdout.write('{}\n');
    return;
  }

  const forwarded = JSON.stringify(buildCanonicalPayload(payload, canonical));
  try {
    process.stdout.write(translateResponse(await relay(forwarded), hermesEvent));
  } catch {
    process.stdout.write('{}\n');
  }
}

function relay(payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(codexHookEndpoint(undefined, HERMES_HOST_PROFILE));
    let result = '';
    const timeout = setTimeout(() => socket.destroy(new Error('CSM Hermes hook relay timed out.')), 25_000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${payload.trim()}\n`));
    socket.on('data', (chunk: Buffer | string) => { result += chunk; });
    socket.on('end', () => {
      clearTimeout(timeout);
      resolve(result);
    });
    socket.on('error', (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { value += chunk; });
    process.stdin.on('end', () => resolve(value));
    process.stdin.on('error', reject);
  });
}
