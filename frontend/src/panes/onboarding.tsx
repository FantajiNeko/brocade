import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  applyDraft,
  checkpointOnboarding,
  completeOnboarding,
  fetchDeployment,
  fetchDeployments,
  fetchNodes,
  fetchOnboarding,
  type OnboardingState,
} from '../api';
import { draft, type DraftEntry } from '../draft';
import { navigate } from '../forge/route';
import { useForge } from '../forge/state';
import { useSession } from '../session';
import { useAgentLiveness } from '../ui/agent-alive';
import { ErrorBox, Loading } from '../ui/bits';
import { DialogClose, DialogLayer } from '../ui/dialog';
import { isValidSlug } from './ports';
import { SubscriptionViewer } from './subscription';

interface CreatedModel {
  appId: string;
  chainId: string;
  ingressId: string;
}

interface ModelReceipt extends CreatedModel {
  tenantId: string;
  userId: string;
  revisionId: number;
}

type GuidePhase = 'machine' | 'agent' | 'chain' | 'user' | 'publish' | 'activate' | 'verify' | 'complete';

const STEP_LABELS = ['机器', '线路', '用户', '发布', '拨测'];

let reopenVersion = 0;
const reopenListeners = new Set<() => void>();

/** Reopen the current first-run prompt from the account menu without turning it into a route. */
export function openOnboardingGuide() {
  reopenVersion += 1;
  for (const listener of reopenListeners) listener();
}

const subscribeReopen = (listener: () => void) => {
  reopenListeners.add(listener);
  return () => reopenListeners.delete(listener);
};
const reopenSnapshot = () => reopenVersion;

function pendingCreatedModel(entries: readonly DraftEntry[]): CreatedModel | null {
  let found: CreatedModel | null = null;
  for (const entry of entries) {
    if (entry.op.op !== 'create_ingress') continue;
    found = {
      appId: entry.op.app_id,
      chainId: entry.op.ingress.chain_id,
      ingressId: entry.op.ingress.id,
    };
  }
  return found;
}

function receiptKey(operatorId: string) {
  return `brocade.first-run.model-receipt.${operatorId}`;
}

function readReceipt(operatorId: string): ModelReceipt | null {
  try {
    const raw = localStorage.getItem(receiptKey(operatorId));
    return raw ? (JSON.parse(raw) as ModelReceipt) : null;
  } catch {
    return null;
  }
}

function phaseStep(phase: GuidePhase): number {
  if (phase === 'machine' || phase === 'agent') return 0;
  if (phase === 'chain') return 1;
  if (phase === 'user') return 2;
  if (phase === 'publish' || phase === 'activate') return 3;
  return 4;
}

function GuideSurface({
  phase,
  title,
  children,
  actions,
}: {
  phase: GuidePhase;
  title: string;
  children: ReactNode;
  actions: ReactNode;
}) {
  const current = phaseStep(phase);
  return (
    <section className="dialog-surface onb-guide">
      <header className="onb-guide-head">
        <span className="eyebrow">首次上线 · {phase === 'complete' ? '已完成' : `第 ${current + 1} 步`}</span>
        <ol className="onb-guide-progress" aria-label="首次上线进度">
          {STEP_LABELS.map((label, index) => (
            <li
              key={label}
              className={index < current || phase === 'complete' ? 'done' : index === current ? 'current' : ''}
            >
              <span aria-hidden="true">{index < current || phase === 'complete' ? '✓' : index + 1}</span>
              {label}
            </li>
          ))}
        </ol>
        <h2>{title}</h2>
      </header>
      <div className="onb-guide-body">{children}</div>
      <footer className="onb-guide-actions">{actions}</footer>
    </section>
  );
}

