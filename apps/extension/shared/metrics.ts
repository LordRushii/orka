import type { ExecutionRunStatus, RedactionSummaryEntry } from "@orka/contracts";
import type { RuntimeMode } from "@orka/privacy-engine";

/**
 * Local metrics for one Task Session (phases/05-demo-and-hardening.md).
 *
 * Two rules shape this module:
 *
 * 1. **Aggregated only.** A sample is a phase name, a duration, and a count.
 *    There is no field for page text, a URL, a detection box, a private value,
 *    or a provider response -- not filtered out, simply absent -- so nothing
 *    here can become telemetry. It never leaves the browser and is never
 *    persisted: it exists for one Task Session and is dropped with it.
 * 2. **Only what was actually measured.** The demo shows the SIH weights next
 *    to the numbers, so it has to be visible which ones are real local
 *    measurements and which need the benchmark corpus Phase 5 defers. A
 *    presentation that quietly implies a recall score would be worse than no
 *    presentation at all.
 */

/** The phases a Task Session passes through, in order. */
export const METRIC_PHASES = ["capture", "sanitize", "gateway", "plan", "action"] as const;
export type MetricPhase = (typeof METRIC_PHASES)[number];

export const METRIC_PHASE_LABEL: Record<MetricPhase, string> = {
  capture: "Capture",
  sanitize: "Scan and redact",
  gateway: "Gateway round trip",
  plan: "Plan validation",
  action: "Execution",
};

/** How a Task Session ended, in the three ways the session model allows. */
export type TaskOutcome = ExecutionRunStatus | "planned";

/** One aggregated phase sample. `count` is 1 except for `action`. */
export type PhaseSample = {
  phase: MetricPhase;
  ms: number;
  count: number;
};

/**
 * A safe resource sample: one number about *this extension*, never about the
 * page. `usedJSHeapSize` is Chrome-only and non-standard, so the sample is
 * optional everywhere it appears.
 */
export type ResourceSample = {
  heapUsedMb: number;
};

export type LocalMetrics = {
  runtime: RuntimeMode;
  samples: PhaseSample[];
  resource?: ResourceSample;
  /** Category counts, the same coarse aggregate the observation carries. */
  categoryCounts: RedactionSummaryEntry[];
  outcome: TaskOutcome;
  /** Wall-clock time from the start of the session to `report()`. */
  totalMs: number;
};

/**
 * Upper bounds, so a broken clock or a runaway phase cannot produce a bar that
 * dwarfs the rest of the presentation. A phase longer than this is clamped
 * rather than reported as-is, and the count keeps the sample honest.
 */
export const MAX_PHASE_MS = 600_000;
export const MAX_ACTION_SAMPLES = 50;

export type MetricsRecorder = {
  /** Times `work` as one sample of `phase`, whether it resolves or throws. */
  measure<T>(phase: MetricPhase, work: () => Promise<T>): Promise<T>;
  /**
   * Records a duration measured elsewhere: the provider's own reported planner
   * latency, or one action from the executor. `action` is the only phase that
   * accumulates a count, and it stops at the policy ceiling.
   */
  record(phase: MetricPhase, ms: number): void;
  setRuntime(mode: RuntimeMode): void;
  setCategoryCounts(entries: readonly RedactionSummaryEntry[]): void;
  setResourceSample(sample: ResourceSample | undefined): void;
  /** The aggregate for this session. Plain data, safe to hand to the panel. */
  report(outcome: TaskOutcome): LocalMetrics;
};

function clampMs(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.round(value), MAX_PHASE_MS);
}

function safeCount(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.round(value), 500);
}

/**
 * Reads this extension's own JS heap, if the runtime reports one. Returns
 * undefined rather than a guess: a resource figure that is not measured is
 * worse than a blank, because the whole point of showing it is that it is real.
 */
export function sampleExtensionMemory(): ResourceSample | undefined {
  const memory = (globalThis.performance as Performance & {
    memory?: { usedJSHeapSize?: number };
  }).memory;
  const bytes = memory?.usedJSHeapSize;
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return undefined;
  return { heapUsedMb: Math.round((bytes / (1024 * 1024)) * 10) / 10 };
}

