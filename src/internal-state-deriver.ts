export interface InternalState {
  cognitiveLoad: number;
  frustration: number;
  energy: number;
  dominantEmotion: 'neutral' | 'frustration' | 'success' | 'curiosity' | 'concern';
  stance: 'exploratory' | 'focused' | 'recovery' | 'stuck';
  urgency: number;
}

export interface DeriveInput {
  toolName?: string;
  exitCode?: number;
  error?: string;
  args?: Record<string, unknown>;
  intent?: string;
  recentErrors?: number;
  recentCalls?: number;
  loopDetected?: boolean;
}

const TOOL_STANCE_MAP: Record<string, 'exploratory' | 'focused'> = {
  read: 'exploratory',
  glob: 'exploratory',
  grep: 'exploratory',
  webfetch: 'exploratory',
  websearch: 'exploratory',
  task: 'exploratory',
  write: 'focused',
  edit: 'focused',
  bash: 'focused',
  create_checkpoint: 'focused',
};

export function deriveInternalState(input: DeriveInput, previous?: InternalState): InternalState {
  let cognitiveLoad = 0.1;
  let frustration = 0;
  let energy = 0.8;
  let dominantEmotion: InternalState['dominantEmotion'] = 'neutral';
  let stance: InternalState['stance'] = 'focused';
  let urgency = 0;

  if (input.loopDetected) {
    frustration = Math.min(frustration + 0.6, 1);
    cognitiveLoad = Math.min(cognitiveLoad + 0.4, 1);
    dominantEmotion = 'frustration';
    stance = 'stuck';
    urgency = Math.min(urgency + 0.7, 1);
  }

  if (input.error) {
    frustration = Math.min(frustration + 0.4, 1);
    cognitiveLoad = Math.min(cognitiveLoad + 0.3, 1);
    energy = Math.max(energy - 0.15, 0);
    if (dominantEmotion === 'neutral') dominantEmotion = 'frustration';
    stance = 'recovery';
    urgency = Math.min(urgency + 0.5, 1);
  }

  if (input.exitCode !== undefined && input.exitCode !== 0 && !input.error) {
    frustration = Math.min(frustration + 0.25, 1);
    cognitiveLoad = Math.min(cognitiveLoad + 0.2, 1);
    energy = Math.max(energy - 0.1, 0);
    if (dominantEmotion === 'neutral') dominantEmotion = 'frustration';
    stance = 'recovery';
    urgency = Math.min(urgency + 0.3, 1);
  }

  if (input.recentErrors !== undefined && input.recentErrors > 0) {
    const errorWeight = Math.min(input.recentErrors * 0.15, 0.5);
    frustration = Math.min(frustration + errorWeight, 1);
    cognitiveLoad = Math.min(cognitiveLoad + errorWeight * 0.7, 1);
    energy = Math.max(energy - errorWeight * 0.5, 0);
    urgency = Math.min(urgency + errorWeight * 0.8, 1);
  }

  if (input.recentCalls !== undefined && input.recentCalls > 5) {
    cognitiveLoad = Math.min(cognitiveLoad + (input.recentCalls - 5) * 0.05, 1);
  }

  if (input.toolName && TOOL_STANCE_MAP[input.toolName]) {
    if (frustration === 0 && !input.error && (input.exitCode === undefined || input.exitCode === 0)) {
      stance = TOOL_STANCE_MAP[input.toolName];
      dominantEmotion = 'curiosity';
    }
  }

  if (input.intent && /milestone|complete|done|finish|pass/i.test(input.intent)) {
    energy = Math.min(energy + 0.2, 1);
    frustration = Math.max(frustration - 0.3, 0);
    cognitiveLoad = Math.max(cognitiveLoad - 0.2, 0.1);
    dominantEmotion = 'success';
    urgency = Math.max(urgency - 0.3, 0);
  }

  if (previous) {
    cognitiveLoad = (cognitiveLoad + previous.cognitiveLoad) / 2;
    frustration = Math.min(frustration + previous.frustration * 0.3, 1);
    energy = Math.max(0, (energy + previous.energy * 0.5) / 1.5);
    urgency = (urgency + previous.urgency) / 2;
  }

  cognitiveLoad = clamp(cognitiveLoad);
  frustration = clamp(frustration);
  energy = clamp(energy);
  urgency = clamp(urgency);

  return { cognitiveLoad, frustration, energy, dominantEmotion, stance, urgency };
}

export function deriveNeutralState(): InternalState {
  return {
    cognitiveLoad: 0.1,
    frustration: 0,
    energy: 0.8,
    dominantEmotion: 'neutral',
    stance: 'exploratory',
    urgency: 0,
  };
}

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v));
}
