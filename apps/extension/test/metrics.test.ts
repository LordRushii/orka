import { describe, expect, test } from "bun:test";
import {
  MAX_ACTION_SAMPLES,
  MAX_PHASE_MS,
  MEASURABLE_SIH_WEIGHTS,
  METRIC_PHASE_LABEL,
  METRIC_PHASES,
  SIH_WEIGHTS,
  createMetricsRecorder,
  sampleExtensionMemory,
} from "../shared/metrics.ts";

/**
 * Local metrics for the demo.
 *
 * Two properties matter more than any individual number: a failed phase still
 * records its duration (otherwise the demo hides exactly the case worth
 * showing), and the aggregate has no field that could carry page data.
 */

/** A clock the test drives, so no phase has to actually take time. */
function testClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
    set(value: number) {
      current = value;
    },
  };
}

describe("metrics: measuring phases", () => {
  test("records the duration of a phase and hands its result through", async () => {
    const time = testClock();
    const recorder = createMetricsRecorder({ now: time.now });

    const result = await recorder.measure("sanitize", async () => {
      time.advance(72);
      return "observation";
    });

    expect(result).toBe("observation");
    expect(recorder.report("planned").samples).toEqual([
      { phase: "sanitize", ms: 72, count: 1 },
    ]);
  });

  test("records a phase that threw, and rethrows", async () => {
    const time = testClock();
    const recorder = createMetricsRecorder({ now: time.now });

    await expect(
      recorder.measure("sanitize", async () => {
        time.advance(500);
        throw new Error("detector timed out");
      }),
    ).rejects.toThrow("detector timed out");

    const [sample] = recorder.report("failed").samples;
    expect(sample?.phase).toBe("sanitize");
    expect(sample?.ms).toBe(500);
  });

  test("aggregates repeated samples of one phase into a total and a count", async () => {
    const time = testClock();
    const recorder = createMetricsRecorder({ now: time.now });
    const measure = (ms: number) =>
      recorder.measure("gateway", async () => {
        time.advance(ms);
      });

    await measure(10);
    await measure(11);

    expect(recorder.report("completed").samples).toEqual([
      { phase: "gateway", ms: 21, count: 2 },
    ]);
  });

  test("reports phases in timeline order, and only the phases that ran", async () => {
    const time = testClock();
    const recorder = createMetricsRecorder({ now: time.now });
    await recorder.measure("action", async () => undefined);
    await recorder.measure("capture", async () => undefined);

    expect(recorder.report("completed").samples.map((sample) => sample.phase)).toEqual([
      "capture",
      "action",
    ]);
  });

  test("bounds a duration instead of reporting a broken clock", async () => {
    const time = testClock();
    const recorder = createMetricsRecorder({ now: time.now });

    // A clock that went backwards cannot produce a negative bar...
    await recorder.measure("capture", async () => {
      time.advance(-5_000);
    });
    expect(recorder.report("completed").samples[0]?.ms).toBe(0);

    // ...an absurd one is clamped rather than allowed to dwarf the display...
    const runaway = createMetricsRecorder({ now: testClock().now });
    const runawayTime = testClock();
    const clamping = createMetricsRecorder({ now: runawayTime.now });
    await clamping.measure("capture", async () => {
      runawayTime.advance(5_000_000);
    });
    expect(clamping.report("completed").samples[0]?.ms).toBe(MAX_PHASE_MS);

    // ...and a non-finite duration is nonsense, not a large number.
    await runaway.measure("capture", async () => undefined);
    expect(runaway.report("completed").samples[0]?.ms).toBe(0);
  });

  test("counts actions into one sample, capped at the policy ceiling", () => {
    const recorder = createMetricsRecorder({ now: testClock().now });
    recorder.record("action", 120);
    recorder.record("action", 80);

    expect(recorder.report("completed").samples).toEqual([
      { phase: "action", ms: 200, count: 2 },
    ]);

    for (let index = 0; index < MAX_ACTION_SAMPLES + 10; index += 1) recorder.record("action", 1);
    expect(recorder.report("completed").samples[0]?.count).toBe(MAX_ACTION_SAMPLES);
  });

  test("records a duration measured elsewhere as a single sample", () => {
    const recorder = createMetricsRecorder({ now: testClock().now });
    // The provider's own planner latency: reported by the gateway, not timed here.
    recorder.record("plan", 940);

    expect(recorder.report("completed").samples).toEqual([
      { phase: "plan", ms: 940, count: 1 },
    ]);
  });

  test("reports the wall-clock total and the outcome it was given", () => {
    const time = testClock(1_000);
    const recorder = createMetricsRecorder({ now: time.now });
    time.advance(500);

    const report = recorder.report("stopped");
    expect(report.totalMs).toBe(500);
    expect(report.outcome).toBe("stopped");
  });
});

