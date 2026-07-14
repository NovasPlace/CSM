export interface SystemTransformInput {
  sessionID?: string;
  model?: unknown;
  messages?: Array<{
    content?: string;
    parts?: unknown;
    info?: { role?: string };
    role?: string;
  }>;
}

export interface SystemTransformOutput {
  system: string[];
}

export interface TransformStart {
  sessionId: string;
  latestUserTurn?: string;
  greetingTurn: boolean;
  stopped: boolean;
}

export interface LivingMindCortex {
  cognitive_stance?: string;
  urgency?: number;
  creative_pressure?: number;
  phase_gate?: {
    current_phase?: string;
    blocked?: string[];
  };
  hormones?: {
    dominant_emotion?: string;
  };
  system_load?: {
    energy_budget?: number;
    pain?: number;
    cognitive_load?: number;
    status?: string;
  };
}

export interface CompressedDetail {
  source: string;
  risk: string;
}

