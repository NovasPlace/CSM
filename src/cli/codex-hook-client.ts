#!/usr/bin/env node
import { runNativeHookClient } from './native-hook-client.js';
import { CODEX_HOST_PROFILE } from '../native-host-profile.js';

await runNativeHookClient(CODEX_HOST_PROFILE);
