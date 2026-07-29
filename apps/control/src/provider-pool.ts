import { nowIso } from '@puff/shared';
import type { Store } from './db.js';
import { decryptSecret } from './security.js';

export type AiTask = 'text' | 'vision' | 'image';
export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: unknown };

type ProviderRow = {
  id: string;
  name: string;
  base_url: string;
  api_key_enc: string;
  model: string;
  priority: number;
  timeout_ms: number;
  enabled: number;
  capabilities_json: string;
  cooldown_until: string | null;
  failure_count: number;
};

function endpoint(baseUrl: string, suffix: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return base.endsWith('/v1') ? `${base}${suffix.replace('/v1', '')}` : `${base}${suffix}`;
}

function modelCapabilities(model: string) {
  const name = model.toLowerCase();
  return {
    text: true,
    vision: /(gemini|gpt-4o|gpt-4\.1|gpt-5|claude|vision|vl|qwen2\.5-vl)/.test(name),
    image: /(image|dall-e|imagen|gpt-image)/.test(name),
  };
}

export class ProviderPool {
  constructor(private readonly store: Store, private readonly masterKey: string) {}

  private providers(task: AiTask): ProviderRow[] {
    const rows = this.store.db.prepare(`SELECT * FROM ai_providers WHERE enabled=1 ORDER BY priority ASC,created_at ASC`)
      .all() as ProviderRow[];
    const now = Date.now();
    return rows.filter((row) => {
      if (row.cooldown_until && new Date(row.cooldown_until).getTime() > now) return false;
      const capabilities = JSON.parse(row.capabilities_json) as Record<string, boolean>;
      return capabilities[task] !== false;
    });
  }

  async chat(messages: ChatMessage[], task: Exclude<AiTask, 'image'>, context: { botId: string; groupId?: string; kind: string }) {
    const candidates = this.providers(task);
    if (candidates.length === 0) throw new Error(`没有可用的${task === 'vision' ? '视觉' : '文本'}模型网关`);
    const errors: string[] = [];
    for (const provider of candidates) {
      const started = Date.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), provider.timeout_ms);
        const response = await fetch(endpoint(provider.base_url, '/v1/chat/completions'), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${decryptSecret(provider.api_key_enc, this.masterKey)}`,
          },
          body: JSON.stringify({ model: provider.model, messages, max_tokens: 2048, temperature: 0.7 }),
          signal: controller.signal,
        }).finally(() => clearTimeout(timer));
        if (!response.ok) {
          const detail = (await response.text().catch(() => '')).slice(0, 300);
          throw new Error(`HTTP ${response.status} ${detail}`.trim());
        }
        const payload = await response.json() as any;
        const content = payload.choices?.[0]?.message?.content;
        const text = Array.isArray(content)
          ? content.map((part: any) => typeof part === 'string' ? part : part?.text || '').join('')
          : String(content || '');
        if (!text.trim()) throw new Error('模型返回空内容');
        this.markSuccess(provider.id, Date.now() - started);
        this.store.db.prepare(`INSERT INTO usage_events
          (bot_id,group_id,provider_id,kind,input_tokens,output_tokens,created_at) VALUES (?,?,?,?,?,?,?)`)
          .run(context.botId, context.groupId || null, provider.id, context.kind,
            Number(payload.usage?.prompt_tokens || 0), Number(payload.usage?.completion_tokens || 0), nowIso());
        return { text: text.trim(), providerId: provider.id, usage: payload.usage || null };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${provider.name}: ${message}`);
        this.markFailure(provider, message);
      }
    }
    throw new Error(`全部模型网关失败：${errors.join(' | ')}`);
  }

  async image(prompt: string, context: { botId: string; groupId?: string }) {
    const candidates = this.providers('image');
    if (candidates.length === 0) throw new Error('没有可用的生图模型网关');
    const errors: string[] = [];
    for (const provider of candidates) {
      const started = Date.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.max(provider.timeout_ms, 120000));
        const response = await fetch(endpoint(provider.base_url, '/v1/images/generations'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${decryptSecret(provider.api_key_enc, this.masterKey)}` },
          body: JSON.stringify({ model: provider.model, prompt, n: 1, size: '1024x1024', response_format: 'b64_json' }),
          signal: controller.signal,
        }).finally(() => clearTimeout(timer));
        if (!response.ok) throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
        const payload = await response.json() as any;
        const item = payload.data?.[0];
        if (!item?.b64_json && !item?.url) throw new Error('生图接口未返回图片');
        this.markSuccess(provider.id, Date.now() - started);
        this.store.db.prepare(`INSERT INTO usage_events (bot_id,group_id,provider_id,kind,created_at) VALUES (?,?,?,?,?)`)
          .run(context.botId, context.groupId || null, provider.id, 'image', nowIso());
        return { base64: item.b64_json as string | undefined, url: item.url as string | undefined, providerId: provider.id };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${provider.name}: ${message}`);
        this.markFailure(provider, message);
      }
    }
    throw new Error(`全部生图网关失败：${errors.join(' | ')}`);
  }

  async probe(id: string) {
    const row = this.store.db.prepare('SELECT * FROM ai_providers WHERE id=?').get(id) as ProviderRow | undefined;
    if (!row) throw new Error('网关不存在');
    const inferred = modelCapabilities(row.model);
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(row.timeout_ms, 15000));
    try {
      const response = await fetch(endpoint(row.base_url, '/v1/chat/completions'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${decryptSecret(row.api_key_enc, this.masterKey)}` },
        body: JSON.stringify({ model: row.model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 8 }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 160)}`);
      this.store.db.prepare(`UPDATE ai_providers SET capabilities_json=?,health_status='healthy',failure_count=0,
        cooldown_until=NULL,last_error=NULL,latency_ms=?,updated_at=? WHERE id=?`)
        .run(JSON.stringify(inferred), Date.now() - started, nowIso(), id);
      return { healthy: true, capabilities: inferred, latencyMs: Date.now() - started };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.markFailure(row, message);
      return { healthy: false, capabilities: inferred, error: message };
    } finally {
      clearTimeout(timer);
    }
  }

  private markSuccess(id: string, latency: number) {
    this.store.db.prepare(`UPDATE ai_providers SET health_status='healthy',failure_count=0,cooldown_until=NULL,
      last_error=NULL,latency_ms=?,updated_at=? WHERE id=?`).run(latency, nowIso(), id);
  }

  private markFailure(provider: ProviderRow, message: string) {
    const failures = Number(provider.failure_count || 0) + 1;
    const cooldown = failures >= 3 ? new Date(Date.now() + 120000).toISOString() : null;
    this.store.db.prepare(`UPDATE ai_providers SET health_status='unhealthy',failure_count=?,cooldown_until=?,
      last_error=?,updated_at=? WHERE id=?`).run(failures, cooldown, message.slice(0, 500), nowIso(), provider.id);
  }
}