describe("metrics: what a report may and may not carry", () => {
  test("carries only aggregates -- there is no field for page data", () => {
    const recorder = createMetricsRecorder({ now: testClock().now });
    recorder.setRuntime("webgpu");
    recorder.setCategoryCounts([{ category: "PHONE", count: 2 }]);
    recorder.setResourceSample({ heapUsedMb: 84.2 });

    const report = recorder.report("completed");

    // The exact shape, so a field that could leak cannot be added quietly.
    expect(Object.keys(report).sort()).toEqual([
      "categoryCounts",
      "outcome",
      "resource",
      "runtime",
      "samples",
      "totalMs",
    ]);
    expect(JSON.stringify(report)).not.toContain("http");
  });

  test("degrades a nonsense category count instead of passing it on", () => {
    const recorder = createMetricsRecorder({ now: testClock().now });
    recorder.setCategoryCounts([
      { category: "EMAIL", count: Number.NaN },
      { category: "CARD", count: -3 },
      { category: "FACE", count: 10_000 },
    ]);

    expect(recorder.report("completed").categoryCounts).toEqual([
      { category: "EMAIL", count: 0 },
      { category: "CARD", count: 0 },
      { category: "FACE", count: 500 },
    ]);
  });

  test("omits the resource sample when the runtime did not provide one", () => {
    const recorder = createMetricsRecorder({ now: testClock().now });
    expect(recorder.report("completed").resource).toBeUndefined();
  });

  test("defaults the runtime and takes the one it is told", () => {
    const recorder = createMetricsRecorder({ now: testClock().now });
    expect(recorder.report("planned").runtime).toBe("balanced");
    recorder.setRuntime("wasm");
    expect(recorder.report("planned").runtime).toBe("wasm");
  });
});

describe("metrics: the safe resource sample", () => {
  function withMemory(value: unknown, run: () => void): void {
    const original = (globalThis.performance as { memory?: unknown }).memory;
    Object.defineProperty(globalThis.performance, "memory", { value, configurable: true });
    try {
      run();
    } finally {
      Object.defineProperty(globalThis.performance, "memory", {
        value: original,
        configurable: true,
      });
    }
  }

  test("is a real number when the runtime reports a heap", () => {
    withMemory({ usedJSHeapSize: 88_300_000 }, () => {
      expect(sampleExtensionMemory()).toEqual({ heapUsedMb: 84.2 });
    });
  });

  test("is undefined rather than a guess when there is nothing to sample", () => {
    withMemory(undefined, () => {
      expect(sampleExtensionMemory()).toBeUndefined();
    });
    withMemory({ usedJSHeapSize: 0 }, () => {
      expect(sampleExtensionMemory()).toBeUndefined();
    });
  });
});

describe("metrics: the SIH weights as presented", () => {
  test("are the five Phase 5 weights, summing to a whole score", () => {
    expect(SIH_WEIGHTS.map((entry) => entry.weight)).toEqual([0.25, 0.2, 0.2, 0.2, 0.15]);
    const total = SIH_WEIGHTS.reduce((sum, entry) => sum + entry.weight, 0);
    expect(Math.round(total * 100)).toBe(100);
    expect(new Set(SIH_WEIGHTS.map((entry) => entry.id)).size).toBe(SIH_WEIGHTS.length);
  });

  test("mark only the two the extension can actually measure as measurable", () => {
    // The other three need ground truth the browser does not have, and Phase 5
    // defers the corpus that would provide it. Showing them as measured figures
    // would be the one genuinely dishonest thing this panel could do.
    expect(SIH_WEIGHTS.filter((entry) => entry.measurableLocally).map((entry) => entry.id)).toEqual(
      ["client_resources", "latency"],
    );
    expect(MEASURABLE_SIH_WEIGHTS).toBe(2);
    for (const entry of SIH_WEIGHTS) expect(entry.note.length).toBeGreaterThan(0);
  });

  test("every metric phase has a label for the panel", () => {
    for (const phase of METRIC_PHASES) {
      expect(METRIC_PHASE_LABEL[phase]?.length).toBeGreaterThan(0);
    }
  });
});
