import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Button as CarbonButton,
  ProgressBar as CarbonProgressBar,
  Tag as CarbonTag,
  Theme,
} from "@carbon/react";
import {
  Activity,
  Bot,
  Boxes,
  Check,
  ChevronRight,
  CircleDollarSign,
  Copy,
  Database,
  Gauge,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Network,
  Package,
  Plus,
  RefreshCw,
  Save,
  Settings,
  ShieldCheck,
  TerminalSquare,
  Trash2,
  Users,
  X,
} from "lucide-react";
import "@carbon/styles/css/styles.css";
import "./styles.css";

type ApiResult<T> = { ok: boolean; data: T; error?: string };
let csrfToken = "";

async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
      ...options.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false)
    throw new Error(payload.error || `HTTP ${response.status}`);
  return (payload.data ?? payload) as T;
}

const navItems = [
  ["dashboard", "总览", LayoutDashboard],
  ["bots", "节点与机器人", Bot],
  ["licenses", "群授权", ShieldCheck],
  ["cards", "卡密", KeyRound],
  ["providers", "模型网关", Network],
  ["diagnostics", "消息诊断", TerminalSquare],
  ["settings", "机器人设置", Settings],
  ["logs", "日志与存储", Database],
] as const;

function App() {
  const [user, setUser] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState("dashboard");
  const [mobileNav, setMobileNav] = useState(false);
  const [flash, setFlash] = useState<{
    type: "ok" | "error";
    text: string;
  } | null>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then(async (response) => {
        if (!response.ok) return;
        const payload = await response.json();
        csrfToken = payload.csrf;
        setUser(payload.user.email);
      })
      .finally(() => setLoading(false));
  }, []);

  const notify = (text: string, type: "ok" | "error" = "ok") => {
    setFlash({ text, type });
    window.setTimeout(() => setFlash(null), 3500);
  };

  if (loading)
    return (
      <div className="screen-center">
        <RefreshCw className="spin" /> 正在连接控制面
      </div>
    );
  if (!user)
    return (
      <Login
        onLogin={(email, csrf) => {
          csrfToken = csrf;
          setUser(email);
        }}
      />
    );

  const current = navItems.find(([id]) => id === page)!;
  return (
    <div className="app-shell">
      <aside className={mobileNav ? "sidebar open" : "sidebar"}>
        <div className="brand">
          <div className="brand-mark">P</div>
          <div>
            <strong>泡芙控制台</strong>
            <span>QQ BOT CONTROL</span>
          </div>
        </div>
        <nav>
          {navItems.map(([id, label, Icon]) => (
            <button
              key={id}
              className={page === id ? "nav-item active" : "nav-item"}
              onClick={() => {
                setPage(id);
                setMobileNav(false);
              }}
            >
              <Icon size={18} />
              <span>{label}</span>
              <ChevronRight className="nav-arrow" size={15} />
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="operator">
            <span className="status-dot online" />
            <div>
              <strong>{user}</strong>
              <span>单管理员</span>
            </div>
          </div>
          <button
            className="icon-button inverted"
            title="退出登录"
            onClick={async () => {
              await api("/auth/logout", { method: "POST" });
              setUser(null);
            }}
          >
            <LogOut size={17} />
          </button>
        </div>
      </aside>
      {mobileNav && (
        <button
          className="backdrop"
          aria-label="关闭导航"
          onClick={() => setMobileNav(false)}
        />
      )}
      <main className="main">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            title="打开导航"
            onClick={() => setMobileNav(true)}
          >
            <Menu />
          </button>
          <div>
            <span className="eyebrow">OPERATION CONSOLE</span>
            <h1>{current[1]}</h1>
          </div>
          <div className="top-status">
            <Activity size={16} />
            <span>控制面在线</span>
          </div>
        </header>
        <div className="page-body">
          {page === "dashboard" && <Dashboard notify={notify} />}
          {page === "bots" && <BotsPage notify={notify} />}
          {page === "licenses" && <LicensesPage notify={notify} />}
          {page === "cards" && <CardsPage notify={notify} />}
          {page === "providers" && <ProvidersPage notify={notify} />}
          {page === "diagnostics" && <DiagnosticsPage notify={notify} />}
          {page === "settings" && <SettingsPage notify={notify} />}
          {page === "logs" && <LogsPage notify={notify} />}
        </div>
      </main>
      {flash && (
        <div className={`toast ${flash.type}`}>
          <span>
            {flash.type === "ok" ? <Check size={17} /> : <X size={17} />}
          </span>
          {flash.text}
        </div>
      )}
    </div>
  );
}

function Login({
  onLogin,
}: {
  onLogin: (email: string, csrf: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "登录失败");
      onLogin(payload.user.email, payload.csrf);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "登录失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-layout">
      <section className="login-signal">
        <div className="signal-grid" />
        <div className="login-brand">
          <div className="brand-mark large">P</div>
          <span>PUFF / CONTROL PLANE</span>
        </div>
        <div className="signal-copy">
          <span>LIGHTWEIGHT OPERATIONS</span>
          <h1>
            一个控制面，
            <br />
            管住所有机器人。
          </h1>
          <p>节点状态、群授权、模型切换和审核事件集中处理。</p>
        </div>
        <div className="signal-stats">
          <span>
            <b>3</b>近期机器人
          </span>
          <span>
            <b>50</b>扩展上限
          </span>
          <span>
            <b>5 GB</b>存储红线
          </span>
        </div>
      </section>
      <section className="login-panel">
        <form onSubmit={submit}>
          <div className="login-heading">
            <span className="eyebrow">ADMIN ACCESS</span>
            <h2>登录控制台</h2>
            <p>使用部署时设置的管理员邮箱和密码。</p>
          </div>
          <label>
            邮箱
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@example.com"
            />
          </label>
          <label>
            密码
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="至少 8 位"
            />
          </label>
          {error && <div className="form-error">{error}</div>}
          <button className="primary wide" disabled={busy}>
            {busy ? (
              <RefreshCw className="spin" size={17} />
            ) : (
              <KeyRound size={17} />
            )}
            进入控制台
          </button>
        </form>
      </section>
    </div>
  );
}

function useData<T>(path: string, initial: T, refreshMs = 0) {
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  const load = async () => {
    setLoading(true);
    try {
      setData(await api<T>(path));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    if (!refreshMs) return;
    const timer = window.setInterval(() => {
      void api<T>(path).then(setData).catch(() => undefined);
    }, refreshMs);
    return () => window.clearInterval(timer);
  }, [path, refreshMs]);
  return { data, loading, reload: load, setData };
}

function Dashboard({ notify }: PageProps) {
  const { data, loading, reload } = useData<any>("/dashboard", null, 15000);
  if (loading || !data) return <Loading />;
  const metrics = [
    ["机器人在线", `${data.bots.online}/${data.bots.total}`, Bot, "green"],
    ["节点在线", `${data.nodes.online}/${data.nodes.total}`, Boxes, "blue"],
    [
      "有效群授权",
      `${data.licenses.active}/${data.licenses.total}`,
      Users,
      "coral",
    ],
    [
      "健康网关",
      `${data.providers.healthy}/${data.providers.total}`,
      Network,
      "yellow",
    ],
  ] as const;
  const usage = data.usage || {
    today: data.usageToday || 0,
    total: data.usageToday || 0,
    last7Days: data.usageToday || 0,
    inputTokens: 0,
    outputTokens: 0,
    averageLatencyMs: 0,
  };
  return (
    <>
      <div className="metric-grid">
        {metrics.map(([label, value, Icon, tone]) => (
          <div className={`metric ${tone}`} key={label}>
            <div className="metric-icon">
              <Icon size={20} />
            </div>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <section className="split-section">
        <div>
          <SectionHead eyebrow="TRAFFIC" title="调用概况" />
          <div className="inline-stats">
            <div>
              <span>今日调用</span>
              <strong>{numberText(usage.today)}</strong>
            </div>
            <div>
              <span>累计调用</span>
              <strong>{numberText(usage.total)}</strong>
            </div>
            <div>
              <span>近 7 日</span>
              <strong>{numberText(usage.last7Days)}</strong>
            </div>
            <div>
              <span>今日审核</span>
              <strong>{numberText(data.moderationToday)}</strong>
            </div>
            <div>
              <span>累计 Token</span>
              <strong>
                {numberText(usage.inputTokens + usage.outputTokens)}
              </strong>
            </div>
            <div>
              <span>今日平均响应</span>
              <strong>
                {usage.averageLatencyMs
                  ? `${numberText(usage.averageLatencyMs)} ms`
                  : "-"}
              </strong>
            </div>
          </div>
        </div>
        <div className="storage-panel">
          <div className="storage-top">
            <span>磁盘预算</span>
            <b>{data.storage.percent}%</b>
          </div>
          <CarbonProgressBar
            className="storage-progress"
            label="磁盘占用"
            hideLabel
            size="small"
            value={Math.min(100, data.storage.percent)}
            max={100}
          />
          <p>
            {formatBytes(data.storage.usedBytes)} /{" "}
            {formatBytes(data.storage.limitBytes)} · {data.storage.fileCount}{" "}
            个受管文件
          </p>
          <button
            className="secondary"
            onClick={() => reload().catch((e) => notify(e.message, "error"))}
          >
            <RefreshCw size={16} />
            刷新数据
          </button>
        </div>
      </section>
    </>
  );
}

type PageProps = { notify: (text: string, type?: "ok" | "error") => void };

function BotsPage({ notify }: PageProps) {
  const nodes = useData<any[]>("/nodes", [], 15000);
  const bots = useData<any[]>("/bots", [], 15000);
  const [dialog, setDialog] = useState<"node" | "bot" | null>(null);
  const [secret, setSecret] = useState<any>(null);
  const [qr, setQr] = useState<any>(null);
  const [editingBot, setEditingBot] = useState<any>(null);
  const createNode = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    try {
      const data = await api("/nodes", {
        method: "POST",
        body: JSON.stringify({ name: fd.get("name") }),
      });
      setSecret(data);
      setDialog(null);
      await nodes.reload();
    } catch (e) {
      notify(message(e), "error");
    }
  };
  const createBot = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    try {
      await api("/bots", {
        method: "POST",
        body: JSON.stringify({
          nodeId: fd.get("nodeId"),
          qq: fd.get("qq"),
          name: fd.get("name"),
          persona: fd.get("persona"),
        }),
      });
      setDialog(null);
      await bots.reload();
      notify("机器人记录已创建");
    } catch (e) {
      notify(message(e), "error");
    }
  };
  const updateBot = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    try {
      await api(`/bots/${editingBot.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: fd.get("name"),
          enabled: fd.get("enabled") === "on",
          persona: fd.get("persona"),
          systemPrompt: fd.get("systemPrompt"),
          settings: editingBot.settings || {},
        }),
      });
      setEditingBot(null);
      await bots.reload();
      notify("机器人配置已保存");
    } catch (e) {
      notify(message(e), "error");
    }
  };
  return (
    <>
      <div className="action-row">
        <div className="summary-counts" aria-label="实例统计">
          <span>
            运行节点 <b>{nodes.data.length}</b>
          </span>
          <span>
            机器人 <b>{bots.data.length}</b>
          </span>
        </div>
        <div>
          <button className="secondary" onClick={() => setDialog("node")}>
            <Plus size={16} />
            添加节点
          </button>
          <button className="primary" onClick={() => setDialog("bot")}>
            <Plus size={16} />
            添加机器人
          </button>
        </div>
      </div>
      <SectionHead eyebrow="NODES" title="Windows 节点" />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>节点</th>
              <th>状态</th>
              <th>主机</th>
              <th>版本</th>
              <th>机器人</th>
              <th>最后心跳</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {nodes.data.map((node) => (
              <tr key={node.id}>
                <td>
                  <strong>{node.name}</strong>
                  <small>{node.id}</small>
                </td>
                <td>
                  <Status value={node.status} />
                </td>
                <td>{node.hostname || "待连接"}</td>
                <td>{node.version || "-"}</td>
                <td>{node.bot_count}</td>
                <td>{dateText(node.last_seen_at)}</td>
                <td>
                  <button
                    className="icon-button danger"
                    title="删除节点"
                    disabled={Number(node.bot_count) > 0}
                    onClick={async () => {
                      if (!confirm(`删除节点 ${node.name}？`)) return;
                      try {
                        await api(`/nodes/${node.id}`, { method: "DELETE" });
                        await nodes.reload();
                        notify("节点已删除");
                      } catch (e) {
                        notify(message(e), "error");
                      }
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <SectionHead eyebrow="BOTS" title="机器人实例" />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>机器人</th>
              <th>QQ</th>
              <th>所属节点</th>
              <th>状态</th>
              <th>人格</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {bots.data.map((bot) => (
              <tr key={bot.id}>
                <td>
                  <strong>{bot.name}</strong>
                  <small>{bot.id}</small>
                </td>
                <td className="mono">{bot.qq}</td>
                <td>{bot.node_name}</td>
                <td>
                  <Status value={bot.status} />
                </td>
                <td>{bot.persona || "使用全局默认"}</td>
                <td>
                  <div className="row-actions">
                    <button
                      className="icon-button"
                      title="编辑机器人"
                      onClick={() => setEditingBot(bot)}
                    >
                      <Settings size={16} />
                    </button>
                    <button
                      className="icon-button"
                      title="同步 QQ 群列表"
                      onClick={async () => {
                        try {
                          const result = await api<{ count: number }>(
                            `/bots/${bot.id}/sync-groups`,
                            { method: "POST" },
                          );
                          notify(`已同步 ${result.count} 个群`);
                        } catch (e) {
                          notify(message(e), "error");
                        }
                      }}
                    >
                      <Users size={16} />
                    </button>
                    <button
                      className="icon-button"
                      title="获取登录二维码"
                      onClick={async () => {
                        try {
                          setQr(
                            await api(`/bots/${bot.id}/qrcode`, {
                              method: "POST",
                            }),
                          );
                        } catch (e) {
                          notify(message(e), "error");
                        }
                      }}
                    >
                      <Gauge size={16} />
                    </button>
                    <button
                      className="icon-button"
                      title="重启 NapCat"
                      onClick={async () => {
                        try {
                          await api(`/bots/${bot.id}/restart`, {
                            method: "POST",
                          });
                          notify("已发送重启指令");
                        } catch (e) {
                          notify(message(e), "error");
                        }
                      }}
                    >
                      <RefreshCw size={16} />
                    </button>
                    <button
                      className="icon-button danger"
                      title="删除机器人"
                      onClick={async () => {
                        if (!confirm(`删除机器人 ${bot.name} 及其群授权？`))
                          return;
                        try {
                          await api(`/bots/${bot.id}`, { method: "DELETE" });
                          await bots.reload();
                          notify("机器人已删除");
                        } catch (e) {
                          notify(message(e), "error");
                        }
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {dialog === "node" && (
        <Modal title="添加 Windows 节点" onClose={() => setDialog(null)}>
          <form onSubmit={createNode}>
            <label>
              节点名称
              <input name="name" required placeholder="国内节点 01" />
            </label>
            <Submit text="创建并生成令牌" />
          </form>
        </Modal>
      )}
      {dialog === "bot" && (
        <Modal title="添加机器人" onClose={() => setDialog(null)}>
          <form onSubmit={createBot}>
            <label>
              所属节点
              <select name="nodeId" required>
                {nodes.data.map((n) => (
                  <option value={n.id} key={n.id}>
                    {n.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              机器人 QQ
              <input name="qq" required inputMode="numeric" />
            </label>
            <label>
              显示名称
              <input name="name" required placeholder="泡芙一号" />
            </label>
            <label>
              人格名称
              <input name="persona" placeholder="泡芙" />
            </label>
            <Submit text="创建机器人" />
          </form>
        </Modal>
      )}
      {editingBot && (
        <Modal title="编辑机器人" onClose={() => setEditingBot(null)}>
          <form onSubmit={updateBot}>
            <label>
              机器人 QQ
              <input value={editingBot.qq} disabled />
            </label>
            <label>
              显示名称
              <input name="name" required defaultValue={editingBot.name} />
            </label>
            <label>
              人格名称
              <input name="persona" defaultValue={editingBot.persona} />
            </label>
            <label>
              专属系统提示词
              <textarea
                name="systemPrompt"
                rows={6}
                defaultValue={editingBot.system_prompt}
                placeholder="留空使用全局默认值"
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={editingBot.enabled}
              />
              启用机器人
            </label>
            <Submit text="保存机器人" />
          </form>
        </Modal>
      )}
      {secret && (
        <Modal title="节点令牌仅显示一次" onClose={() => setSecret(null)}>
          <SecretBlock value={JSON.stringify(secret, null, 2)} />
          <p className="hint">将 nodeId 和 token 填入 Windows Agent 配置。</p>
        </Modal>
      )}
      {qr && (
        <Modal title="QQ 登录二维码" onClose={() => setQr(null)}>
          {qr.qrcode ? (
            <img className="qr" src={qr.qrcode} alt="QQ 登录二维码" />
          ) : (
            <pre>{JSON.stringify(qr, null, 2)}</pre>
          )}
        </Modal>
      )}
    </>
  );
}

function LicensesPage({ notify }: PageProps) {
  const licenses = useData<any[]>("/licenses", []);
  const plans = useData<any[]>("/plans", []);
  const bots = useData<any[]>("/bots", []);
  const groups = useData<any[]>("/groups", []);
  const [dialog, setDialog] = useState<"license" | "plan" | null>(null);
  const [editingPlan, setEditingPlan] = useState<any>(null);
  const createLicense = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    try {
      await api("/licenses", {
        method: "POST",
        body: JSON.stringify({
          botId: fd.get("botId"),
          groupId: fd.get("groupId"),
          planId: fd.get("planId"),
          durationDays: fd.get("durationDays")
            ? Number(fd.get("durationDays"))
            : null,
          permanent: fd.get("permanent") === "on",
        }),
      });
      setDialog(null);
      await licenses.reload();
      notify("群授权已保存");
    } catch (e) {
      notify(message(e), "error");
    }
  };
  const savePlan = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    const features = Object.fromEntries(
      [
        "chat",
        "tech",
        "vision",
        "draw",
        "lurk",
        "moderation",
        "privateChat",
      ].map((key) => [key, fd.get(key) === "on"]),
    );
    try {
      await api(editingPlan ? `/plans/${editingPlan.id}` : "/plans", {
        method: editingPlan ? "PUT" : "POST",
        body: JSON.stringify({
          name: fd.get("name"),
          durationDays: Number(fd.get("durationDays")),
          monthlyQuota: Number(fd.get("monthlyQuota")),
          features,
          enabled: fd.get("enabled") === "on",
        }),
      });
      setDialog(null);
      setEditingPlan(null);
      await plans.reload();
      notify(editingPlan ? "套餐已更新" : "套餐已创建");
    } catch (e) {
      notify(message(e), "error");
    }
  };
  return (
    <>
      <div className="action-row">
        <p className="page-note">
          授权按机器人 QQ 与群号绑定，过期后只保留基础授权指令。
        </p>
        <div>
          <button className="secondary" onClick={() => setDialog("plan")}>
            <Package size={16} />
            新套餐
          </button>
          <button className="primary" onClick={() => setDialog("license")}>
            <Plus size={16} />
            添加授权
          </button>
        </div>
      </div>
      <div className="metric-grid compact">
        {plans.data.map((plan) => (
          <div className="plan-summary" key={plan.id}>
            <span>{plan.name}</span>
            <strong>
              {plan.duration_days === 0
                ? "永久"
                : `${plan.duration_days || 30} 天`}
            </strong>
            <small>
              每月 {plan.monthly_quota || "不限"} 次 ·{" "}
              {Object.values(plan.features).filter(Boolean).length} 项功能
            </small>
            <button
              className="icon-button"
              title="编辑套餐"
              onClick={() => setEditingPlan(plan)}
            >
              <Settings size={16} />
            </button>
          </div>
        ))}
      </div>
      <SectionHead eyebrow="GROUP LICENSES" title="QQ群授权" />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>群号</th>
              <th>机器人</th>
              <th>套餐</th>
              <th>状态</th>
              <th>用量</th>
              <th>到期</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {licenses.data.map((item) => {
              const expired =
                !item.permanent && new Date(item.expires_at) <= new Date();
              return (
                <tr key={item.id}>
                  <td className="mono">{item.group_id}</td>
                  <td>
                    {item.bot_name}
                    <small>{item.qq}</small>
                  </td>
                  <td>{item.plan_name}</td>
                  <td>
                    <Status
                      value={
                        item.status === "active" && !expired
                          ? "active"
                          : "expired"
                      }
                    />
                  </td>
                  <td>
                    {item.usage_count}/{item.monthly_quota || "∞"}
                  </td>
                  <td>{item.permanent ? "永久" : dateText(item.expires_at)}</td>
                  <td>
                    <button
                      className="icon-button danger"
                      title="删除授权"
                      onClick={async () => {
                        if (!confirm("删除这条群授权？")) return;
                        await api(`/licenses/${item.id}`, { method: "DELETE" });
                        await licenses.reload();
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {dialog === "license" && (
        <Modal title="添加或续期群授权" onClose={() => setDialog(null)}>
          <form onSubmit={createLicense}>
            <label>
              机器人
              <select name="botId" required>
                {bots.data.map((b) => (
                  <option value={b.id} key={b.id}>
                    {b.name} ({b.qq})
                  </option>
                ))}
              </select>
            </label>
            <label>
              QQ群号
              <input
                name="groupId"
                required
                inputMode="numeric"
                list="known-qq-groups"
                placeholder="输入群号或从已同步群中选择"
              />
              <datalist id="known-qq-groups">
                {groups.data.map((group) => (
                  <option
                    value={group.group_id}
                    key={`${group.bot_id}:${group.group_id}`}
                  >
                    {group.group_name || group.group_id} / {group.bot_name}
                  </option>
                ))}
              </datalist>
            </label>
            <label>
              套餐
              <select name="planId" required>
                {plans.data.map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              本次授权天数
              <input
                name="durationDays"
                type="number"
                min="1"
                placeholder="留空跟随套餐；续期会叠加"
              />
            </label>
            <label className="check">
              <input type="checkbox" name="permanent" />
              设为永久授权
            </label>
            <Submit text="保存授权" />
          </form>
        </Modal>
      )}
      {(dialog === "plan" || editingPlan) && (
        <Modal
          title={editingPlan ? "编辑套餐" : "创建套餐"}
          onClose={() => {
            setDialog(null);
            setEditingPlan(null);
          }}
        >
          <form onSubmit={savePlan}>
            <label>
              套餐名称
              <input name="name" required defaultValue={editingPlan?.name} />
            </label>
            <div className="form-grid">
              <label>
                有效天数
                <input
                  name="durationDays"
                  type="number"
                  min="0"
                  defaultValue={editingPlan?.duration_days ?? 30}
                />
              </label>
              <label>
                月调用次数
                <input
                  name="monthlyQuota"
                  type="number"
                  min="0"
                  defaultValue={editingPlan?.monthly_quota ?? 3000}
                />
              </label>
            </div>
            <fieldset>
              <legend>套餐功能</legend>
              <div className="check-grid">
                {[
                  ["chat", "AI闲聊"],
                  ["tech", "技术答疑"],
                  ["vision", "图片理解"],
                  ["draw", "图片生成"],
                  ["lurk", "主动插话"],
                  ["moderation", "内容审核"],
                  ["privateChat", "私聊扩展"],
                ].map(([key, label]) => (
                  <label className="check" key={key}>
                    <input
                      type="checkbox"
                      name={key}
                      defaultChecked={
                        editingPlan
                          ? Boolean(editingPlan.features[key!])
                          : key !== "draw" && key !== "privateChat"
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
            {editingPlan && (
              <label className="check">
                <input
                  type="checkbox"
                  name="enabled"
                  defaultChecked={editingPlan.enabled}
                />
                启用套餐
              </label>
            )}
            {!editingPlan && <input type="hidden" name="enabled" value="on" />}
            <Submit text={editingPlan ? "保存套餐" : "创建套餐"} />
          </form>
        </Modal>
      )}
    </>
  );
}

function CardsPage({ notify }: PageProps) {
  const cards = useData<any[]>("/cards", []);
  const plans = useData<any[]>("/plans", []);
  const [dialog, setDialog] = useState(false);
  const [codes, setCodes] = useState<string[]>([]);
  const generate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    try {
      const data = await api<{ codes: string[] }>("/cards/generate", {
        method: "POST",
        body: JSON.stringify({
          planId: fd.get("planId"),
          count: Number(fd.get("count")),
          durationDays: fd.get("durationDays")
            ? Number(fd.get("durationDays"))
            : null,
        }),
      });
      setDialog(false);
      setCodes(data.codes);
      await cards.reload();
    } catch (e) {
      notify(message(e), "error");
    }
  };
  return (
    <>
      <div className="action-row">
        <p className="page-note">
          原始卡密只在生成后显示一次，数据库仅保存 SHA-256 摘要。
        </p>
        <button className="primary" onClick={() => setDialog(true)}>
          <Plus size={16} />
          批量生成
        </button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>卡密前缀</th>
              <th>套餐</th>
              <th>状态</th>
              <th>绑定机器人</th>
              <th>绑定群</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {cards.data.map((card) => (
              <tr key={card.id}>
                <td className="mono">{card.code_prefix}••••••</td>
                <td>{card.plan_name}</td>
                <td>
                  <Status value={card.status} />
                </td>
                <td>{card.bound_bot_id || "-"}</td>
                <td>{card.bound_group_id || "-"}</td>
                <td>{dateText(card.created_at)}</td>
                <td>
                  {card.status === "unused" && (
                    <button
                      className="icon-button danger"
                      title="撤销卡密"
                      onClick={async () => {
                        await api(`/cards/${card.id}/revoke`, {
                          method: "POST",
                        });
                        await cards.reload();
                      }}
                    >
                      <X size={16} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {dialog && (
        <Modal title="批量生成卡密" onClose={() => setDialog(false)}>
          <form onSubmit={generate}>
            <label>
              套餐
              <select name="planId" required>
                {plans.data.map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="form-grid">
              <label>
                数量
                <input
                  type="number"
                  name="count"
                  min="1"
                  max="500"
                  defaultValue="10"
                />
              </label>
              <label>
                覆盖有效天数
                <input
                  type="number"
                  name="durationDays"
                  min="0"
                  placeholder="留空跟随套餐"
                />
              </label>
            </div>
            <Submit text="生成卡密" />
          </form>
        </Modal>
      )}
      {codes.length > 0 && (
        <Modal
          title={`已生成 ${codes.length} 张卡密`}
          onClose={() => setCodes([])}
        >
          <SecretBlock value={codes.join("\n")} />
          <p className="hint">关闭窗口后无法再次查看完整卡密。</p>
        </Modal>
      )}
    </>
  );
}

function ProvidersPage({ notify }: PageProps) {
  const providers = useData<any[]>("/providers", []);
  const [dialog, setDialog] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const create = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    try {
      const result = await api<any>("/providers", {
        method: "POST",
        body: JSON.stringify({
          name: fd.get("name"),
          baseUrl: fd.get("baseUrl"),
          apiKey: fd.get("apiKey"),
          model: fd.get("model"),
          priority: Number(fd.get("priority")),
          timeoutMs: Number(fd.get("timeoutMs")),
        }),
      });
      setDialog(false);
      await providers.reload();
      notify(
        result.probe?.healthy
          ? `网关可用，延迟 ${result.probe.latencyMs} ms`
          : `网关已保存，但探测失败：${result.probe?.error || "未知错误"}`,
        result.probe?.healthy ? "ok" : "error",
      );
    } catch (e) {
      notify(message(e), "error");
    }
  };
  const update = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    try {
      await api(`/providers/${editing.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: fd.get("name"),
          baseUrl: fd.get("baseUrl"),
          apiKey: fd.get("apiKey") || undefined,
          model: fd.get("model"),
          priority: Number(fd.get("priority")),
          timeoutMs: Number(fd.get("timeoutMs")),
          enabled: fd.get("enabled") === "on",
        }),
      });
      setEditing(null);
      await providers.reload();
      notify("网关配置已保存");
    } catch (e) {
      notify(message(e), "error");
    }
  };
  return (
    <>
      <div className="action-row">
        <p className="page-note">
          所有功能共用这个故障切换链，按优先级选择能力匹配且健康的网关。
        </p>
        <button className="primary" onClick={() => setDialog(true)}>
          <Plus size={16} />
          添加网关
        </button>
      </div>
      <div className="provider-list">
        {providers.data.map((provider, index) => (
          <article className="provider-row" key={provider.id}>
            <div className="priority">{String(index + 1).padStart(2, "0")}</div>
            <div className="provider-main">
              <div>
                <strong>{provider.name}</strong>
                <Status value={provider.health_status} />
              </div>
              <span>{provider.base_url}</span>
              <small>
                {provider.model} · 超时 {provider.timeout_ms / 1000}s · Key{" "}
                {provider.apiKeyMasked}
              </small>
            </div>
            <div className="capabilities">
              {Object.entries(provider.capabilities).map(([key, value]) => (
                <span className={value ? "cap on" : "cap"} key={key}>
                  {key}
                </span>
              ))}
            </div>
            <div className="provider-health">
              <b>{provider.latency_ms ? `${provider.latency_ms} ms` : "-"}</b>
              <small title={provider.last_error || "无错误"}>
                24h 成功率{" "}
                {provider.health24h?.successRate == null
                  ? "待采样"
                  : `${provider.health24h.successRate}%`}
                {provider.health24h?.averageLatencyMs
                  ? ` / ${provider.health24h.averageLatencyMs} ms`
                  : ""}
              </small>
            </div>
            <div className="row-actions">
              <button
                className="icon-button"
                title="编辑网关"
                onClick={() => setEditing(provider)}
              >
                <Settings size={16} />
              </button>
              <button
                className="icon-button"
                title="重新探测"
                onClick={async () => {
                  try {
                    const result = await api<any>(`/providers/${provider.id}/probe`, {
                      method: "POST",
                    });
                    await providers.reload();
                    notify(
                      result.healthy
                        ? `网关可用，延迟 ${result.latencyMs} ms`
                        : `探测失败：${result.error || "未知错误"}`,
                      result.healthy ? "ok" : "error",
                    );
                  } catch (e) {
                    notify(message(e), "error");
                  }
                }}
              >
                <RefreshCw size={16} />
              </button>
              <button
                className="icon-button danger"
                title="删除网关"
                onClick={async () => {
                  if (!confirm(`删除网关 ${provider.name}？`)) return;
                  try {
                    await api(`/providers/${provider.id}`, {
                      method: "DELETE",
                    });
                    await providers.reload();
                    notify("网关已删除");
                  } catch (e) {
                    notify(message(e), "error");
                  }
                }}
              >
                <Trash2 size={16} />
              </button>
            </div>
          </article>
        ))}
      </div>
      {dialog && (
        <Modal title="添加 AI 网关" onClose={() => setDialog(false)}>
          <form onSubmit={create}>
            <label>
              名称
              <input name="name" required placeholder="主网关" />
            </label>
            <label>
              OpenAI 兼容地址
              <input
                name="baseUrl"
                type="url"
                required
                placeholder="https://api.example.com"
              />
            </label>
            <label>
              API Key
              <input name="apiKey" type="password" required />
            </label>
            <label>
              模型名称
              <input name="model" required placeholder="gpt-5.6-terra" />
            </label>
            <div className="form-grid">
              <label>
                优先级
                <input
                  name="priority"
                  type="number"
                  min="0"
                  defaultValue="100"
                />
              </label>
              <label>
                超时毫秒
                <input
                  name="timeoutMs"
                  type="number"
                  min="1000"
                  defaultValue="30000"
                />
              </label>
            </div>
            <Submit text="保存并探测" />
          </form>
        </Modal>
      )}
      {editing && (
        <Modal title="编辑 AI 网关" onClose={() => setEditing(null)}>
          <form onSubmit={update}>
            <label>
              名称
              <input name="name" required defaultValue={editing.name} />
            </label>
            <label>
              OpenAI 兼容地址
              <input
                name="baseUrl"
                type="url"
                required
                defaultValue={editing.base_url}
              />
            </label>
            <label>
              新 API Key
              <input
                name="apiKey"
                type="password"
                placeholder="留空保持原 Key"
              />
            </label>
            <label>
              模型名称
              <input name="model" required defaultValue={editing.model} />
            </label>
            <div className="form-grid">
              <label>
                优先级
                <input
                  name="priority"
                  type="number"
                  min="0"
                  defaultValue={editing.priority}
                />
              </label>
              <label>
                超时毫秒
                <input
                  name="timeoutMs"
                  type="number"
                  min="1000"
                  defaultValue={editing.timeout_ms}
                />
              </label>
            </div>
            <label className="check">
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={editing.enabled}
              />
              启用网关
            </label>
            <Submit text="保存网关" />
          </form>
        </Modal>
      )}
    </>
  );
}

