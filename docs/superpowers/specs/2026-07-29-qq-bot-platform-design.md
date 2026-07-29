# QQ Bot Platform Design

## 1. Goal

Rebuild the existing single-file QQ bot into a lightweight, source-delivered
platform for one operator. The first deployment supports three QQ bots on one
Windows Server and three to four 2,000-member groups. The architecture must be
able to expand to about 50 bots by adding Windows nodes without replacing the
control plane.

The product retains all current behavior:

- mentioned AI chat and image understanding;
- automatic technical-question answering;
- optional proactive group comments;
- text, nickname, context-splitting, and image moderation;
- recall, optional mute, and outbound content checks;
- AI provider failure fallback;
- per-bot persona and command configuration.

It also adds a lightweight administration panel, group licensing, packages,
activation codes, usage quotas, bot/node status, QR login display, persistence,
bounded logs, tests, and deployment commands.

## 2. Constraints

- Domestic host: a fresh Windows Server, 4 CPU cores and 8 GB RAM.
- Overseas host: Debian with Docker and Nginx Proxy Manager already running.
- Initial access: `http://SERVER_IP:17866`; reverse proxy and domain are added
  later by the operator.
- One web administrator account authenticated by email and password.
- No SMTP, online payment, TOTP, Redis, PostgreSQL, or enterprise observability.
- Total managed data, logs, evidence, and backups are capped at 5 GB.
- The operator receives complete source code and deployment commands. Remote
  deployment is outside this delivery.

## 3. Evaluated Approaches

### 3.1 Custom lightweight Node.js platform (selected)

Use a small TypeScript monorepo with a Debian control plane and a Windows bot
agent. This directly models group licensing and multi-bot operations, keeps the
dependency set small, and allows the current JavaScript behavior to be migrated
without carrying an unrelated plugin ecosystem.

### 3.2 AstrBot extension

AstrBot already provides multi-model AI, personas, OneBot integration, and a
WebUI. Its Python runtime, agent features, knowledge base, marketplace, and broad
platform support are unnecessary here. Group authorization, activation codes,
Windows node management, and strict disk limits would still require substantial
custom work.

### 3.3 Koishi plugin suite

Koishi offers a mature plugin and console model. It remains heavier than the
selected design and does not remove the custom work for group licensing,
NapCat login aggregation, and remote Windows nodes.

The selected design borrows only proven concepts: OneBot adapter boundaries,
ordered event middleware, schema-driven settings, provider health checks, and a
compact operations console.

## 4. Architecture

```text
QQ groups/private messages
          |
          v
NapCat Shell instances (Windows, one instance per QQ account)
          |
          v local OneBot WebSocket
Windows Agent (one process per Windows node)
          |
          v outbound authenticated WebSocket/HTTP
Debian Control Plane :17866
  - Fastify API and static admin UI
  - event pipeline and authorization engine
  - AI provider pool
  - SQLite database
  - bounded logs, evidence, and backups
```

The Windows host exposes no NapCat or OneBot port publicly. The agent initiates
the control-plane connection. Each NapCat instance uses an independent data
directory, OneBot port, WebUI port, and WebUI credential.

The initial 4C8G Windows host is sized for three accounts, not 50. Future growth
adds Windows nodes. Bots are assigned to nodes from the same control panel.

## 5. Repository Layout

```text
apps/
  control/       Fastify API, WebSocket hub, scheduler, static UI host
  web/           React/Vite administration interface
  agent/         Windows Node.js agent and NapCat adapters
packages/
  shared/        schemas, protocol messages, feature and permission constants
  core/          event pipeline, authorization, moderation, AI routing
scripts/
  windows/       setup, scheduled-task install, status, uninstall
  debian/        Docker deployment, backup, restore, health checks
tests/
  fixtures/      fake OneBot and fake AI servers
docs/
  deployment and operations guides
```

## 6. Control Plane

The Debian service uses Fastify, SQLite in WAL mode, and a prebuilt React UI.
One container serves API, agent WebSocket, and static assets. Redis and a
separate web server are deliberately omitted.

