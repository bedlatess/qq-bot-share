import { z } from 'zod';

export const PUFF_VERSION = '2.1.0';

export const featureNames = [
  'chat',
  'tech',
  'vision',
  'draw',
  'lurk',
  'moderation',
  'privateChat',
] as const;

export type FeatureName = (typeof featureNames)[number];

export const featureFlagsSchema = z.object(
  Object.fromEntries(featureNames.map((name) => [name, z.boolean()])) as Record<FeatureName, z.ZodBoolean>,
);

export type FeatureFlags = z.infer<typeof featureFlagsSchema>;

export const defaultFeatures: FeatureFlags = {
  chat: true,
  tech: true,
  vision: true,
  draw: false,
  lurk: true,
  moderation: true,
  privateChat: false,
};

export const oneBotSegmentSchema = z.object({
  type: z.string(),
  data: z.record(z.unknown()).default({}),
});

export const oneBotEventSchema = z.object({
  time: z.number().optional(),
  self_id: z.union([z.string(), z.number()]).optional(),
  post_type: z.string(),
  message_type: z.string().optional(),
  sub_type: z.string().optional(),
  message_id: z.union([z.string(), z.number()]).optional(),
  user_id: z.union([z.string(), z.number()]).optional(),
  group_id: z.union([z.string(), z.number()]).optional(),
  raw_message: z.string().optional(),
  message: z.union([z.string(), z.array(oneBotSegmentSchema)]).optional(),
  sender: z
    .object({
      user_id: z.union([z.string(), z.number()]).optional(),
      nickname: z.string().optional(),
      card: z.string().optional(),
      role: z.enum(['owner', 'admin', 'member']).optional(),
    })
    .passthrough()
    .optional(),
}).passthrough();

export type OneBotEvent = z.infer<typeof oneBotEventSchema>;

export type OneBotAction = {
  action: string;
  params: Record<string, unknown>;
  echo?: string;
};

export type AgentHello = {
  type: 'hello';
  nodeId: string;
  version: string;
  hostname: string;
  bots: Array<{ id: string; qq: string; online: boolean }>;
};

export type AgentEvent = {
  type: 'event';
  eventId: string;
  nodeId: string;
  botId: string;
  event: OneBotEvent;
};

export type AgentHeartbeat = {
  type: 'heartbeat';
  nodeId: string;
  at: number;
  memoryMb: number;
  queueDepth: number;
  bots: Array<{
    id: string;
    qq: string;
    oneBotOnline: boolean;
    qqOnline?: boolean;
    loginError?: string | null;
  }>;
};

export type ControlAction = {
  type: 'action';
  requestId: string;
  botId: string;
  action: OneBotAction;
};

export type ControlNapCatRequest = {
  type: 'napcat_request';
  requestId: string;
  botId: string;
  operation: 'status' | 'qrcode' | 'refresh_qrcode' | 'restart';
};

export type ControlBotRequest = {
  type: 'bot_request';
  requestId: string;
  botId: string;
  operation: 'groups';
};

export type AgentNapCatResponse = {
  type: 'napcat_response';
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
};

export type AgentBotResponse = {
  type: 'bot_response';
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
};

export type AgentUpdateManifest = {
  version: string;
  url: string;
  sha256: string;
};

export type AgentMessage = AgentHello | AgentEvent | AgentHeartbeat | AgentNapCatResponse | AgentBotResponse;
export type ControlMessage =
  | ControlAction
  | ControlNapCatRequest
  | ControlBotRequest
  | { type: 'hello_ack'; at: number; update?: AgentUpdateManifest };

export function toId(value: string | number | undefined | null): string {
  return value == null ? '' : String(value);
}

export function nowIso(): string {
  return new Date().toISOString();
}