export function OnboardingGuide() {
  const qc = useQueryClient();
  const { initial, who } = useSession();
  const { nav } = useForge();
  const entries = useSyncExternalStore(draft.subscribe, draft.snapshot);
  const reopen = useSyncExternalStore(subscribeReopen, reopenSnapshot, reopenSnapshot);
  const seenReopen = useRef(reopen);
  const [dismissed, setDismissed] = useState<GuidePhase | 'error' | null>(() =>
    initial.onboarding === 'complete' ? 'complete' : null,
  );
  const [receipt, setReceipt] = useState<ModelReceipt | null>(() => readReceipt(who.operator_id));
  const [viewer, setViewer] = useState(false);
  const [blocking, setBlocking] = useState(false);

  useEffect(() => {
    if (seenReopen.current === reopen) return;
    seenReopen.current = reopen;
    setDismissed(null);
  }, [reopen]);

  const onboarding = useQuery({
    queryKey: ['onboarding'],
    queryFn: fetchOnboarding,
    refetchInterval: query => (query.state.data?.status === 'active' ? 5_000 : false),
  });
  const state = onboarding.data;
  const nodes = useQuery({
    queryKey: ['nodes'],
    queryFn: () => fetchNodes(),
    enabled: state?.status === 'active',
    refetchInterval: state?.status === 'active' ? 3_000 : false,
  });
  const rootNodes = (nodes.data?.nodes ?? []).filter(node => node.tenant_id === state?.root_tenant_id);
  const node = (nodes.data?.nodes ?? []).find(item => item.node_id === state?.node_id);
  const liveness = useAgentLiveness(node);

  const checkpointNode = useMutation({
    mutationFn: (nodeId: string) => checkpointOnboarding({ step: 'node', node_id: nodeId }),
    onSuccess: value => qc.setQueryData(['onboarding'], value),
  });
  const autoNode = useRef<string | null>(null);
  useEffect(() => {
    if (state?.status !== 'active' || state.node_id || rootNodes.length !== 1) return;
    const nodeId = rootNodes[0].node_id;
    if (autoNode.current === nodeId) return;
    autoNode.current = nodeId;
    checkpointNode.mutate(nodeId);
  }, [checkpointNode, rootNodes, state?.node_id, state?.status]);

  const deployments = useQuery({
    queryKey: ['deployments', 'config'],
    queryFn: () => fetchDeployments('config'),
    enabled: state?.status === 'active' && state.target_revision_id != null,
    refetchInterval: state?.status === 'active' && state.target_revision_id != null ? 3_000 : false,
  });
  const matchingDeployment = deployments.data?.deployments.find(
    deployment =>
      deployment.revision_id === state?.target_revision_id &&
      deployment.status !== 'failed' &&
      deployment.status !== 'canceled' &&
      deployment.id !== state?.deployment_id,
  );
  const checkpointDeployment = useMutation({
    mutationFn: (deploymentId: number) => checkpointOnboarding({ step: 'deployment', deployment_id: deploymentId }),
    onSuccess: value => qc.setQueryData(['onboarding'], value),
  });
  const deployment = useQuery({
    queryKey: ['deployment', state?.deployment_id],
    queryFn: () => fetchDeployment(state!.deployment_id!),
    enabled: state?.status === 'active' && state.deployment_id != null,
    refetchInterval: query => (query.state.data?.activation_status === 'activated' ? false : 3_000),
  });
  const selectedDeploymentStopped = deployment.data?.status === 'failed' || deployment.data?.status === 'canceled';
  const autoDeployment = useRef<number | null>(null);
  useEffect(() => {
    if (state?.status !== 'active' || state.target_revision_id == null) return;
    if (state.deployment_id != null && !selectedDeploymentStopped) return;
    if (!matchingDeployment || autoDeployment.current === matchingDeployment.id) return;
    autoDeployment.current = matchingDeployment.id;
    checkpointDeployment.mutate(matchingDeployment.id);
  }, [
    checkpointDeployment,
    matchingDeployment,
    selectedDeploymentStopped,
    state?.deployment_id,
    state?.status,
    state?.target_revision_id,
  ]);

  const complete = useMutation({
    mutationFn: ({ probeId, itemId }: { probeId: string; itemId: string }) => completeOnboarding(probeId, itemId),
    onSuccess: value => {
      setViewer(false);
      qc.setQueryData(['onboarding'], value);
    },
  });

  if (onboarding.isPending) return null;
  if (onboarding.error) {
    if (dismissed === 'error') return null;
    return (
      <DialogLayer label="入门向导读取失败" onClose={() => setDismissed('error')}>
        <section className="dialog-surface onb-guide onb-guide-error">
          <header className="onb-guide-head">
            <span className="eyebrow">首次上线</span>
            <h2>无法读取当前进度</h2>
          </header>
          <div className="onb-guide-body">
            <ErrorBox error={onboarding.error} />
          </div>
          <footer className="onb-guide-actions">
            <DialogClose className="btn">稍后再试</DialogClose>
            <button className="btn primary" onClick={() => void onboarding.refetch()}>
              重新读取
            </button>
          </footer>
        </section>
      </DialogLayer>
    );
  }
  if (!state || state.status === 'not-applicable') return null;

  const created = pendingCreatedModel(entries);
  const phase: GuidePhase =
    state.status === 'complete'
      ? 'complete'
      : !state.node_id
        ? 'machine'
        : liveness?.state !== 'online'
          ? 'agent'
          : state.target_revision_id == null
            ? created || receipt
              ? 'user'
              : 'chain'
            : state.deployment_id == null
              ? 'publish'
              : deployment.data?.activation_status === 'activated'
                ? 'verify'
                : 'activate';

  if (dismissed === phase) return null;

  const close = () => setDismissed(phase);
  const canClose = () =>
    !blocking && !complete.isPending && !checkpointNode.isPending && !checkpointDeployment.isPending;
  let title: string;
  let body: ReactNode;
  let actions: ReactNode;

  if (phase === 'machine') {
    title = rootNodes.length > 1 ? '选择第一台机器' : '先纳管第一台机器';
    body = nodes.error ? (
      <ErrorBox error={nodes.error} />
    ) : checkpointNode.error ? (
      <>
        <p>检测到机器，但暂时无法把它写入首次上线检查点。机器本身不会被重复创建。</p>
        <ErrorBox error={checkpointNode.error} />
      </>
    ) : checkpointNode.isPending || rootNodes.length === 1 ? (
      <>
        <p>检测到刚创建的机器，正在把它记为首次上线目标。这个检查点只保存机器引用，不会改写配置。</p>
        <Loading variant="form" />
      </>
    ) : rootNodes.length > 1 ? (
      <>
        <p>检测到多台尚未记入向导的机器。请选择本次要继续上线的第一台机器。</p>
        <div className="onb-guide-picks">
          {rootNodes.map(item => (
            <button className="btn" key={item.node_id} onClick={() => checkpointNode.mutate(item.node_id)}>
              <b>{item.name || item.node_id}</b>
              <span className="mono">{item.node_id}</span>
            </button>
          ))}
        </div>
      </>
    ) : (
      <>
        <p>向导会带你进入现有的机器页面。填写网络信息、生成安装命令，并在目标机器上启动 Agent。</p>
        <p className="onb-guide-note">关闭提示不会丢失进度；可随时从账户菜单重新打开。</p>
      </>
    );
    actions = (
      <>
        <DialogClose className="btn">稍后</DialogClose>
        {rootNodes.length === 0 && !nodes.error && (
          <DialogClose className="btn primary" onClick={() => navigate('nodes', { p: 'provision', step: 1 })}>
            下一步 · 纳管机器
          </DialogClose>
        )}
        {rootNodes.length === 1 && checkpointNode.error && (
          <button className="btn primary" onClick={() => checkpointNode.mutate(rootNodes[0].node_id)}>
            重试记录机器
          </button>
        )}
      </>
    );
  } else if (phase === 'agent') {
    title = '安装 Agent，等待机器上线';
    body = (
      <>
        <p>
          机器 <b>{node?.name || state.node_id}</b> 已登记。进入安装页复制一次性命令，在目标机器以系统权限执行。
        </p>
        <p className="onb-guide-note">首次心跳到达后，向导会自动提示创建线路。</p>
        {checkpointNode.error && <ErrorBox error={checkpointNode.error} />}
      </>
    );
    actions = (
      <>
        <DialogClose className="btn">稍后</DialogClose>
        <DialogClose
          className="btn primary"
          onClick={() => navigate('nodes', { p: 'install', node: state.node_id!, step: 2 })}
        >
          查看安装步骤
        </DialogClose>
      </>
    );
  } else if (phase === 'chain') {
    title = '机器在线，创建第一条线路';
    body = (
      <>
        <p>首台机器已经连接控制台。下一步进入建链页面，选择接入协议并把线路加入草稿。</p>
        <p className="onb-guide-note">线路暂存在浏览器草稿中；创建首个用户时会与授权一起提交为一个修订。</p>
      </>
    );
    actions = (
      <>
        <DialogClose className="btn">稍后</DialogClose>
        <DialogClose className="btn primary" onClick={() => navigate('nodes', { p: 'chain', id: state.node_id! })}>
          下一步 · 创建线路
        </DialogClose>
      </>
    );
  } else if (phase === 'user') {
    title = nav === 'users' ? '创建第一个用户' : '线路已准备，继续创建用户';
    body =
      nav === 'users' ? (
        <FirstUserForm
          state={state}
          created={created ?? receipt!}
          initialReceipt={receipt}
          onBusyChange={setBlocking}
          onReceipt={setReceipt}
          onCommitted={value => {
            setReceipt(null);
            qc.setQueryData(['onboarding'], value);
          }}
        />
      ) : (
        <>
          <p>线路已经加入草稿。下一步会切到用户页面，并在弹层中创建第一个用户和这条线路的授权。</p>
          <p className="onb-guide-note">用户、线路和授权会作为同一个不可变修订提交，不会留下半成品。</p>
        </>
      );
    actions =
      nav === 'users' ? null : (
        <>
          <DialogClose className="btn">稍后</DialogClose>
          <button className="btn primary" onClick={() => navigate('users')}>
            下一步 · 前往用户页面
          </button>
        </>
      );
  } else if (phase === 'publish') {
    title = nav === 'deploy' ? '在发布页创建变更单' : '用户和线路已提交，准备发布';
    body =
      deployments.error || checkpointDeployment.error ? (
        <ErrorBox error={deployments.error ?? checkpointDeployment.error} />
      ) : checkpointDeployment.isPending || matchingDeployment ? (
        <>
          <p>检测到修订 {state.target_revision_id} 的配置变更单，正在关联首次上线进度。</p>
          <Loading variant="form" />
        </>
      ) : nav === 'deploy' ? (
        <>
          <p>关闭提示后，在发布计划中核对目标机器和变更内容，然后创建配置变更单。</p>
          <p className="onb-guide-note">变更单创建后，向导会自动记录并继续跟踪上线状态。</p>
        </>
      ) : (
        <p>修订 {state.target_revision_id} 已就绪。下一步切到发布计划，确认首台机器的配置变更。</p>
      );
    actions = (
      <>
        <DialogClose className="btn">稍后</DialogClose>
        {!matchingDeployment &&
          !deployments.error &&
          (nav === 'deploy' ? (
            <DialogClose className="btn primary">开始核对发布计划</DialogClose>
          ) : (
            <button
              className="btn primary"
              onClick={() => navigate('deploy', { p: 'plan', revision: state.target_revision_id })}
            >
              下一步 · 前往发布
            </button>
          ))}
        {matchingDeployment && checkpointDeployment.error && (
          <button className="btn primary" onClick={() => checkpointDeployment.mutate(matchingDeployment.id)}>
            重试关联变更单
          </button>
        )}
      </>
    );
  } else if (phase === 'activate') {
    const failed = deployment.data?.status === 'failed' || deployment.data?.status === 'canceled';
    title = failed ? '本次发布没有完成' : '配置正在上线';
    body = deployment.error ? (
      <ErrorBox error={deployment.error} />
    ) : (
      <>
        <p>
          变更单 #{state.deployment_id}{' '}
          {failed ? '已停止，需要重新创建同一修订的变更单。' : '正在让首台机器收敛到新配置。'}
        </p>
        {!failed && <p className="onb-guide-note">配置成为 Serving 后会自动进入节点地址与拨测步骤。</p>}
      </>
    );
    actions = (
      <>
        <DialogClose className="btn">稍后</DialogClose>
        <DialogClose
          className="btn primary"
          onClick={() =>
            failed
              ? navigate('deploy', { p: 'plan', revision: state.target_revision_id })
              : navigate('deploy', { p: 'detail', id: state.deployment_id })
          }
        >
          {failed ? '重新打开发布计划' : '查看变更单'}
        </DialogClose>
      </>
    );
  } else if (phase === 'verify') {
    title = nav === 'users' ? '查看节点地址并完成拨测' : '配置已上线，最后验证一次';
    body = (
      <>
        <p>使用刚创建用户的真实授权打开节点地址，任选一个实际入口拨测成功后，首次上线才会完成。</p>
        {complete.error && <ErrorBox error={complete.error} />}
      </>
    );
    actions = (
      <>
        <DialogClose className="btn" disabled={complete.isPending}>
          稍后
        </DialogClose>
        {nav === 'users' ? (
          <button className="btn primary" disabled={complete.isPending} onClick={() => setViewer(true)}>
            {complete.isPending ? '确认拨测证据…' : '打开节点地址与拨测'}
          </button>
        ) : (
          <button className="btn primary" onClick={() => navigate('users', { p: 'user', id: state.user_id! })}>
            下一步 · 前往用户页面
          </button>
        )}
      </>
    );
  } else {
    title = '第一条线路已经可用';
    body = <p>机器、线路、用户、配置和权限均已收敛，并已用真实用户凭据完成一次端到端拨测。</p>;
    actions = (
      <>
        <DialogClose className="btn" onClick={() => navigate('users')}>
          查看用户
        </DialogClose>
        <DialogClose className="btn primary" onClick={() => navigate('nodes')}>
          进入控制台
        </DialogClose>
      </>
    );
  }

  return (
    <>
      <DialogLayer label={title} onClose={close} canClose={canClose}>
        <GuideSurface phase={phase} title={title} actions={actions}>
          {body}
        </GuideSurface>
      </DialogLayer>
      {viewer && state.user_tenant_id && state.user_id && (
        <SubscriptionViewer
          tenant={state.user_tenant_id}
          user={state.user_id}
          kind="uri"
          onProbePassed={result => complete.mutate(result)}
          onClose={() => setViewer(false)}
        />
      )}
    </>
  );
}

