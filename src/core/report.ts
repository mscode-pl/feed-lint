export type Level = 'error' | 'warning';

export interface RuleInfo {
  level: Level;
  title: string;
  url: string;
}

export interface Sample {
  line: number;
  id?: string;
  detail?: string;
}

export interface RuleResult extends RuleInfo {
  rule: string;
  count: number;
  samples: Sample[];
}

export interface Report {
  (rule: string, sample: Sample): void;
}

export class Collector {
  private readonly results = new Map<string, RuleResult>();

  constructor(
    private readonly rules: Record<string, RuleInfo>,
    private readonly ignore: Set<string>,
    private readonly maxSamples: number,
  ) {}

  readonly report: Report = (rule, sample) => {
    if (this.ignore.has(rule)) return;
    const info = this.rules[rule];
    if (!info) throw new Error(`Unknown rule ${rule}`);
    let result = this.results.get(rule);
    if (!result) this.results.set(rule, (result = { rule, ...info, count: 0, samples: [] }));
    result.count++;
    if (result.samples.length < this.maxSamples) result.samples.push(sample);
  };

  list(): RuleResult[] {
    // An XML error makes every other result partial, so it always comes first.
    const rank = (r: RuleResult) => (r.rule.startsWith('xml/') ? 0 : r.level === 'error' ? 1 : 2);
    return [...this.results.values()].sort((a, b) => rank(a) - rank(b) || b.count - a.count || a.rule.localeCompare(b.rule));
  }
}
