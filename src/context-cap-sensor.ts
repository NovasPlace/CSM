import { getLogger } from './logger.js';

export type InjectionTrimLevel = 'full' | 'trim_advisory' | 'drop_vcm' | 'refs_only' | 'minimal';

export interface CapPressure {
  estimatedTokens: number;
  targetCap: number;
  pressure: number;
  trimLevel: InjectionTrimLevel;
  action: string;
}

function estimateTokensFromParts(systemParts: string[]): number {
  let chars = 0;
  for (const part of systemParts) {
    chars += (part ?? '').length;
  }
  return Math.ceil(chars / 4);
}

export class ContextCapSensor {
  private targetCap: number;

  constructor(targetCap: number) {
    this.targetCap = targetCap;
  }

  sense(systemParts: string[]): CapPressure {
    const estimatedTokens = estimateTokensFromParts(systemParts);
    const pressure = this.targetCap > 0 ? estimatedTokens / this.targetCap : 0;
    const trimLevel = this.chooseTrimLevel(pressure);
    const action = this.actionLabel(trimLevel);
    getLogger().debug(`ContextCapSensor: est=${estimatedTokens} cap=${this.targetCap} pressure=${pressure.toFixed(2)} trim=${trimLevel}`);
    return { estimatedTokens, targetCap: this.targetCap, pressure, trimLevel, action };
  }

  private chooseTrimLevel(pressure: number): InjectionTrimLevel {
    if (pressure >= 0.9) return 'minimal';
    if (pressure >= 0.8) return 'refs_only';
    if (pressure >= 0.7) return 'drop_vcm';
    if (pressure >= 0.6) return 'trim_advisory';
    return 'full';
  }

  private actionLabel(level: InjectionTrimLevel): string {
    switch (level) {
      case 'full': return 'OK: all CSM injections active';
      case 'trim_advisory': return 'TRIM: advisory block compressed to 200 chars';
      case 'drop_vcm': return 'DROP: VCM working-set block skipped';
      case 'refs_only': return 'COMPRESS: memory brief reduced to checkpoint refs';
      case 'minimal': return 'MINIMAL: only memory governance vetoes injected';
    }
  }
}

export function shouldInjectAdvisory(level: InjectionTrimLevel): boolean {
  return level === 'full' || level === 'trim_advisory' || level === 'drop_vcm';
}

export function advisoryCharBudget(level: InjectionTrimLevel, base: number): number {
  if (level === 'trim_advisory') return Math.min(base, 200);
  return base;
}

export function shouldInjectVcm(level: InjectionTrimLevel): boolean {
  return level === 'full' || level === 'trim_advisory';
}

export function shouldInjectFullMemoryBrief(level: InjectionTrimLevel): boolean {
  return level === 'full' || level === 'trim_advisory' || level === 'drop_vcm';
}
