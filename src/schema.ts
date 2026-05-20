import { z } from 'zod';

// mirrors sdk/SCHEMA.md §1 (v0.1.0, sha1 471308f9).
// any change here must be paired with sdk/SCHEMA.md.
export const MetricsSchema = z.object({
  rmse: z.number(),
  jerk: z.number(),
  end_variance: z.number(),
});

export const PayloadSchema = z.object({
  version: z.string(),
  agent_id: z.int(),
  robot_id: z.string(),
  episode_id: z.string(),
  task: z.string(),
  started_at: z.string(),
  ended_at: z.string(),
  duration_seconds: z.number(),
  frames: z.int(),
  metrics: MetricsSchema,
  score: z.number().min(0).max(1),
  outcome: z.enum(['SUCCESS', 'PARTIAL', 'FAIL']),
});

export type Payload = z.infer<typeof PayloadSchema>;
export type Metrics = z.infer<typeof MetricsSchema>;
