#!/usr/bin/env node
import { runNativeHookClient } from './native-hook-client.js';
import { CLAUDE_HOST_PROFILE } from '../native-host-profile.js';

await runNativeHookClient(CLAUDE_HOST_PROFILE);