function FirstUserForm({
  state,
  created,
  initialReceipt,
  onBusyChange,
  onReceipt,
  onCommitted,
}: {
  state: OnboardingState;
  created: CreatedModel;
  initialReceipt: ModelReceipt | null;
  onBusyChange: (busy: boolean) => void;
  onReceipt: (value: ModelReceipt) => void;
  onCommitted: (value: OnboardingState) => void;
}) {
  const { who } = useSession();
  const qc = useQueryClient();
  const [userId, setUserId] = useState(initialReceipt?.userId ?? '');
  const tenantId = state.root_tenant_id ?? '';
  const commit = useMutation({
    mutationFn: async () => {
      let receipt = initialReceipt;
      if (!receipt) {
        draft.push({ op: 'create_user', user: { tenant_id: tenantId, id: userId.trim() } });
        draft.push({
          op: 'upsert_grant',
          grant: {
            app_id: created.appId,
            tenant_id: tenantId,
            user_id: userId.trim(),
            ingress_id: created.ingressId,
            enabled: true,
          },
        });
        const batch = draft.beginSubmission();
        let succeeded = false;
        try {
          const result = await applyDraft(
            batch.entries.map(entry => entry.op),
            '首次上线：创建第一条链与第一个用户',
          );
          succeeded = true;
          receipt = {
            ...created,
            tenantId,
            userId: userId.trim(),
            revisionId: result.revision_id,
          };
          onReceipt(receipt);
          try {
            localStorage.setItem(receiptKey(who.operator_id), JSON.stringify(receipt));
          } catch {
            // The current tab can still finish; storage only provides crash recovery.
          }
        } finally {
          draft.finishSubmission(batch, succeeded);
        }
      }
      const checked = await checkpointOnboarding({
        step: 'model',
        app_id: receipt.appId,
        chain_id: receipt.chainId,
        ingress_id: receipt.ingressId,
        user_tenant_id: receipt.tenantId,
        user_id: receipt.userId,
        target_revision_id: receipt.revisionId,
      });
      try {
        localStorage.removeItem(receiptKey(who.operator_id));
      } catch {
        // A stale receipt is ignored after the server checkpoint exists.
      }
      return checked;
    },
    onSuccess: value => {
      void qc.invalidateQueries({ queryKey: ['snapshot'] });
      void qc.invalidateQueries({ queryKey: ['users'] });
      void qc.invalidateQueries({ queryKey: ['revisions'] });
      onCommitted(value);
    },
  });
  useEffect(() => {
    onBusyChange(commit.isPending);
    return () => onBusyChange(false);
  }, [commit.isPending, onBusyChange]);

  const valid = !!tenantId && isValidSlug(userId.trim());
  return (
    <form
      className="onb-guide-user"
      onSubmit={event => {
        event.preventDefault();
        if (valid && !commit.isPending) commit.mutate();
      }}
    >
      <p>这个名称会出现在用量、在线状态和授权记录中。线路、用户和授权会在同一个修订里提交。</p>
      <label className="onb-guide-field">
        <span>用户 ID</span>
        <input
          className="f mono"
          value={userId}
          autoFocus={!initialReceipt}
          disabled={!!initialReceipt || commit.isPending}
          placeholder="alice"
          onChange={event => setUserId(event.target.value)}
        />
        <small>{userId && !valid ? '只能使用 a-z 0-9 . _ -，最长 32 个字符。' : `归属 ${tenantId}`}</small>
      </label>
      {initialReceipt && <div className="callout warn">修订已经写入；继续会安全地重试服务端检查点。</div>}
      {commit.error && <ErrorBox error={commit.error} />}
      <div className="onb-guide-inline-actions">
        <button className="btn primary" type="submit" disabled={!valid || commit.isPending}>
          {commit.isPending ? '提交并确认中…' : initialReceipt ? '重试确认' : '创建用户并提交'}
        </button>
      </div>
    </form>
  );
}
