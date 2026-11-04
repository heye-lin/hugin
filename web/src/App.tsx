import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Card,
  Col,
  Empty,
  Layout,
  Menu,
  Row,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableProps } from 'antd';
import {
  CloudServerOutlined,
  DashboardOutlined,
  HistoryOutlined,
  ReloadOutlined,
  TeamOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import { fetchState } from './api';
import type { ConsoleState, QueueItem, RunInfo, Task, WorkerInfo } from './types';

const { Header, Sider, Content } = Layout;

const POLL_MS = 3000;
const LANGUAGE = 'zh-CN';

const MENU_ITEMS = [
  { key: 'overview', icon: <DashboardOutlined />, label: '概览' },
  { key: 'tasks', icon: <UnorderedListOutlined />, label: '任务' },
  { key: 'sessions', icon: <TeamOutlined />, label: '后台会话' },
  { key: 'runs', icon: <HistoryOutlined />, label: '运行记录' },
];

const STAGE_LABELS: Record<string, string> = {
  attention: '需处理',
  failed: '失败',
  blocked: '阻塞',
  review: '待审',
  complete: '完成',
  working: '进行中',
  queued: '排队',
};

const STAGE_COLORS: Record<string, string> = {
  attention: 'red',
  failed: 'volcano',
  blocked: 'gold',
  review: 'blue',
  complete: 'green',
  working: 'processing',
  queued: 'default',
};

const TASK_STATUS_LABELS: Record<string, string> = {
  pending: '待派发',
  dispatched: '已派发',
  working: '进行中',
  review: '待审',
  blocked: '阻塞',
  failed: '失败',
  complete: '完成',
  completed: '完成',
  unknown: '未知',
};

const WORKER_STATE_LABELS: Record<string, string> = {
  working: '进行中',
  blocked: '阻塞',
  failed: '失败',
  done: '已完成',
  stopped: '已停止',
  idle: '空闲',
  queued: '排队',
  unknown: '未知',
};

const RUN_STATUS_LABELS: Record<string, string> = {
  active: '进行中',
  complete: '已完成',
  completed: '已完成',
  blocked: '阻塞',
  failed: '失败',
  archived: '已归档',
};

const HANDOFF_STATUS_LABELS: Record<string, string> = {
  complete: '已完成',
  blocked: '阻塞',
  incomplete: '未完成',
  pending: '进行中',
};

const VERDICT_LABELS: Record<string, string> = {
  PASS: '通过',
  BLOCK: '阻断',
  INCOMPLETE: '未完成',
};

function stageLabel(key: string | undefined): string {
  if (!key) return '未知';
  return STAGE_LABELS[key] ?? key;
}

function stageColor(key: string | undefined): string {
  if (!key) return 'default';
  return STAGE_COLORS[key] ?? 'default';
}

function taskStatusLabel(status: string | undefined): string {
  if (!status) return '未知';
  return TASK_STATUS_LABELS[status] ?? status;
}

function workerStateLabel(state: string | undefined): string {
  if (!state) return '未知';
  return WORKER_STATE_LABELS[state] ?? state;
}

function runStatusLabel(status: string | null | undefined): string {
  if (!status) return '未知';
  return RUN_STATUS_LABELS[status] ?? status;
}

/** 把后端 evidenceLabel（英文短语）转成中文展示，未识别的原样保留。 */
function evidenceText(task: Task): string {
  const raw = task.evidenceLabel ?? '';
  if (!raw) return '无证据';
  if (raw === 'handoff missing') return '缺少 handoff';
  const match = /^handoff (\S+?)(?: · verdict (\S+))?$/.exec(raw);
  if (!match) return raw;
  const status = HANDOFF_STATUS_LABELS[match[1]] ?? match[1];
  const verdict = match[2] ? ` · 验收 ${VERDICT_LABELS[match[2]] ?? match[2]}` : '';
  return `handoff ${status}${verdict}`;
}

function joinDeps(deps: string[] | undefined): string {
  return deps && deps.length > 0 ? deps.join('、') : '—';
}

function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function formatClock(date: Date | null): string {
  if (!date) return '—';
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

const EMPTY_TEXT = <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />;

const PAGINATION = {
  pageSize: 10,
  hideOnSinglePage: true,
  showSizeChanger: false,
  showTotal: (total: number) => `共 ${total} 条`,
};

export default function App() {
  const [view, setView] = useState('overview');
  const [data, setData] = useState<ConsoleState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [firstLoad, setFirstLoad] = useState(true);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    // Aborts on unmount so a slow response can never write into an unmounted
    // tree; the same signal marks the poller as cancelled.
    const controller = new AbortController();

    async function load(): Promise<void> {
      // A slow request must not stack up: skip this tick and try again on the
      // next 3-second beat.
      if (inFlight || controller.signal.aborted) return;
      inFlight = true;
      try {
        const next = await fetchState();
        if (!active || controller.signal.aborted) return;
        setData(next);
        setError(null);
        setRefreshedAt(new Date());
      } catch (failure) {
        if (!active || controller.signal.aborted) return;
        setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        inFlight = false;
        if (active && !controller.signal.aborted) setFirstLoad(false);
      }
    }

    void load();
    const timer = window.setInterval(() => {
      void load();
    }, POLL_MS);

    return () => {
      active = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);

  const summary = data?.summary;
  const tasks = data?.tasks ?? [];
  const queue = data?.queue ?? [];
  const workers = data?.workers ?? [];
  const runs = data?.runs ?? [];
  const currentRun = data?.run ?? null;

  return (
    <Layout className="hugin-layout">
      <Sider className="hugin-sider" width={208} breakpoint="lg" collapsedWidth={0}>
        <div className="hugin-brand">
          <CloudServerOutlined />
          <span>Hugin</span>
        </div>
        <Menu
          mode="inline"
          theme="dark"
          selectedKeys={[view]}
          items={MENU_ITEMS}
          onClick={({ key }) => setView(key)}
        />
      </Sider>
      <Layout>
        <Header className="hugin-header">
          <Space direction="vertical" size={0}>
            <Typography.Text strong style={{ fontSize: 16 }}>
              控制台
            </Typography.Text>
            <Typography.Text className="hugin-muted" style={{ fontSize: 12 }}>
              只读视图 · 每 {POLL_MS / 1000} 秒自动刷新
            </Typography.Text>
          </Space>
          <div className="hugin-header-meta">
            <span>
              <span className="hugin-header-label">当前运行</span>
              {currentRun?.id ?? '—'}
            </span>
            <span>
              <span className="hugin-header-label">运行状态</span>
              {currentRun ? runStatusLabel(currentRun.status) : '—'}
            </span>
            <span>
              <span className="hugin-header-label">语言</span>
              {LANGUAGE}
            </span>
            <span>
              <span className="hugin-header-label">控制台</span>
              <Badge status={error ? 'error' : 'success'} text={error ? '离线' : '在线'} />
            </span>
            <span>
              <Space size={4}>
                <ReloadOutlined />
                <span className="hugin-header-label">最近刷新</span>
                {formatClock(refreshedAt)}
              </Space>
            </span>
          </div>
        </Header>
        <Content className="hugin-content">
          {error ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message="无法连接控制台服务，正在重试…"
              description={error}
            />
          ) : null}
          {firstLoad && !data ? (
            <div style={{ padding: 80, textAlign: 'center' }}>
              <Spin size="large" tip="正在加载控制台数据…">
                <div style={{ height: 80 }} />
              </Spin>
            </div>
          ) : (
            <>
              {view === 'overview' ? (
                <OverviewView summary={summary} queue={queue} />
              ) : null}
              {view === 'tasks' ? <TasksView tasks={tasks} /> : null}
              {view === 'sessions' ? <SessionsView workers={workers} /> : null}
              {view === 'runs' ? <RunsView runs={runs} currentRunId={currentRun?.id ?? null} /> : null}
            </>
          )}
        </Content>
      </Layout>
    </Layout>
  );
}

function OverviewView({
  summary,
  queue,
}: {
  summary: ConsoleState['summary'] | undefined;
  queue: QueueItem[];
}) {
  const counts = summary ?? { running: 0, queued: 0, review: 0, blocked: 0, complete: 0 };
  const cards: { key: keyof typeof counts; title: string; color: string }[] = [
    { key: 'running', title: '运行中', color: '#1677ff' },
    { key: 'queued', title: '队列', color: '#722ed1' },
    { key: 'review', title: '待审', color: '#fa8c16' },
    { key: 'blocked', title: '阻塞', color: '#faad14' },
    { key: 'complete', title: '完成', color: '#52c41a' },
  ];

  const queueColumns: TableProps<QueueItem>['columns'] = [
    { title: '任务', dataIndex: 'id', key: 'id', width: 120 },
    { title: '标题', dataIndex: 'title', key: 'title' },
    { title: '负责人', dataIndex: 'owner', key: 'owner', width: 160 },
    {
      title: '依赖',
      dataIndex: 'deps',
      key: 'deps',
      width: 200,
      render: (deps: string[]) => joinDeps(deps),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={[16, 16]}>
        {cards.map((card) => (
          <Col key={card.key} xs={24} sm={12} md={8} xl={4}>
            <Card className="hugin-summary-card" size="small">
              <Statistic
                title={card.title}
                value={counts[card.key]}
                valueStyle={{ color: card.color }}
              />
            </Card>
          </Col>
        ))}
      </Row>
      <Card title="就绪队列" size="small">
        <Table<QueueItem>
          rowKey="id"
          size="small"
          columns={queueColumns}
          dataSource={queue}
          pagination={false}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无就绪任务" /> }}
        />
      </Card>
    </Space>
  );
}

function TasksView({ tasks }: { tasks: Task[] }) {
  const columns: TableProps<Task>['columns'] = [
    { title: '任务', dataIndex: 'id', key: 'id', width: 90 },
    { title: '标题', dataIndex: 'title', key: 'title', width: 280, ellipsis: true },
    { title: '负责人', dataIndex: 'owner', key: 'owner', width: 110 },
    {
      title: '阶段',
      dataIndex: ['stage', 'key'],
      key: 'stage',
      width: 100,
      render: (key: string) => <Tag color={stageColor(key)}>{stageLabel(key)}</Tag>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: string) => taskStatusLabel(status),
    },
    {
      title: '依赖',
      dataIndex: 'deps',
      key: 'deps',
      width: 140,
      render: (deps: string[]) => joinDeps(deps),
    },
    {
      title: '工作会话',
      key: 'worker',
      width: 240,
      ellipsis: true,
      render: (_value, task) => task.worker?.name ?? task.worker?.id ?? '—',
    },
    {
      title: '证据',
      dataIndex: 'evidenceLabel',
      key: 'evidence',
      width: 180,
      render: (_value, task) => evidenceText(task),
    },
    {
      title: '等待原因',
      key: 'waitingFor',
      width: 200,
      ellipsis: true,
      render: (_value, task) => task.worker?.waitingFor || '—',
    },
  ];

  return (
    <Card size="small">
      <Table<Task>
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={tasks}
        pagination={PAGINATION}
        scroll={{ x: 1480 }}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无任务" /> }}
      />
    </Card>
  );
}

function SessionsView({ workers }: { workers: WorkerInfo[] }) {
  const columns: TableProps<WorkerInfo>['columns'] = [
    { title: 'ID', key: 'id', width: 140, render: (_value, worker) => worker.id ?? '—' },
    { title: '名称', key: 'name', ellipsis: true, render: (_value, worker) => worker.name ?? '—' },
    {
      title: '状态',
      key: 'state',
      width: 120,
      render: (_value, worker) => workerStateLabel(worker.state),
    },
    {
      title: '等待原因',
      key: 'waitingFor',
      ellipsis: true,
      render: (_value, worker) => worker.waitingFor || '—',
    },
  ];

  return (
    <Card size="small">
      <Table<WorkerInfo>
        rowKey={(worker) => worker.id ?? worker.name ?? ''}
        size="small"
        columns={columns}
        dataSource={workers}
        pagination={PAGINATION}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无后台会话" /> }}
      />
    </Card>
  );
}

function RunsView({ runs, currentRunId }: { runs: RunInfo[]; currentRunId: string | null }) {
  const columns: TableProps<RunInfo>['columns'] = [
    {
      title: '运行',
      dataIndex: 'id',
      key: 'id',
      render: (id: string) => (
        <Space size={4}>
          <span>{id}</span>
          {id === currentRunId ? <Tag color="blue">当前</Tag> : null}
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (status: string | null) => runStatusLabel(status),
    },
    {
      title: 'base',
      dataIndex: 'base',
      key: 'base',
      width: 140,
      render: (base: string | null) => base || '—',
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 200,
      render: (createdAt: string | null) => formatTime(createdAt),
    },
  ];

  return (
    <Card size="small">
      <Table<RunInfo>
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={runs}
        pagination={PAGINATION}
        rowClassName={(record) => (record.id === currentRunId ? 'hugin-run-current' : '')}
        locale={{ emptyText: EMPTY_TEXT }}
      />
    </Card>
  );
}