### Authentication

- One administrator account with email and password.
- Passwords use Node's `crypto.scrypt` with a unique salt.
- Authentication uses an opaque, server-side session and an HttpOnly cookie.
- State-changing routes require same-origin checks and a CSRF token.
- The bootstrap email and password come from environment variables and must be
  changed after first login.
- CLI commands can reset the administrator password without email.

### Main UI areas

- Overview: node/bot health, licensed groups, usage, provider health, storage.
- Bots and nodes: status, assignment, NapCat WebUI metadata, QR login, restart.
- Groups: authorization, expiry, plan, quota, overrides, audit history.
- Plans: durations, feature switches, request quota, permanent option.
- Activation codes: batch generation, status, binding, revoke, export.
- Providers: ordered endpoint/key/model entries, capability and health status.
- Moderation: balanced defaults, keyword/pattern rules, actions, evidence.
- Personas and commands: global defaults with per-bot overrides.
- Logs and storage: bounded query, retention, manual cleanup, backup/restore.

The UI is a quiet operational console: dense tables, restrained colors, clear
status indicators, responsive navigation, no decorative dashboard-card nesting.

## 7. Windows Agent and NapCat

The agent owns only transport and local process integration. Business policy
stays in the control plane.

For each configured bot, the agent:

1. connects to the local OneBot forward WebSocket;
2. normalizes incoming group/private events;
3. forwards events to the control plane with bot and node identity;
4. executes returned OneBot actions such as send, recall, mute, and group info;
5. reports heartbeat, QQ online state, queue depth, and last error;
6. calls authenticated NapCat WebUI endpoints for QR code, login status, QR
   refresh, login info, and restart.

The agent reconnects with exponential backoff and jitter. It keeps a small
bounded disk spool for events while the control plane is temporarily offline.
The spool contains no API keys and evicts oldest events at its configured cap.

## 8. Event Pipeline

Events pass through ordered middleware:

1. normalize message segments and sender metadata;
2. identify bot, group/private context, and global QQ administrator;
3. process authorization and management commands;
4. enforce group-license and plan feature gates;
5. run balanced moderation;
6. route technical questions or ordinary conversation;
7. call the AI provider pool;
8. apply outbound filtering and output limits;
9. return OneBot actions and record bounded metrics.

Messages from the same bot and group are ordered through a small in-memory
queue. Different groups run concurrently with configurable global and per-bot
limits. Conversation history is isolated by bot, group, and user/thread so one
member cannot inherit another member's context.

## 9. Authorization, Plans, and Activation Codes

A group license is bound to `bot_id + group_id`. It contains a plan, start time,
expiry or permanent flag, status, request usage, and optional overrides.

Plans can control:

- AI chat;
- technical answers;
- image understanding;
- image generation;
- proactive comments;
- moderation;
- monthly request quota.

The system records provider token usage for cost analysis, but plan enforcement
uses request counts in the first release.

Licenses are managed either in the web panel or through one-time activation
codes. A card is hashed at rest, has a plan and duration, can be revoked, and
binds atomically to the current bot/group when activated. Raw cards are shown
only once at generation/export time.

Group owners/admins may run activation and management commands. QQ accounts in
the global-administrator allowlist bypass group-role checks and can manage any
group. Command names and prefixes are configurable.

After expiry, all paid behavior stops except authorization status, activation,
and contact/help commands.

## 10. Private Messages

The first release handles private messages through the same adapter pipeline but
enables only activation help, authorization queries, and global-administrator
commands. Ordinary private AI chat remains disabled by default. The feature gate
and conversation model already support enabling it later without changing the
transport or database.

## 11. AI Provider Pool

The administrator maintains one ordered global list. Each entry contains:

- display name, base URL, API key, model, priority, timeout, enabled status;
- detected text, vision, and image-generation capabilities;
- health, failure count, cooldown, latency, and last error.

The API key is encrypted at rest with an environment-provided master key. It is
never sent to the Windows agent or browser.