function DiagnosticsPage({ notify }: PageProps) {
  const bots = useData<any[]>("/bots", []);
  const [botId, setBotId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [decision, setDecision] = useState("");
  const [selected, setSelected] = useState<any>(null);
  const path = useMemo(() => {
    const query = new URLSearchParams({ limit: "200" });
    if (botId) query.set("botId", botId);
    if (groupId.trim()) query.set("groupId", groupId.trim());
    if (decision) query.set("decision", decision);
    return `/diagnostics?${query}`;
  }, [botId, groupId, decision]);
  const traces = useData<{ rows: any[]; counts: any[] }>(
    path,
    { rows: [], counts: [] },
    5000,
  );
  const countFor = (name: string) =>
    Number(traces.data.counts.find((item) => item.decision === name)?.count || 0);
  return (
    <>
      <div className="action-row diagnostic-toolbar">
        <div className="diagnostic-filters">
          <select value={botId} onChange={(event) => setBotId(event.target.value)}>
            <option value="">全部机器人</option>
            {bots.data.map((bot) => (
              <option value={bot.id} key={bot.id}>
                {bot.name} ({bot.qq})
              </option>
            ))}
          </select>
          <input
            value={groupId}
            onChange={(event) => setGroupId(event.target.value)}
            placeholder="筛选群号"
            inputMode="numeric"
          />
          <select
            value={decision}
            onChange={(event) => setDecision(event.target.value)}
          >
            <option value="">全部处理结果</option>
            <option value="received">处理中</option>
            <option value="queued">等待接话</option>
            <option value="replied">已回复</option>
            <option value="command">内置命令</option>
            <option value="custom_reply">自定义回复</option>
            <option value="private">私聊</option>
            <option value="ignored">已忽略</option>
            <option value="denied">权限不足</option>
            <option value="moderated">审核处理</option>
            <option value="error">处理失败</option>
          </select>
        </div>
        <div>
          <button className="secondary" onClick={() => traces.reload()}>
            <RefreshCw size={16} />
            刷新
          </button>
          <button
            className="secondary"
            onClick={async () => {
              if (!confirm("确定清空消息诊断记录？")) return;
              const result = await api<{ deleted: number }>("/diagnostics", {
                method: "DELETE",
              });
              await traces.reload();
              notify(`已清空 ${result.deleted} 条诊断记录`);
            }}
          >
            <X size={16} />
            清空
          </button>
        </div>
      </div>
      <div className="trace-summary" aria-label="最近 24 小时处理统计">
        <span><b>{countFor("replied")}</b> 已回复</span>
        <span><b>{countFor("queued")}</b> 等待接话</span>
        <span><b>{countFor("ignored")}</b> 已忽略</span>
        <span><b>{countFor("error")}</b> 失败</span>
      </div>
      <SectionHead eyebrow="MESSAGE PIPELINE" title="消息处理轨迹" />
      <div className="table-wrap diagnostic-table-wrap">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>机器人 / 群</th>
              <th>消息</th>
              <th>结果</th>
              <th>原因</th>
              <th>网关 / 耗时</th>
            </tr>
          </thead>
          <tbody>
            {traces.data.rows.map((row) => (
              <tr
                key={row.id}
                className="clickable-row"
                onClick={() => setSelected(row)}
              >
                <td>{dateText(row.created_at)}</td>
                <td>
                  <strong>{row.bot_name}</strong>
                  <small className="mono">{row.group_id || "私聊"}</small>
                </td>
                <td className="trace-excerpt">
                  {row.excerpt || (row.image_count ? `[${row.image_count} 张图片]` : "-")}
                </td>
                <td><TraceBadge value={row.decision} /></td>
                <td className="trace-reason">{row.reason || "-"}</td>
                <td>
                  {row.provider_name || "-"}
                  <small>{row.latency_ms ? `${row.latency_ms} ms` : "-"}</small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!traces.data.rows.length && (
          <div className="diagnostic-empty">还没有消息轨迹</div>
        )}
      </div>
      {selected && (
        <Modal title="消息诊断详情" onClose={() => setSelected(null)}>
          <dl className="trace-detail">
            <dt>机器人</dt><dd>{selected.bot_name} ({selected.qq})</dd>
            <dt>群 / 用户</dt><dd>{selected.group_id || "私聊"} / {selected.user_id || "-"}</dd>
            <dt>处理结果</dt><dd><TraceBadge value={selected.decision} /></dd>
            <dt>原因</dt><dd>{selected.reason || "-"}</dd>
            <dt>模型调用</dt><dd>{selected.provider_name || "-"} / {selected.latency_ms || 0} ms</dd>
            <dt>Token</dt><dd>{selected.input_tokens || 0} / {selected.output_tokens || 0}</dd>
          </dl>
          <pre className="diagnostic-json">{JSON.stringify(JSON.parse(selected.detail_json || "{}"), null, 2)}</pre>
        </Modal>
      )}
    </>
  );
}

function TraceBadge({ value }: { value: string }) {
  const labels: Record<string, string> = {
    received: "已接收",
    queued: "等待接话",
    replied: "已回复",
    command: "内置命令",
    custom_reply: "自定义回复",
    ignored: "已忽略",
    denied: "权限不足",
    moderated: "审核处理",
    private: "私聊",
    error: "失败",
  };
  return <span className={`trace-badge ${value}`}>{labels[value] || value}</span>;
}

function SettingsPage({ notify }: PageProps) {
  const settings = useData<any>("/settings", null);
  const [tab, setTab] = useState("admins");
  if (!settings.data) return <Loading />;
  const save = async (key: string, value: unknown) => {
    try {
      await api(`/settings/${key}`, {
        method: "PUT",
        body: JSON.stringify(value),
      });
      await settings.reload();
      notify("设置已保存");
    } catch (e) {
      notify(message(e), "error");
    }
  };
  return (
    <>
      <div className="settings-layout">
        <nav className="settings-nav">
          {(
            [
              ["admins", "全局管理员"],
              ["commands", "内置指令"],
              ["custom", "自定义命令"],
              ["persona", "人格与节奏"],
              ["moderation", "平衡审核"],
              ["outbound", "出站过滤"],
              ["security", "登录安全"],
            ] as Array<[string, string]>
          ).map(([id, label]) => (
            <button
              className={tab === id ? "active" : ""}
              onClick={() => setTab(id)}
              key={id}
            >
              {label}
            </button>
          ))}
        </nav>
        <section className="settings-form">
          {tab === "admins" && (
            <JsonLinesEditor
              title="全局管理员 QQ"
              description="每行一个 QQ 号，拥有跨群最高权限。"
              value={settings.data.global_admin_qqs || []}
              onSave={(value) => save("global_admin_qqs", value)}
            />
          )}
          {tab === "commands" && (
            <>
              <p className="page-note">
                这里修改系统内置指令的名称；需要新增任意触发词时，请使用“自定义命令”。
              </p>
              <ObjectEditor
                title="群指令"
                value={settings.data.commands}
                fields={[
                  ["prefix", "指令前缀"],
                  ["status", "授权状态"],
                  ["quota", "剩余额度"],
                  ["activate", "激活卡密"],
                  ["help", "帮助"],
                  ["reset", "清除记忆"],
                ]}
                onSave={(value) => save("commands", value)}
              />
            </>
          )}
          {tab === "custom" && <CustomCommandsEditor notify={notify} />}
          {tab === "persona" && (
            <ObjectEditor
              title="全局人格默认值"
              value={settings.data.bot_defaults}
              fields={[
                ["persona", "默认名称"],
                ["systemPrompt", "闲聊提示词", "textarea"],
                ["techPrompt", "技术答疑提示词", "textarea"],
                ["lurkPrompt", "主动插话提示词", "textarea"],
                ["idlePrompt", "冷场起话题提示词", "textarea"],
                ["idleEnabled", "启用冷场自动活跃", "checkbox"],
                ["cooldownMs", "群冷却毫秒", "number"],
                ["maxHistory", "最大历史条数", "number"],
                ["lurkEnabled", "启用上下文自动参与", "checkbox"],
                ["lurkMinMessages", "判断所需最少消息数", "number"],
                ["lurkQuietSeconds", "等待群聊停顿秒数", "number"],
                ["lurkIntervalSeconds", "两次自动参与最短间隔秒", "number"],
                ["idleAfterMinutes", "冷场间隔分钟", "number"],
                ["idleMaxAttempts", "无人回应最多尝试次数", "number"],
                ["activeStartHour", "每日开始活跃小时", "number"],
                ["activeEndHour", "每日结束活跃小时", "number"],
                ["activeTimezone", "活跃时区"],
              ]}
              onSave={(value) => save("bot_defaults", value)}
            />
          )}
          {tab === "moderation" && (
            <ModerationEditor
              value={settings.data.moderation}
              onSave={(value) => save("moderation", value)}
            />
          )}
          {tab === "outbound" && (
            <OutboundEditor
              value={settings.data.outbound_filter}
              onSave={(value) => save("outbound_filter", value)}
            />
          )}
          {tab === "security" && <PasswordEditor notify={notify} />}
        </section>
      </div>
    </>
  );
}

function CustomCommandsEditor({ notify }: PageProps) {
  const commands = useData<any[]>("/custom-commands", []);
  const bots = useData<any[]>("/bots", []);
  const [editing, setEditing] = useState<any>(null);
  const [creating, setCreating] = useState(false);
  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    const payload = {
      botId: fd.get("botId") || null,
      groupId: fd.get("groupId") || null,
      trigger: fd.get("trigger"),
      response: fd.get("response"),
      matchMode: fd.get("matchMode"),
      enabled: fd.get("enabled") === "on",
    };
    try {
      await api(
        editing ? `/custom-commands/${editing.id}` : "/custom-commands",
        {
          method: editing ? "PUT" : "POST",
          body: JSON.stringify(payload),
        },
      );
      setEditing(null);
      setCreating(false);
      await commands.reload();
      notify("自定义命令已保存");
    } catch (error) {
      notify(message(error), "error");
    }
  };
  const current = editing || {};
  return (
    <>
      <div className="action-row">
        <p className="page-note">
          自定义命令直接返回固定内容，不调用 AI。回复可使用 {"{user}"}、{"{qq}"}、
          {"{group}"}、{"{bot}"}。
        </p>
        <button className="primary" onClick={() => setCreating(true)}>
          <Plus size={16} />
          新增命令
        </button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>触发词</th>
              <th>匹配</th>
              <th>作用范围</th>
              <th>回复</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {commands.data.map((item) => (
              <tr key={item.id}>
                <td>
                  <span className="mono">{item.trigger_text}</span>
                  {!item.enabled && <small>已停用</small>}
                </td>
                <td>
                  {{ exact: "完全一致", prefix: "开头匹配", contains: "包含" }[
                    item.match_mode as "exact"
                  ] || item.match_mode}
                </td>
                <td>
                  {item.bot_name || "全部机器人"}
                  <small className="mono">{item.group_id || "全部授权群"}</small>
                </td>
                <td className="truncate">{item.response_text}</td>
                <td>
                  <div className="row-actions">
                    <button
                      className="icon-button"
                      title="编辑命令"
                      onClick={() => setEditing(item)}
                    >
                      <Settings size={16} />
                    </button>
                    <button
                      className="icon-button danger"
                      title="删除命令"
                      onClick={async () => {
                        if (!confirm(`删除触发词“${item.trigger_text}”？`)) return;
                        await api(`/custom-commands/${item.id}`, {
                          method: "DELETE",
                        });
                        await commands.reload();
                        notify("自定义命令已删除");
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!commands.data.length && (
              <tr>
                <td colSpan={5} className="empty-row">
                  还没有自定义回复
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {(creating || editing) && (
        <Modal
          title={editing ? "编辑自定义命令" : "新增自定义命令"}
          onClose={() => {
            setEditing(null);
            setCreating(false);
          }}
        >
          <form onSubmit={save}>
            <label>
              机器人范围
              <select name="botId" defaultValue={current.bot_id || ""}>
                <option value="">全部机器人</option>
                {bots.data.map((bot) => (
                  <option value={bot.id} key={bot.id}>
                    {bot.name} ({bot.qq})
                  </option>
                ))}
              </select>
            </label>
            <label>
              指定群号
              <input
                name="groupId"
                inputMode="numeric"
                defaultValue={current.group_id || ""}
                placeholder="留空表示全部已授权群"
              />
            </label>
            <div className="form-grid">
              <label>
                触发词
                <input
                  name="trigger"
                  required
                  defaultValue={current.trigger_text || ""}
                  placeholder="例如：群规"
                />
              </label>
              <label>
                匹配方式
                <select
                  name="matchMode"
                  defaultValue={current.match_mode || "exact"}
                >
                  <option value="exact">完全一致</option>
                  <option value="prefix">消息开头</option>
                  <option value="contains">消息包含</option>
                </select>
              </label>
            </div>
            <label>
              回复内容
              <textarea
                name="response"
                rows={5}
                required
                defaultValue={current.response_text || ""}
                placeholder="例如：{user}，群规在群公告里，先看置顶消息。"
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={editing ? Boolean(current.enabled) : true}
              />
              启用这条回复
            </label>
            <Submit text="保存回复" />
          </form>
        </Modal>
      )}
    </>
  );
}

function LogsPage({ notify }: PageProps) {
  const [type, setType] = useState("audit");
  const logs = useData<any[]>(`/logs?type=${type}&limit=200`, []);
  const counts = useData<Record<string, number>>("/logs/counts", {
    audit: 0,
    moderation: 0,
    usage: 0,
  });
  const storage = useData<any>("/storage", null);
  return (
    <>
      <div className="action-row">
        <div className="segmented">
          {(
            [
              ["audit", `操作日志 ${counts.data.audit || 0}`],
              ["moderation", `审核事件 ${counts.data.moderation || 0}`],
              ["usage", `调用记录 ${counts.data.usage || 0}`],
            ] as Array<[string, string]>
          ).map(([id, label]) => (
            <button
              className={type === id ? "selected" : ""}
              onClick={() => setType(id)}
              key={id}
            >
              {label}
            </button>
          ))}
        </div>
        <div>
          <button
            className="secondary"
            onClick={async () => {
              const result = await api("/storage/backup", { method: "POST" });
              notify(`备份完成：${result.file}`);
            }}
          >
            <Database size={16} />
            立即备份
          </button>
          <button
            className="primary"
            onClick={async () => {
              const result = await api<any>("/storage/cleanup", {
                method: "POST",
              });
              await storage.reload();
              await logs.reload();
              await counts.reload();
              const deleted =
                Number(result.sessions || 0) +
                Number(result.usageEvents || 0) +
                Number(result.auditLogs || 0) +
                Number(result.moderationEvents || 0) +
                Number(result.filesDeleted || 0);
              notify(`过期数据清理完成，共处理 ${deleted} 项`);
            }}
          >
            <Trash2 size={16} />
            清理过期数据
          </button>
          <button
            className="secondary"
            onClick={async () => {
              const label =
                type === "audit"
                  ? "操作日志"
                  : type === "moderation"
                    ? "审核事件"
                    : "调用记录";
              if (!confirm(`确定清空全部${label}？此操作不可撤销。`)) return;
              const result = await api<{ deleted: number }>(`/logs/${type}`, {
                method: "DELETE",
              });
              await logs.reload();
              await counts.reload();
              notify(`已清空 ${result.deleted} 条${label}`);
            }}
          >
            <X size={16} />
            清空当前日志
          </button>
        </div>
      </div>
      {storage.data && (
        <section className="storage-strip">
          <div>
            <Gauge />
            <span>
              已用 <b>{formatBytes(storage.data.usedBytes)}</b>
            </span>
          </div>
          <CarbonProgressBar
            className="storage-progress"
            label="磁盘占用"
            hideLabel
            size="small"
            value={Math.min(100, storage.data.percent)}
            max={100}
          />
          <span>上限 {formatBytes(storage.data.limitBytes)}</span>
        </section>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>类型/动作</th>
              <th>对象</th>
              <th>详情</th>
            </tr>
          </thead>
          <tbody>
            {logs.data.map((row, i) => (
              <tr key={row.id || i}>
                <td>{dateText(row.created_at)}</td>
                <td>{row.action || row.kind}</td>
                <td>{row.target || row.group_id || row.bot_id || "-"}</td>
                <td className="truncate">
                  {row.reason ||
                    row.excerpt ||
                    row.detail_json ||
                    `${row.input_tokens || 0}/${row.output_tokens || 0} tokens · ${row.latency_ms || 0} ms`}
                </td>
              </tr>
            ))}
            {!logs.data.length && (
              <tr>
                <td colSpan={4} className="empty-row">
                  当前没有记录
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function SectionHead({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="section-head">
      <span className="eyebrow">{eyebrow}</span>
      <h2>{title}</h2>
    </div>
  );
}
function Loading() {
  return (
    <div className="loading">
      <RefreshCw className="spin" />
      加载中
    </div>
  );
}
function Status({ value }: { value: string }) {
  const good = ["online", "active", "healthy", "used"].includes(value);
  const bad = ["offline", "expired", "unhealthy", "revoked"].includes(value);
  const labels: Record<string, string> = {
    online: "在线",
    offline: "离线",
    active: "有效",
    expired: "到期",
    healthy: "健康",
    unhealthy: "异常",
    unknown: "待探测",
    unused: "未使用",
    used: "已使用",
    revoked: "已撤销",
    disabled: "已停用",
  };
  return (
    <CarbonTag
      className="status-tag"
      size="sm"
      type={good ? "green" : bad ? "red" : "cool-gray"}
    >
      {labels[value] || value}
    </CarbonTag>
  );
}
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="modal-layer">
      <button className="backdrop" aria-label="关闭弹窗" onClick={onClose} />
      <div className="modal" role="dialog" aria-modal="true">
        <header>
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
function Submit({ text }: { text: string }) {
  return (
    <CarbonButton
      className="wide submit-button"
      kind="primary"
      size="lg"
      type="submit"
    >
      <Save size={16} />
      {text}
    </CarbonButton>
  );
}
function SecretBlock({ value }: { value: string }) {
  return (
    <div className="secret-block">
      <pre>{value}</pre>
      <button
        className="icon-button inverted"
        title="复制"
        onClick={() => navigator.clipboard.writeText(value)}
      >
        <Copy size={17} />
      </button>
    </div>
  );
}

function JsonLinesEditor({
  title,
  description,
  value,
  onSave,
}: {
  title: string;
  description: string;
  value: string[];
  onSave: (value: string[]) => void;
}) {
  const [text, setText] = useState(value.join("\n"));
  useEffect(() => setText(value.join("\n")), [JSON.stringify(value)]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(
          text
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean),
        );
      }}
    >
      <SectionHead eyebrow="ACCESS" title={title} />
      <p className="form-description">{description}</p>
      <label>
        QQ 白名单
        <textarea
          rows={10}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <Submit text="保存设置" />
    </form>
  );
}
function ObjectEditor({
  title,
  value,
  fields,
  onSave,
}: {
  title: string;
  value: any;
  fields: Array<[string, string, string?]>;
  onSave: (value: any) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [JSON.stringify(value)]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(draft);
      }}
    >
      <SectionHead eyebrow="CONFIGURATION" title={title} />
      {fields.map(([key, label, type]) =>
        type === "checkbox" ? (
          <label className="check" key={key}>
            <input
              type="checkbox"
              checked={Boolean(draft[key])}
              onChange={(e) =>
                setDraft({ ...draft, [key]: e.target.checked })
              }
            />
            {label}
          </label>
        ) : (
          <label key={key}>
            {label}
            {type === "textarea" ? (
            <textarea
              rows={5}
              value={draft[key] ?? ""}
              onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
            />
            ) : (
              <input
                type={type || "text"}
                value={draft[key] ?? ""}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    [key]:
                      type === "number"
                        ? Number(e.target.value)
                        : e.target.value,
                  })
                }
              />
            )}
          </label>
        ),
      )}
      <Submit text="保存设置" />
    </form>
  );
}
function ModerationEditor({
  value,
  onSave,
}: {
  value: any;
  onSave: (value: any) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [JSON.stringify(value)]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(draft);
      }}
    >
      <SectionHead eyebrow="MODERATION" title="平衡审核" />
      <div className="form-grid">
        <label>
          违规动作
          <select
            value={draft.action}
            onChange={(e) => setDraft({ ...draft, action: e.target.value })}
          >
            <option value="log">仅记录</option>
            <option value="recall">撤回</option>
            <option value="recall_ban">撤回并禁言</option>
          </select>
        </label>
        <label>
          禁言秒数
          <input
            type="number"
            value={draft.muteSeconds}
            onChange={(e) =>
              setDraft({ ...draft, muteSeconds: Number(e.target.value) })
            }
          />
        </label>
      </div>
      <div className="check-grid">
        {(
          [
            ["aiReview", "AI 文本复核"],
            ["imageReview", "图片视觉审核"],
            ["contextReview", "拆条上下文审核"],
            ["nicknameReview", "群昵称审核"],
          ] as Array<[string, string]>
        ).map(([key, label]) => (
          <label className="check" key={key}>
            <input
              type="checkbox"
              checked={draft[key]}
              onChange={(e) => setDraft({ ...draft, [key]: e.target.checked })}
            />
            {label}
          </label>
        ))}
      </div>
      <label>
        硬命中关键词（每行一个）
        <textarea
          rows={6}
          value={(draft.hardKeywords || []).join("\n")}
          onChange={(e) =>
            setDraft({
              ...draft,
              hardKeywords: e.target.value.split(/\r?\n/).filter(Boolean),
            })
          }
        />
      </label>
      <label>
        正则规则（每行一个）
        <textarea
          rows={6}
          className="mono"
          value={(draft.hardPatterns || []).join("\n")}
          onChange={(e) =>
            setDraft({
              ...draft,
              hardPatterns: e.target.value.split(/\r?\n/).filter(Boolean),
            })
          }
        />
      </label>
      <Submit text="保存审核规则" />
    </form>
  );
}

function OutboundEditor({
  value,
  onSave,
}: {
  value: any;
  onSave: (value: any) => void;
}) {
  const [draft, setDraft] = useState(
    value || {
      enabled: true,
      replacement: "[内容已过滤]",
      keywords: [],
      patterns: [],
    },
  );
  useEffect(() => setDraft(value), [JSON.stringify(value)]);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave(draft);
      }}
    >
      <SectionHead eyebrow="OUTPUT SAFETY" title="AI 出站过滤" />
      <p className="form-description">
        在机器人消息发出前替换密钥、提示词泄露和自定义敏感片段。
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) =>
            setDraft({ ...draft, enabled: event.target.checked })
          }
        />
        启用出站过滤
      </label>
      <label>
        替换文本
        <input
          value={draft.replacement || ""}
          onChange={(event) =>
            setDraft({ ...draft, replacement: event.target.value })
          }
        />
      </label>
      <label>
        关键词（每行一个）
        <textarea
          rows={6}
          value={(draft.keywords || []).join("\n")}
          onChange={(event) =>
            setDraft({
              ...draft,
              keywords: event.target.value
                .split(/\r?\n/)
                .map((item) => item.trim())
                .filter(Boolean),
            })
          }
        />
      </label>
      <label>
        正则规则（每行一个）
        <textarea
          rows={6}
          className="mono"
          value={(draft.patterns || []).join("\n")}
          onChange={(event) =>
            setDraft({
              ...draft,
              patterns: event.target.value
                .split(/\r?\n/)
                .map((item) => item.trim())
                .filter(Boolean),
            })
          }
        />
      </label>
      <Submit text="保存出站规则" />
    </form>
  );
}

