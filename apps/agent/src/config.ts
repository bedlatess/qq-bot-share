import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

export const agentConfigSchema = z.object({
  nodeId: z.string().min(1),
  nodeToken: z.string().min(16),
  controlUrl: z.string().url(),
  spoolDir: z.string().default('./spool'),
  spoolLimitBytes: z.number().int().min(1024 * 1024).max(1024 * 1024 * 1024).default(50 * 1024 * 1024),
  autoUpdate: z.boolean().default(true),
  bots: z.array(z.object({
    id: z.string().min(1),
    qq: z.string().regex(/^\d{5,15}$/),
    oneBotWs: z.string().url(),
    webuiUrl: z.string().url(),
    webuiToken: z.string().default(''),
  })).min(1),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type BotConfig = AgentConfig['bots'][number];

export function loadAgentConfig(): AgentConfig {
  const path = resolve(process.env.PUFF_AGENT_CONFIG || './agent.config.json');
  return agentConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
