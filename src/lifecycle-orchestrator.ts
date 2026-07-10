/**
 * LifecycleOrchestrator — single timer, three maintenance jobs.
 *
 * Owns:
 *   1. selfModel.updateIntervalMs   → selfModel.updateAll()
 *   2. beliefKnowledge.consolidationIntervalMs → beliefKnowledge.consolidate()
 *   3. livingState.updateIntervalMs → livingState.runPreviewPass()
 *
 * Per-job: nextDue check, running lock, error isolation, optional debounced trigger.
 * No duplicate runs. No timer drift. Clean dispose.
 */

import { getLogger } from './logger.js';
import type { PluginContext } from './plugin-context.js';

interface JobConfig {
  name: string;
  intervalMs: number;
  run: (ctx: PluginContext) => Promise<void>;
}

interface JobState {
  name: string;
  intervalMs: number;
  nextDue: number;
  running: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  lastError: string | null;
  runCount: number;
  run: (ctx: PluginContext) => Promise<void>;
}

export class LifecycleOrchestrator {
  private jobs: JobState[] = [];
  private ctx: PluginContext;
  private disposed = false;
  private baseTickMs = 5000;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private logging = getLogger();

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
  }

  start(): void {
    const configs = this.buildJobConfigs();
    const now = Date.now();

    for (const cfg of configs) {
      this.jobs.push({
        name: cfg.name,
        intervalMs: cfg.intervalMs,
        nextDue: now + cfg.intervalMs,
        running: false,
        timer: null,
        lastError: null,
        runCount: 0,
        run: cfg.run,
      });
      this.logging.info(`lifecycle job "${cfg.name}" scheduled every ${cfg.intervalMs}ms`);
    }

    this.tickTimer = setInterval(() => this.tick(), this.baseTickMs);
    this.logging.info(`lifecycle orchestrator started (${this.jobs.length} jobs, tick=${this.baseTickMs}ms)`);
  }

  stop(): void {
    this.disposed = true;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    for (const job of this.jobs) {
      if (job.timer) {
        clearTimeout(job.timer);
        job.timer = null;
      }
    }
    this.logging.info('lifecycle orchestrator stopped');
  }

  private firstRunDone = false;

  private tick(): void {
    if (this.disposed) return;
    const now = Date.now();

    for (const job of this.jobs) {
      if (job.running) continue;
      if (now < job.nextDue) continue;
      this.runJob(job);
    }
  }

  private async runJob(job: JobState): Promise<void> {
    if (job.running) return;
    job.running = true;

    try {
      await job.run(this.ctx);
      job.runCount++;
      job.lastError = null;
    } catch (err) {
      job.lastError = err instanceof Error ? err.message : String(err);
      this.logging.warn(`lifecycle job "${job.name}" failed: ${job.lastError}`);
    } finally {
      job.running = false;
      job.nextDue = Date.now() + job.intervalMs;
    }
  }

  triggerDebounced(jobName: string, debounceMs = 5000): void {
    if (this.disposed) return;
    const job = this.jobs.find(j => j.name === jobName);
    if (!job || job.running) return;

    const now = Date.now();
    if (job.nextDue - now < debounceMs) return;
    job.nextDue = now + debounceMs;
  }

  private buildJobConfigs(): JobConfig[] {
    const config = this.ctx.config;
    const jobs: JobConfig[] = [];
    if (config.selfModel?.enabled) {
      jobs.push({
        name: 'self-model',
        intervalMs: config.selfModel?.updateIntervalMs ?? 60_000,
        run: async (ctx) => {
          await ctx.selfModel.updateAll();
        },
      });
    }
    if (config.beliefKnowledge?.enabled) {
      jobs.push({
        name: 'belief-consolidation',
        intervalMs: config.beliefKnowledge?.consolidationIntervalMs ?? 120_000,
        run: async (ctx) => {
          if (!this.firstRunDone) {
            this.firstRunDone = true;
            await ctx.beliefKnowledge.migrateStalePreferenceEntries();
          }
          await ctx.beliefKnowledge.consolidate();
        },
      });
    }
    if (config.livingState?.enabled) {
      jobs.push({
        name: 'living-state',
        intervalMs: config.livingState?.updateIntervalMs ?? 60_000,
        run: async (ctx) => {
          if (!ctx.config.livingState?.enabled) return;
          await ctx.livingState.runPass();
        },
      });
    }
    return jobs;
  }

  getStatus(): Array<{
    name: string;
    intervalMs: number;
    nextDue: number;
    running: boolean;
    lastError: string | null;
    runCount: number;
  }> {
    return this.jobs.map(j => ({
      name: j.name,
      intervalMs: j.intervalMs,
      nextDue: j.nextDue,
      running: j.running,
      lastError: j.lastError,
      runCount: j.runCount,
    }));
  }
}