/**
 * One recorder per Task Session. `now` is injectable so a test can drive the
 * clock instead of waiting on it.
 */
export function createMetricsRecorder(options: { now?: () => number } = {}): MetricsRecorder {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const samples = new Map<MetricPhase, PhaseSample>();
  let runtime: RuntimeMode = "balanced";
  let resource: ResourceSample | undefined;
  let categoryCounts: RedactionSummaryEntry[] = [];

  const addSample = (phase: MetricPhase, ms: number): void => {
    const existing = samples.get(phase);
    const clamped = clampMs(ms);
    samples.set(phase, {
      phase,
      ms: (existing?.ms ?? 0) + clamped,
      count: (existing?.count ?? 0) + 1,
    });
  };

  return {
    async measure<T>(phase: MetricPhase, work: () => Promise<T>): Promise<T> {
      const before = now();
      try {
        return await work();
      } finally {
        // Recorded on the failing path too: a phase that threw still took the
        // time it took, and that is exactly what a demo has to show.
        addSample(phase, now() - before);
      }
    },
    record(phase: MetricPhase, ms: number) {
      if (phase === "action" && (samples.get("action")?.count ?? 0) >= MAX_ACTION_SAMPLES) return;
      addSample(phase, ms);
    },
    setRuntime(mode: RuntimeMode) {
      runtime = mode;
    },
    setCategoryCounts(entries) {
      categoryCounts = entries.map((entry) => ({
        category: entry.category,
        count: safeCount(entry.count),
      }));
    },
    setResourceSample(sample) {
      resource = sample;
    },
    report(outcome: TaskOutcome): LocalMetrics {
      return {
        runtime,
        // Ordered by the phase list, not by insertion: the demo reads these as
        // a timeline, and a map's iteration order is not a promise about that.
        samples: METRIC_PHASES.flatMap((phase) => {
          const sample = samples.get(phase);
          return sample ? [sample] : [];
        }),
        ...(resource ? { resource } : {}),
        categoryCounts,
        outcome,
        totalMs: clampMs(now() - startedAt),
      };
    },
  };
}

/* -------------------------------------------------------------------------- *
 * SIH scoring presentation                                                   *
 * -------------------------------------------------------------------------- */

export type SihWeightId =
  | "visual_context"
  | "pii_accuracy"
  | "redaction_precision"
  | "client_resources"
  | "latency";

export type SihWeight = {
  id: SihWeightId;
  label: string;
  /** Share of the SIH score, as stated in phases/05-demo-and-hardening.md. */
  weight: number;
  /**
   * Whether this figure can be computed from what the extension measured
   * locally. False means the demo must show it as unavailable.
   */
  measurableLocally: boolean;
  note: string;
};

export const SIH_WEIGHTS: readonly SihWeight[] = [
  {
    id: "visual_context",
    label: "Visual context",
    weight: 0.25,
    measurableLocally: false,
    note: "Needs a labelled screenshot set to score against.",
  },
  {
    id: "pii_accuracy",
    label: "PII recall / precision",
    weight: 0.2,
    measurableLocally: false,
    note: "Needs ground-truth labels; the benchmark corpus is deferred.",
  },
  {
    id: "redaction_precision",
    label: "Redaction precision",
    weight: 0.2,
    measurableLocally: false,
    note: "Counts are local and real, but whether a redaction was correct needs labels.",
  },
  {
    id: "client_resources",
    label: "Client resources",
    weight: 0.2,
    measurableLocally: true,
    note: "Local JS heap sample, when the runtime reports one.",
  },
  {
    id: "latency",
    label: "Latency",
    weight: 0.15,
    measurableLocally: true,
    note: "Measured per phase on this device.",
  },
];

/** How many of the five the extension can put a real number against. */
export const MEASURABLE_SIH_WEIGHTS = SIH_WEIGHTS.filter((entry) => entry.measurableLocally).length;