The router chooses the first healthy provider capable of the requested task.
Timeouts, connection errors, 429 responses, and 5xx responses trigger the next
provider. Authentication/configuration errors mark only that provider unhealthy.
Circuit-breaker cooldown prevents every request from repeatedly hitting a failed
endpoint. Health and capability probes can be run from the UI.

All model calls use OpenAI-compatible endpoints:

- `/v1/chat/completions` for text and vision;
- `/v1/images/generations` for image generation where supported.

## 12. Balanced Moderation

Balanced mode uses four stages:

1. high-confidence keyword/pattern rules for immediate action;
2. AI review for ambiguous text;
3. bounded per-user message windows for split-message advertising;
4. vision review for images.

Normal technical discussion, ordinary links, and administrator messages are not
hard-blocked by broad domain patterns. Moderator failures are fail-open but are
recorded as health events. Evidence stores only the minimum message excerpt,
reason, identifiers, and timestamps needed for review.

Actions are configurable per bot/group: log, recall, or recall plus mute.

## 13. Data and Disk Limits

SQLite stores configuration, authorization, cards, sessions, usage counters,
small audit records, and bot/node status. It does not archive all group chat.

- operational logs: 7 days;
- moderation evidence: 30 days;
- daily SQLite backups: 7 copies;
- total managed storage hard limit: 5 GB;
- warning threshold: 80 percent;
- cleanup order: expired logs, old evidence, old backups, oldest nonessential
  metrics;
- SQLite maintenance uses bounded checkpoints and scheduled `VACUUM` only when
  sufficient free space exists.

## 14. Failure Handling

- NapCat disconnect: reconnect locally and update bot status.
- Agent/control disconnect: exponential reconnect and bounded local spool.
- AI failure: provider fallback and circuit breaker.
- Authorization database write conflict: one SQLite transaction; no partial card
  consumption.
- Duplicate OneBot event: event-id deduplication with a bounded TTL cache.
- Recall failure: limited retry except known nonretryable codes.
- Process restart: sessions, licenses, usage, and configuration survive; transient
  queues and chat caches rebuild safely.

## 15. Deployment

### Debian

Docker Compose builds and starts the control-plane image on configurable port
`17866`. Persistent data is mounted under `./data`. The compose file does not
modify Nginx Proxy Manager or its network. A later NPM proxy can point to the
same port without changing application configuration.

### Windows

PowerShell scripts install dependencies, create per-bot directories, generate an
agent configuration, and register startup tasks. NapCat Shell remains a separate
upstream dependency; the script validates its expected files and ports rather
than silently patching upstream binaries.

Secrets are stored in `.env`/local agent configuration excluded from source
control. Example files contain no usable credentials.

## 16. Testing and Acceptance

Automated tests cover:

- password/session authentication and authorization;
- plan feature gates, expiry, permanent grants, and quotas;
- activation generation, hashing, atomic binding, reuse prevention, and revoke;
- global QQ administrator and group-role permissions;
- provider ordering, capability filtering, fallback, and circuit breaker;
- moderation hard rules, AI decisions, context windows, and fail-open behavior;
- OneBot normalization and outgoing action construction;
- retention and 5 GB cleanup policy.

Integration tests run a fake OneBot WebSocket, fake NapCat WebUI, fake AI
providers, the agent, and the control plane. Acceptance requires:

- admin login and configuration through desktop/mobile layouts;
- adding a node and bot, viewing online/QR status;
- authorizing a group manually and by activation code;
- an expired group retaining only basic authorization commands;
- a primary AI failure producing a successful fallback reply;
- balanced moderation recalling a confirmed violation without blocking a normal
  technical URL;
- clean Docker and Windows deployment instructions from a fresh environment.

## 17. Explicit Non-Goals

- online payment;
- multi-tenant customer accounts;
- SMTP/email alerts;
- enterprise RBAC or TOTP;
- full group-message archival;
- plugin marketplace, knowledge base, or agent tool execution;
- running 50 NapCat instances on the initial 4C8G Windows host.
