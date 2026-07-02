import type {
  GrowthCategory,
  GrowthEvent,
  GrowthMetrics,
  CategoryMetrics,
  BehavioralGrowthTracker,
} from './behavioral-growth-tracker-types.js';

const CATEGORIES: GrowthCategory[] = [
  'loop_prevention',
  'schema_lesson_application',
  'boundary_adherence',
  'causal_depth_improvement',
  'repo_fact_reuse',
  'drift_correction',
  'hydration_depth_increase',
];

function emptyCategoryMetrics(): CategoryMetrics {
  return { total: 0, improved: 0, same: 0, worse: 0, rate: 0 };
}

function emptyByCategory(): Record<GrowthCategory, CategoryMetrics> {
  const obj = {} as Record<GrowthCategory, CategoryMetrics>;
  for (const cat of CATEGORIES) {
    obj[cat] = emptyCategoryMetrics();
  }
  return obj;
}

export class InMemoryBehavioralGrowthTracker implements BehavioralGrowthTracker {
  private events: GrowthEvent[] = [];

  recordGrowthEvent(event: Omit<GrowthEvent, 'timestamp'>): void {
    const fullEvent: GrowthEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    };
    this.events.push(fullEvent);
  }

  getGrowthMetrics(): GrowthMetrics {
    const byCategory = emptyByCategory();

    for (const event of this.events) {
      const cat = event.category;
      byCategory[cat].total++;
      if (event.outcome === 'improved') byCategory[cat].improved++;
      else if (event.outcome === 'same') byCategory[cat].same++;
      else byCategory[cat].worse++;
    }

    for (const cat of CATEGORIES) {
      const m = byCategory[cat];
      m.rate = m.total > 0 ? m.improved / m.total : 0;
    }

    const totalEvents = this.events.length;
    const totalImproved = this.events.filter(e => e.outcome === 'improved').length;
    const overallImprovementRate = totalEvents > 0 ? totalImproved / totalEvents : 0;

    const mid = Math.floor(totalEvents / 2);
    const firstHalf = this.events.slice(0, mid);
    const secondHalf = this.events.slice(mid);
    const firstImproved = firstHalf.filter(e => e.outcome === 'improved').length;
    const secondImproved = secondHalf.filter(e => e.outcome === 'improved').length;
    let recentTrend: GrowthMetrics['recentTrend'] = 'stable';
    if (secondHalf.length > 0 && firstHalf.length > 0) {
      const firstRate = firstImproved / firstHalf.length;
      const secondRate = secondImproved / secondHalf.length;
      if (secondRate > firstRate + 0.1) recentTrend = 'improving';
      else if (secondRate < firstRate - 0.1) recentTrend = 'declining';
    }

    const eventsBySession: Record<string, number> = {};
    for (const event of this.events) {
      eventsBySession[event.sessionId] = (eventsBySession[event.sessionId] || 0) + 1;
    }

    return {
      totalEvents,
      byCategory,
      overallImprovementRate,
      recentTrend,
      eventsBySession,
    };
  }

  getEventsByCategory(category: GrowthCategory): GrowthEvent[] {
    return this.events.filter(e => e.category === category);
  }

  getEventsBySession(sessionId: string): GrowthEvent[] {
    return this.events.filter(e => e.sessionId === sessionId);
  }

  exportGrowthReport(): string {
    const metrics = this.getGrowthMetrics();
    const lines: string[] = [
      'Behavioral Growth Report',
      `Generated: ${new Date().toISOString()}`,
      `Total Events: ${metrics.totalEvents}`,
      `Overall Improvement Rate: ${(metrics.overallImprovementRate * 100).toFixed(1)}%`,
      `Recent Trend: ${metrics.recentTrend}`,
      '',
      'By Category:',
    ];

    for (const cat of CATEGORIES) {
      const m = metrics.byCategory[cat];
      if (m.total > 0) {
        lines.push(`  ${cat}: ${m.improved}/${m.total} improved (${(m.rate * 100).toFixed(1)}%)`);
      }
    }

    lines.push('', 'By Session:');
    for (const [session, count] of Object.entries(metrics.eventsBySession)) {
      lines.push(`  ${session}: ${count} events`);
    }

    return lines.join('\n');
  }
}