function PasswordEditor({ notify }: PageProps) {
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fd = new FormData(form);
    const next = String(fd.get("newPassword") || "");
    if (next !== String(fd.get("confirmPassword") || "")) {
      notify("两次输入的新密码不一致", "error");
      return;
    }
    try {
      await api("/auth/password", {
        method: "PUT",
        body: JSON.stringify({
          currentPassword: fd.get("currentPassword"),
          newPassword: next,
        }),
      });
      form.reset();
      notify("登录密码已修改，其他会话已退出");
    } catch (error) {
      notify(message(error), "error");
    }
  };
  return (
    <form onSubmit={submit}>
      <SectionHead eyebrow="ACCOUNT SECURITY" title="修改登录密码" />
      <label>
        当前密码
        <input
          name="currentPassword"
          type="password"
          minLength={8}
          required
          autoComplete="current-password"
        />
      </label>
      <label>
        新密码
        <input
          name="newPassword"
          type="password"
          minLength={10}
          required
          autoComplete="new-password"
        />
      </label>
      <label>
        确认新密码
        <input
          name="confirmPassword"
          type="password"
          minLength={10}
          required
          autoComplete="new-password"
        />
      </label>
      <Submit text="修改密码" />
    </form>
  );
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes)) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

function numberText(value: number) {
  return Number(value || 0).toLocaleString("zh-CN");
}
function dateText(value: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Theme theme="g10">
      <App />
    </Theme>
  </React.StrictMode>,
);
