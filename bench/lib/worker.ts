export const BENCH_WORKER_ENV = "ACCEED_BENCH_WORKER";

export function assertBenchWorker(): void {
  if (process.env[BENCH_WORKER_ENV] === "1") return;
  throw new Error("Benchmark workers are launched by the bench API.");
}
