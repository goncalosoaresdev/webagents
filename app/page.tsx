import { TerminalPanel } from '@/components/terminal/terminal-panel';
import { DeviceIndicator } from '@/components/workspace/device-indicator';
import { ProjectSwitcher } from '@/components/workspace/project-switcher';
import { ProviderSettings } from '@/components/settings/provider-settings';

import { ConversationNavigator } from '@/components/conversation/conversation-navigator';
import { conversationStops } from '@/lib/workspace/conversation-navigation';

import { ContextWindow } from '@/components/conversation/context-window';
import { UsageLimits } from '@/components/conversation/usage-limits';

import { AttachmentPicker } from '@/components/conversation/attachment-picker';
import { UserMessage } from '@/components/conversation/user-message';
import type { Attachment } from '@/lib/workspace/contracts';

import { ModelControls } from '@/components/conversation/model-controls';
import { TaskHandoff } from '@/components/conversation/task-handoff';
import { handoffBriefing } from '@/lib/workspace/handoff';
import { buildTurnTimeline } from '@/lib/workspace/timeline';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  Check,
  Circle,
  TerminalSquare,
  ArrowLeft,
  ChevronDown,
  FolderGit2,
  FolderPlus,
  GitBranch,
  GitFork,
  LayoutPanelLeft,
  PanelLeftClose,
  Link2,
  Plus,
  Paperclip,
  Play,
  Loader2,
  Search,
  Settings2,
  Square,
  SquarePen,
  Trash2,
  X,
} from 'lucide-react';
import { ProviderLogo } from '@/components/provider-logo';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

import { SpeechInput } from '@/components/conversation/speech-input';
import { OrchestrationComposer } from '@/components/conversation/orchestration-composer';
import { OrchestrationSelect } from '@/components/conversation/orchestration-select';
import { orchestrationSchema } from '@/lib/workspace/orchestration';
import {
  bindingMatches,
  loadPushToTalk,
} from '@/lib/speech/push-to-talk';
import type { Orchestration } from '@/lib/workspace/contracts';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { TurnResponse } from '@/components/conversation/turn-response';
import { pollWithRecovery, readTask } from '@/lib/workspace/sync';
import { ApiError, WebcodeApi } from '@/lib/api/client';
import type { ProviderSnapshot } from '@/lib/providers/contracts';
import type {
  ApprovalDecision,
  Project,
  Task,
  TaskDetail,
  TaskEvent,
} from '@/lib/workspace/contracts';

const API_URL = '/api/v1';
const PENDING_SEND_KEY = 'webcode.pending-send.v1';
interface PendingSend {
  taskId: string;
  projectId: string;
  input: {
    orchestration?: Orchestration;
    attachmentIds?: string[];
    clientRequestId: string;
    prompt: string;
    model?: string;
    reasoningEffort?: string;
    permissionMode?: import('../lib/workspace/permissions.ts').PermissionMode;
  };
}

const timeLabel = (value: string) => {
  const delta = Date.now() - Date.parse(value);
  return delta < 60_000
    ? 'Now'
    : delta < 3_600_000
      ? `${Math.floor(delta / 60_000)}m`
      : delta < 86_400_000
        ? `${Math.floor(delta / 3_600_000)}h`
        : new Date(value).toLocaleDateString();
};
const eventText = (event: TaskEvent) =>
  typeof event.data.text === 'string' ? event.data.text : '';
const applyLiveTranscript = (current: string, prev: string, next: string) => {
  let base = current;
  if (prev) {
    if (current.endsWith(prev)) base = current.slice(0, current.length - prev.length);
    else {
      const index = current.lastIndexOf(prev);
      if (index >= 0)
        base = current.slice(0, index) + current.slice(index + prev.length);
    }
    base = base.trimEnd();
  }
  const live = next.trim();
  if (!live) return base;
  return base ? `${base} ${live}` : live;
};
const displayText = (value: unknown, fallback = '') =>
  typeof value === 'string' ? value : fallback;
function Mark() {
  return (
    <div className="workspace-brand" aria-label="WEBAGENTS">
      <span>WEB</span>
      <span>AGENTS</span>
    </div>
  );
}

function conversationTurns(detail: TaskDetail | undefined) {
  if (!detail) return [];
  const eventsByTurn = new Map<string, TaskEvent[]>();
  for (const event of detail.events) {
    if (!event.turnId) continue;
    const events = eventsByTurn.get(event.turnId) ?? [];
    events.push(event);
    eventsByTurn.set(event.turnId, events);
  }
  return detail.turns.map((turn) => {
    const events = eventsByTurn.get(turn.id) ?? [];
    const userMessage = events.find((event) => event.type === 'user.message');
    const runtimeError = events.findLast(
      (event) => event.type === 'runtime.error',
    );
    return {
      turn,
      userText: userMessage ? eventText(userMessage) : turn.prompt,
      sentAt: userMessage?.createdAt ?? turn.createdAt,
      events,
      approvals: detail.approvals.filter(
        (approval) =>
          approval.turnId === turn.id && approval.status === 'pending',
      ),
      error:
        turn.status === 'failed'
          ? (turn.error ??
            displayText(runtimeError?.data.message, 'The agent turn failed.'))
          : '',
    };
  });
}

export default function Home() {
  const [projects, setProjects] = useState<readonly Project[]>([]);
  const [taskSearch, setTaskSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState<string>();
  const [emptyArchivedBusy, setEmptyArchivedBusy] = useState(false);
  const [tasks, setTasks] = useState<readonly Task[]>([]);
  const [providers, setProviders] = useState<readonly ProviderSnapshot[]>([]);
  const [detail, setDetail] = useState<TaskDetail>();
  const [terminalOpen, setTerminalOpen] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const saved = JSON.parse(
          localStorage.getItem('webcode.terminal-panel') ?? 'null',
        ) as { open?: boolean; projectId?: string } | null;
        if (saved?.open && saved.projectId) {
          setProjectId(saved.projectId);
          setTerminalOpen(true);
        }
      } catch {
        /* Browser storage is optional. */
      }
    }, 0);
    return () => clearTimeout(timer);
  }, []);
  function changeTerminalOpen(open: boolean) {
    setTerminalOpen(open);
    if (!open)
      requestAnimationFrame(() =>
        document.getElementById('terminal-toggle')?.focus(),
      );
    try {
      localStorage.setItem(
        'webcode.terminal-panel',
        JSON.stringify({ open, projectId }),
      );
    } catch {
      /* Browser storage is optional. */
    }
  }

  const [projectId, setProjectId] = useState('');
  const [activeTaskId, setActiveTaskId] = useState('');
  const [providerId, setProviderId] = useState('codex');
  const [requestedModel, setModel] = useState('');
  const [permissionMode, setPermissionMode] =
    useState<import('../lib/workspace/permissions.ts').PermissionMode>(
      'workspace',
    );
  const [requestedReasoning, setReasoning] = useState('');
  const [prompt, setPrompt] = useState('');
  const [dictating, setDictating] = useState(false);
  const wasDictating = useRef(false);
  useEffect(() => {
    if (wasDictating.current && !dictating) messageInput.current?.focus();
    wasDictating.current = dictating;
  }, [dictating]);
  const [orchestration, setOrchestration] = useState<Orchestration>();
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [attachmentReset, setAttachmentReset] = useState(0);
  const [projectPath, setProjectPath] = useState('');
  const [error, setError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem('webcode.sidebar-collapsed') === 'true';
    } catch {
      return false;
    }
  });
  function collapseSidebar(collapsed: boolean) {
    setSidebarCollapsed(collapsed);
    if (!collapsed) setSidebarOpen(true);
    try {
      localStorage.setItem('webcode.sidebar-collapsed', String(collapsed));
    } catch {
      /* Browser storage is optional. */
    }
  }
  const [projectDialog, setProjectDialog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [projectSource, setProjectSource] = useState<
    'sources' | 'local' | 'git' | 'github'
  >('sources');
  const [sourceSearch, setSourceSearch] = useState('');
  const [directoryView, setDirectoryView] = useState<{
    path: string;
    parent?: string;
    directories: readonly { name: string; path: string }[];
  }>();
  const navigationStops = useMemo(() => conversationStops(detail), [detail]);
  const api = useMemo(() => new WebcodeApi(API_URL), []);
  const pendingSend = useRef<PendingSend | undefined>(undefined);
  const sending = useRef(false);
  const composerElement = useRef<HTMLDivElement>(null);
  const conversationScroll = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const messageInput = useRef<HTMLTextAreaElement>(null);
  const taskSearchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const composer = composerElement.current;
    const pane = composer?.closest<HTMLElement>('.conversation-pane');
    if (!composer || !pane) return;
    const measure = () =>
      pane.style.setProperty(
        '--composer-height',
        `${composer.getBoundingClientRect().height}px`,
      );
    const observer = new ResizeObserver(measure);
    observer.observe(composer);
    measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const textarea = messageInput.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(180, Math.max(78, textarea.scrollHeight))}px`;
  }, [prompt]);
  useEffect(() => {
    stickToBottom.current = true;
  }, [activeTaskId]);
  useLayoutEffect(() => {
    if (!activeTaskId) return;
    const root =
      conversationScroll.current ??
      composerElement.current?.closest<HTMLElement>('.conversation-pane');
    const viewport = root?.querySelector<HTMLElement>(
      '.conversation-scroll [data-slot="scroll-area-viewport"], [data-slot="scroll-area-viewport"]',
    );
    const content = root?.querySelector<HTMLElement>('.conversation-content');
    if (!viewport || !content) return;
    const stick = () => {
      if (!stickToBottom.current) return;
      viewport.scrollTop = viewport.scrollHeight;
    };
    const onScroll = () => {
      stickToBottom.current =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 96;
    };
    viewport.addEventListener('scroll', onScroll, { passive: true });
    const observer = new ResizeObserver(stick);
    observer.observe(content);
    stick();
    return () => {
      observer.disconnect();
      viewport.removeEventListener('scroll', onScroll);
    };
  }, [activeTaskId, detail?.task.id]);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [authToken, setAuthToken] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [syncVersion, setSyncVersion] = useState(0);
  const detailRef = useRef<TaskDetail | undefined>(undefined);
  const [hasPendingSend, setHasPendingSend] = useState(false);
  function reportConnection(cause: unknown) {
    if (cause instanceof ApiError && cause.status === 401) setNeedsAuth(true);
    else setConnectionError('Connection interrupted. Reconnecting…');
  }
  function acknowledgePending(next: TaskDetail) {
    const pending = pendingSend.current;
    if (
      pending?.taskId === next.task.id &&
      next.turns.some(
        (turn) => turn.clientRequestId === pending.input.clientRequestId,
      )
    ) {
      sessionStorage.removeItem(PENDING_SEND_KEY);
      pendingSend.current = undefined;
      setHasPendingSend(false);
      setAttachmentReset((value) => value + 1);
      setAttachments([]);
      setOrchestration(undefined);
      setPrompt((current) => (current === pending.input.prompt ? '' : current));
    }
  }
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(PENDING_SEND_KEY);
      if (!saved) return;
      const pending = JSON.parse(saved) as PendingSend;
      if (
        typeof pending.taskId !== 'string' ||
        typeof pending.projectId !== 'string' ||
        typeof pending.input?.clientRequestId !== 'string' ||
        typeof pending.input.prompt !== 'string' ||
        (pending.input.orchestration !== undefined &&
          !orchestrationSchema.safeParse(pending.input.orchestration).success)
      )
        return;
      pendingSend.current = pending;
      // oxlint-disable-next-line react/react-compiler -- Restore browser-only session storage after server rendering.
      setHasPendingSend(true);
      setProjectId(pending.projectId);
      setActiveTaskId(pending.taskId);
      setPermissionMode(pending.input.permissionMode ?? 'workspace');
      setPrompt(pending.input.prompt);
      setOrchestration(pending.input.orchestration);
      setModel(pending.input.model ?? '');
      setReasoning(pending.input.reasoningEffort ?? '');
    } catch {
      /* An unavailable draft store must not block reading the workspace. */
    }
  }, []);

  useEffect(() => {
    if (needsAuth) return;
    return pollWithRecovery(
      async (signal) => {
        const [nextProjects, nextProviders] = await Promise.all([
          api.projects(),
          api.providers(),
        ]);
        if (signal.aborted) return 30_000;
        setProjects(nextProjects);
        setProviders(nextProviders);
        setProviderId((current) =>
          nextProviders.some((entry) => entry.providerId === current)
            ? current
            : (nextProviders[0]?.providerId ?? current),
        );
        setProjectId((current) => current || nextProjects[0]?.id || '');
        setInitialLoading(false);
        setConnectionError('');
        return 30_000;
      },
      (cause) => {
        reportConnection(cause);
        setInitialLoading(false);
      },
      window,
    );
  }, [api, reloadVersion, needsAuth]);
  useEffect(() => {
    if (needsAuth) return;
    return pollWithRecovery(
      async (signal) => {
        const next = await api.tasks();
        if (!signal.aborted) setTasks(next);
        return 5_000;
      },
      reportConnection,
      window,
    );
  }, [api, needsAuth, syncVersion]);
  useEffect(() => {
    if (!activeTaskId || needsAuth) return;
    if (detailRef.current?.task.id !== activeTaskId)
      detailRef.current = undefined;
    return pollWithRecovery(
      async (signal) => {
        const next = await readTask(
          api,
          activeTaskId,
          detailRef.current,
          signal,
        );
        if (signal.aborted) return 3_000;
        detailRef.current = next;
        setDetail(next);
        acknowledgePending(next);
        setConnectionError('');
        setTasks((current) =>
          current.map((task) => (task.id === next.task.id ? next.task : task)),
        );
        return next.task.status === 'running' ? 800 : 3_000;
      },
      reportConnection,
      window,
    );
  }, [api, activeTaskId, needsAuth, syncVersion]);

  const activeProvider =
    providers.find((entry) => entry.providerId === providerId) ?? providers[0];
  const modelOptions = activeProvider?.models ?? [];
  const model =
    modelOptions.find((entry) => entry.id === requestedModel)?.id ??
    modelOptions.find((entry) => entry.isDefault)?.id ??
    modelOptions[0]?.id ??
    '';
  const effortCapability = modelOptions
    .find((entry) => entry.id === model)
    ?.capabilities.find((entry) => entry.id === 'reasoningEffort');
  const reasoning =
    effortCapability?.values.find((entry) => entry.id === requestedReasoning)
      ?.id ??
    effortCapability?.defaultValue ??
    effortCapability?.values[0]?.id ??
    '';
  const activeProject = projects.find((entry) => entry.id === projectId);
  const activeTask =
    detail?.task ?? tasks.find((entry) => entry.id === activeTaskId);

  const workerProvider = providers.find(
    (entry) => entry.providerId === orchestration?.worker.providerId,
  );
  const workerModel = workerProvider?.models.find(
    (entry) => entry.id === orchestration?.worker.model,
  );
  const orchestrationUnavailable = Boolean(
    orchestration &&
    (activeProvider?.health !== 'ready' ||
      workerProvider?.health !== 'ready' ||
      !workerModel),
  );
  const incompatibleImages =
    attachments.some((a) => a.mime.startsWith('image/')) &&
    !activeProvider?.models
      .find((m) => m.id === model)
      ?.inputModalities?.includes('image');

  const incompatibleWorkerImages = Boolean(
    orchestration &&
    attachments.some((a) => a.mime.startsWith('image/')) &&
    !workerModel?.inputModalities?.includes('image'),
  );

  async function archiveTask(task: Task) {
    setArchiveBusy(task.id);
    try {
      const updated = await api.archiveTask(task.id, !task.archivedAt);
      setTasks((current) =>
        current.map((entry) => (entry.id === updated.id ? updated : entry)),
      );
      setDetail((current) =>
        current?.task.id === updated.id
          ? { ...current, task: updated }
          : current,
      );
      setSyncVersion((value) => value + 1);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Unable to archive task.',
      );
    } finally {
      setArchiveBusy(undefined);
    }
  }

  async function emptyArchived(count: number) {
    if (!count || emptyArchivedBusy) return;
    if (
      !window.confirm(
        `Permanently delete ${count} archived ${count === 1 ? 'task' : 'tasks'}? This cannot be undone.`,
      )
    )
      return;
    setEmptyArchivedBusy(true);
    try {
      await api.deleteArchivedTasks();
      setTasks((current) => current.filter((entry) => !entry.archivedAt));
      setDetail((current) =>
        current?.task.archivedAt ? undefined : current,
      );
      setSyncVersion((value) => value + 1);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Unable to delete archived tasks.',
      );
    } finally {
      setEmptyArchivedBusy(false);
    }
  }
  const visibleTasks = tasks.filter((task) =>
    task.title.toLowerCase().includes(taskSearch.toLowerCase()),
  );
  const send = async (): Promise<void> => {
    if (
      !projectId ||
      ((incompatibleImages ||
        incompatibleWorkerImages ||
        orchestrationUnavailable) &&
        !pendingSend.current) ||
      activeTask?.status === 'running' ||
      sending.current ||
      uploading ||
      (!prompt.trim() && !attachments.length && !pendingSend.current)
    )
      return;
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      let pending = pendingSend.current;
      if (!pending) {
        let taskId = activeTaskId;
        if (!taskId) {
          const task = await api.createTask({
            projectId,
            providerId,
            model: model || undefined,
            reasoningEffort: reasoning || undefined,
          });
          taskId = task.id;
          setActiveTaskId(task.id);
          setTasks((current) => [task, ...current]);
        }
        pending = {
          taskId,
          projectId,
          input: {
            orchestration,
            clientRequestId: crypto.randomUUID(),
            permissionMode,
            attachmentIds: attachments.map((a) => a.id),
            prompt: prompt.trim(),
            model: model || undefined,
            reasoningEffort: reasoning || undefined,
          },
        };
        // Persist before dispatch. A lost response/reload reuses the same operation.
        sessionStorage.setItem(PENDING_SEND_KEY, JSON.stringify(pending));
        pendingSend.current = pending;
        setHasPendingSend(true);
      }
      setProjectId(pending.projectId);
      setActiveTaskId(pending.taskId);
      setPermissionMode(pending.input.permissionMode ?? 'workspace');
      await api.startTurn(pending.taskId, pending.input);
      setTaskSearch('');
      setTasks((current) =>
        current.map((task) =>
          task.id === pending.taskId
            ? { ...task, archivedAt: undefined }
            : task,
        ),
      );
      sessionStorage.removeItem(PENDING_SEND_KEY);
      pendingSend.current = undefined;
      setHasPendingSend(false);
      setPrompt('');
      setOrchestration(undefined);
      setAttachmentReset((value) => value + 1);
      setAttachments([]);
      setSyncVersion((value) => value + 1);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) setNeedsAuth(true);
      if (cause instanceof ApiError && [400, 404].includes(cause.status)) {
        sessionStorage.removeItem(PENDING_SEND_KEY);
        pendingSend.current = undefined;
        setHasPendingSend(false);
      }
      setError(
        cause instanceof Error ? cause.message : 'Could not start the task.',
      );
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  });
  useEffect(() => {
    if (!dictating) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing || event.key !== 'Enter') return;
      if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey)
        return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (
          target.isContentEditable ||
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          tag === 'BUTTON'
        )
          return;
      }
      const pttBinding = loadPushToTalk().binding;
      if (pttBinding && bindingMatches(pttBinding, event)) return;
      event.preventDefault();
      void sendRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dictating]);
  async function handoff(nextProvider: string, nextModel?: string) {
    if (
      !projectId ||
      !activeTaskId ||
      !detail ||
      detail.task.id !== activeTaskId ||
      sending.current ||
      busy ||
      activeTask?.status === 'running'
    )
      return;
    const turns = conversationTurns(detail).map(
      ({ userText, events, error }) => ({
        userText,
        assistantText: buildTurnTimeline(events)
          .filter((item) => item.kind === 'message')
          .map((item) => item.text)
          .join('\n'),
        error,
      }),
    );
    if (!turns.length) return;
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      const task = await api.createTask({
        projectId,
        providerId: nextProvider,
        title: activeTask?.title,
        model: nextModel,
      });
      stickToBottom.current = true;
      setOrchestration(undefined);
      setProviderId(nextProvider);
      setModel(nextModel ?? '');
      setReasoning('');
      setPermissionMode('workspace');
      setActiveTaskId(task.id);
      setDetail(undefined);
      setTasks((current) => [task, ...current]);
      const pending = {
        taskId: task.id,
        projectId,
        input: {
          clientRequestId: crypto.randomUUID(),
          permissionMode: 'workspace' as const,
          prompt: handoffBriefing({
            fromProvider: providerId,
            fromModel: model || undefined,
            title: activeTask?.title ?? task.title,
            turns,
          }),
          model: nextModel,
        },
      };
      sessionStorage.setItem(PENDING_SEND_KEY, JSON.stringify(pending));
      pendingSend.current = pending;
      setHasPendingSend(true);
      await api.startTurn(pending.taskId, pending.input);
      sessionStorage.removeItem(PENDING_SEND_KEY);
      pendingSend.current = undefined;
      setHasPendingSend(false);
      setSyncVersion((value) => value + 1);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) setNeedsAuth(true);
      setError(
        cause instanceof Error ? cause.message : 'Could not hand off the task.',
      );
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  async function addProject(path = projectPath) {
    if (!path.trim()) return;
    setBusy(true);
    try {
      const project = await api.addProject(path.trim());
      setProjects((current) => [
        project,
        ...current.filter((item) => item.id !== project.id),
      ]);
      newTask();
      setProjectId(project.id);
      closeProjectDialog();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not add project.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function browseDirectories(path = '') {
    setBusy(true);
    setError('');
    try {
      const view = await api.directories(path);
      setDirectoryView(view);
      setProjectPath(view.path);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not browse folders.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function cloneProject(source: 'git' | 'github') {
    if (!projectPath.trim()) return;
    setBusy(true);
    setError('');
    try {
      const project = await api.cloneProject(source, projectPath.trim());
      setProjects((current) => [
        project,
        ...current.filter((item) => item.id !== project.id),
      ]);
      newTask();
      setProjectId(project.id);
      closeProjectDialog();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not clone repository.',
      );
    } finally {
      setBusy(false);
    }
  }
  function chooseSource(source: 'local' | 'git' | 'github') {
    setProjectSource(source);
    setProjectPath('');
    setError('');
    if (source === 'local') void browseDirectories();
  }
  function closeProjectDialog() {
    setProjectDialog(false);
    setProjectSource('sources');
    setSourceSearch('');
    setProjectPath('');
    setDirectoryView(undefined);
    setError('');
  }
  async function decide(id: string, decision: ApprovalDecision) {
    if (!api) throw new Error('Connection unavailable. Please try again.');
    await api.decide(id, decision);
    setSyncVersion((value) => value + 1);
  }
  function newTask() {
    setOrchestration(undefined);
    setTaskSearch('');
    setSearchOpen(false);
    setActiveTaskId('');
    setPermissionMode('workspace');
    setDetail(undefined);
    setSidebarOpen(false);
  }
  useEffect(() => {
    if (searchOpen) taskSearchInput.current?.focus();
  }, [searchOpen]);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.repeat)
        return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('[data-slot="dialog-content"]')
      )
        return;
      const key = event.key.toLowerCase();
      if (key === 'n') {
        event.preventDefault();
        newTask();
      }
      if (key === 'k') {
        event.preventDefault();
        setSearchOpen(true);
        setSidebarOpen(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const transcript = conversationTurns(detail);
  const projectSources = [
    {
      id: 'local' as const,
      title: 'Local folder',
      description: 'Browse a folder on the VPS',
      icon: FolderPlus,
    },
    {
      id: 'git' as const,
      title: 'Git URL',
      description: 'Clone from a remote URL',
      icon: Link2,
    },
    {
      id: 'github' as const,
      title: 'GitHub repository',
      description: 'Clone GitHub owner/repository',
      icon: GitFork,
    },
  ].filter((source) =>
    `${source.title} ${source.description}`
      .toLowerCase()
      .includes(sourceSearch.toLowerCase()),
  );

  if (needsAuth)
    return (
      <main className="empty-state">
        <h1>Sign in to WEBAGENTS</h1>
        <p>Enter your workspace access token.</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            api.setToken(authToken.trim());
            setAuthToken('');
            setNeedsAuth(false);
            setInitialLoading(true);
            setReloadVersion((value) => value + 1);
          }}
        >
          <Input
            type="password"
            aria-label="Workspace access token"
            autoComplete="current-password"
            value={authToken}
            onChange={(event) => setAuthToken(event.target.value)}
            required
          />
          <Button type="submit">Sign in</Button>
        </form>
      </main>
    );
  return (
    <main
      className={`workspace-shell${sidebarCollapsed ? ' is-sidebar-collapsed' : ''}`}
    >
      {sidebarOpen && (
        <button
          className="sidebar-backdrop"
          type="button"
          aria-label="Close sidebar"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside
        className={
          sidebarOpen ? 'workspace-sidebar is-open' : 'workspace-sidebar'
        }
      >
        <div className={`sidebar-head${searchOpen ? ' is-searching' : ''}`}>
          {searchOpen ? (
            <div className="sidebar-search">
              <Search size={15} />
              <input
                ref={taskSearchInput}
                aria-label="Search tasks"
                placeholder="Search tasks…"
                value={taskSearch}
                onChange={(event) => setTaskSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setTaskSearch('');
                    setSearchOpen(false);
                  }
                }}
              />
              <button
                type="button"
                aria-label="Close search"
                onClick={() => {
                  setTaskSearch('');
                  setSearchOpen(false);
                }}
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <>
              <Mark />
              <div className="sidebar-head-actions">
                <button
                  type="button"
                  className="sidebar-search-toggle"
                  aria-label="Search tasks"
                  title="Search tasks (⌘K)"
                  onClick={() => setSearchOpen(true)}
                >
                  <Search size={15} />
                </button>
                <button
                  type="button"
                  className="sidebar-collapse"
                  aria-label="Collapse sidebar"
                  title="Collapse sidebar"
                  onClick={() => collapseSidebar(true)}
                >
                  <PanelLeftClose size={15} />
                </button>
                <Button
                  className="mobile-sidebar-close"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setSidebarOpen(false)}
                >
                  <X />
                </Button>
              </div>
            </>
          )}
        </div>
        <button className="new-thread" type="button" onClick={newTask}>
          <SquarePen size={16} />
          New task
          <kbd className="keyboard-hint">⌘N</kbd>
        </button>
        <ScrollArea className="sidebar-scroll">
          <nav aria-label="Tasks">
            {[false, true].map((archived) => {
              const sectionTasks = visibleTasks.filter(
                (task) => Boolean(task.archivedAt) === archived,
              );
              return (
                <section
                  key={String(archived)}
                  aria-label={archived ? 'Archived tasks' : 'Active tasks'}
                >
                  <div className="task-section-heading">
                    <h2>{archived ? 'Archived' : 'Active'}</h2>
                    <span>{sectionTasks.length}</span>
                    {archived && sectionTasks.length > 0 && (
                      <button
                        type="button"
                        className="task-section-empty"
                        disabled={emptyArchivedBusy}
                        aria-label={`Delete all ${sectionTasks.length} archived tasks`}
                        title="Delete all archived tasks"
                        onClick={() => void emptyArchived(sectionTasks.length)}
                      >
                        {emptyArchivedBusy ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Trash2 size={12} />
                        )}
                      </button>
                    )}
                  </div>
                  <div className="thread-list">
                    {sectionTasks.map((task) => (
                      <div
                        className={`thread-card${task.archivedAt ? ' is-archived' : ''}`}
                        key={task.id}
                      >
                        <button
                          type="button"
                          className={`thread-row${activeTaskId === task.id ? ' is-active' : ''}`}
                          aria-current={
                            activeTaskId === task.id ? 'page' : undefined
                          }
                          onClick={() => {
                            stickToBottom.current = true;
                            setDetail(undefined);
                            setActiveTaskId(task.id);
                            setProjectId(task.projectId);
                            setOrchestration(undefined);
                            setPermissionMode('workspace');
                            setProviderId(task.providerId);
                            setModel(task.model ?? '');
                            setReasoning(task.reasoningEffort ?? '');
                            setSidebarOpen(false);
                          }}
                        >
                          <strong className="thread-title">
                            <ProviderLogo provider={task.providerId} />
                            <span>{task.title}</span>
                          </strong>
                          <time
                            className="thread-time"
                            dateTime={task.updatedAt}
                          >
                            {timeLabel(task.updatedAt)}
                          </time>
                          <span className="thread-meta">
                            <FolderGit2 />
                            <span>
                              {projects.find(
                                (project) => project.id === task.projectId,
                              )?.name ?? 'Project'}
                            </span>
                          </span>
                          <span className={`thread-progress is-${task.status}`}>
                            {task.status === 'running' ? (
                              <i />
                            ) : task.status === 'completed' ? (
                              <Check />
                            ) : task.status === 'failed' ? (
                              <X />
                            ) : task.status === 'interrupted' ? (
                              <Square />
                            ) : (
                              <Circle />
                            )}
                            {task.status === 'completed'
                              ? 'Done'
                              : task.status === 'running'
                                ? 'Working'
                                : task.status === 'failed'
                                  ? 'Failed'
                                  : task.status === 'interrupted'
                                    ? 'Stopped'
                                    : 'Ready'}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="task-archive"
                          disabled={archiveBusy === task.id}
                          aria-label={`${task.archivedAt ? 'Restore' : 'Archive'} ${task.title}`}
                          title={
                            task.archivedAt ? 'Move to Active' : 'Archive task'
                          }
                          onClick={() => void archiveTask(task)}
                        >
                          {archiveBusy === task.id ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : task.archivedAt ? (
                            <ArchiveRestore size={14} />
                          ) : (
                            <Archive size={14} />
                          )}
                        </button>
                      </div>
                    ))}
                    {!sectionTasks.length && (
                      <div className="task-list-empty">
                        {taskSearch
                          ? 'No matching tasks.'
                          : archived
                            ? 'No archived tasks.'
                            : 'A little room for your next idea.'}
                        <span>
                          {taskSearch
                            ? 'Try another search.'
                            : archived
                              ? 'Archived conversations will appear here.'
                              : 'Start a task to get going.'}
                        </span>
                      </div>
                    )}
                  </div>
                </section>
              );
            })}
          </nav>
        </ScrollArea>
        <div className="sidebar-foot">
          <button
            type="button"
            onClick={() => {
              setSettingsOpen(true);
              setSidebarOpen(false);
            }}
          >
            <Settings2 />
            Settings
          </button>
        </div>
      </aside>
      <section
        className={`conversation-pane${terminalOpen ? ' has-terminal' : ''}${!initialLoading && !activeTaskId && projects.length > 0 ? ' is-new-task' : ''}`}
      >
        <header className="workspace-toolbar">
          <Button
            className={sidebarCollapsed ? undefined : 'mobile-only'}
            variant="ghost"
            size="icon-sm"
            aria-label="Open sidebar"
            title="Open sidebar"
            onClick={() => collapseSidebar(false)}
          >
            <LayoutPanelLeft />
          </Button>
          <div className="title-stack">
            <span>{activeProject?.name ?? 'No project'}</span>
            <i>/</i>
            <strong>{activeTask?.title ?? 'New task'}</strong>
            {activeTask?.archivedAt && (
              <span
                className="archived-task-badge"
                title="Sending a message moves this task back to Active"
              >
                <Archive size={12} />
                Archived
              </span>
            )}
          </div>
          <div className="toolbar-actions">
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={!projectId}
              id="terminal-toggle"
              aria-label={terminalOpen ? 'Hide terminal' : 'Open terminal'}
              aria-expanded={terminalOpen}
              title="Terminal"
              onClick={() => changeTerminalOpen(!terminalOpen)}
            >
              <TerminalSquare />
            </Button>
            {activeTask?.status === 'running' && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() =>
                  void api
                    .interrupt(activeTask.id)
                    .then(() => setSyncVersion((value) => value + 1))
                    .catch((cause: unknown) =>
                      setError(
                        cause instanceof Error
                          ? cause.message
                          : 'Could not stop task.',
                      ),
                    )
                }
              >
                <Square />
              </Button>
            )}
            <TaskHandoff
              providers={providers}
              currentProviderId={providerId}
              disabled={!activeTaskId || transcript.length === 0}
              running={activeTask?.status === 'running'}
              busy={busy}
              onHandoff={(nextProvider, nextModel) =>
                void handoff(nextProvider, nextModel)
              }
            />
          </div>
        </header>
        <ConversationNavigator key={activeTaskId} stops={navigationStops} />
        <ScrollArea className="conversation-scroll" ref={conversationScroll}>
          <div className="conversation-content">
            {!initialLoading && error && !projects.length && (
              <section className="empty-state">
                <div className="empty-orbit is-error">
                  <span>!</span>
                </div>
                <h1>Server unavailable</h1>
                <p>{error}</p>
                <Button
                  className="add-project-cta"
                  variant="outline"
                  onClick={() => {
                    setInitialLoading(true);
                    setReloadVersion((value) => value + 1);
                  }}
                >
                  Try again
                </Button>
              </section>
            )}
            {!initialLoading && !error && !projects.length && (
              <section className="empty-state">
                <div className="empty-orbit">
                  <span>W</span>
                </div>
                <h1>
                  What are we <span className="accent-word">building</span>?
                </h1>
                <p>Connect a project from your workspace to start coding.</p>
                <Button
                  className="add-project-cta"
                  variant="outline"
                  onClick={() => setProjectDialog(true)}
                >
                  <Plus /> Choose project
                </Button>
              </section>
            )}
            {connectionError && (
              <output className="error-banner">{connectionError}</output>
            )}
            {hasPendingSend && (
              <output className="error-banner">
                Confirming your previous message. Retry sends the same message
                safely.
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void send()}
                >
                  Retry message
                </Button>
              </output>
            )}
            {error && projects.length > 0 && (
              <div className="error-banner">{error}</div>
            )}
            {transcript.map(
              ({
                turn,
                userText,
                sentAt,
                events,
                approvals,
                error: turnError,
              }) => (
                <section
                  className="conversation-turn"
                  id={`exchange-${turn.id}`}
                  key={turn.id}
                >
                  <div className="turn-block">
                    <UserMessage
                      text={userText}
                      sentAt={sentAt}
                      attachments={turn.attachments}
                      api={api}
                    />
                  </div>
                  <TurnResponse
                    turn={turn}
                    events={events}
                    approvals={approvals}
                    onDecision={(approvalId, decision) =>
                      decide(approvalId, decision)
                    }
                  />
                  {turnError && (
                    <div className="turn-error" role="alert">
                      <span>!</span>
                      <div>
                        <strong>This turn could not be completed</strong>
                        <p>{turnError}</p>
                      </div>
                    </div>
                  )}
                </section>
              ),
            )}
          </div>
        </ScrollArea>
        <div className="composer-wrap" ref={composerElement}>
          {!initialLoading && !activeTaskId && projects.length > 0 && (
            <section className="new-task-project">
              <span className="new-task-eyebrow">NEW TASK</span>
              <h1>
                What are we <span className="accent-word">building</span>?
              </h1>
              <p>Choose a project, then describe what you have in mind.</p>
            </section>
          )}

          <div className="composer-context-strip">
            {!activeTaskId && !hasPendingSend ? (
              <ProjectSwitcher
                projects={projects}
                selectedId={projectId}
                onSelect={(id) => {
                  setProjectId(id);
                  setAttachments([]);
                  setAttachmentReset((value) => value + 1);
                }}
                onAdd={() => setProjectDialog(true)}
              />
            ) : (
              <span
                className="composer-project-fixed"
                title={activeProject?.path}
              >
                <FolderGit2 size={15} />
                <strong>{activeProject?.name ?? 'Project'}</strong>
              </span>
            )}
            <div className="composer-context-aside">
              <OrchestrationSelect
                orchestration={orchestration}
                providers={providers}
              />
              {activeProject?.branch && (
                <span
                  className="composer-branch"
                  title={`Branch ${activeProject.branch}`}
                >
                  <GitBranch size={13} />
                  <span>{activeProject.branch}</span>
                </span>
              )}
              <DeviceIndicator />
            </div>
          </div>
          <div className="composer">
            <AttachmentPicker
              key={projectId}
              api={api}
              projectId={projectId}
              disabled={!projectId || busy || hasPendingSend}
              reset={attachmentReset}
              onChange={(files, waiting) => {
                setAttachments(files);
                setUploading(waiting);
              }}
            >
              {(incompatibleImages || incompatibleWorkerImages) && (
                <p className="attachment-warning" role="alert">
                  Choose lead and worker models with image support to send these
                  images.
                </p>
              )}
              <div className={dictating ? 'composer-prompt-row is-dictating' : 'composer-prompt-row'}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="composer-attach-button"
                  disabled={
                    !projectId ||
                    busy ||
                    hasPendingSend ||
                    attachments.length >= 8
                  }
                  aria-label="Attach files"
                  title="Attach images, documents, or code"
                  onClick={() =>
                    document.getElementById('composer-file-input')?.click()
                  }
                >
                  <Paperclip size={17} />
                </Button>
                <OrchestrationComposer
                  key={activeTaskId || 'new'}
                  inputRef={messageInput}
                  prompt={prompt}
                  onPrompt={setPrompt}
                  orchestration={orchestration}
                  onOrchestration={setOrchestration}
                  providers={providers}
                  leadLabel={
                    modelOptions.find((entry) => entry.id === model)?.label ??
                    model
                  }
                  disabled={
                    !projectId ||
                    hasPendingSend ||
                    activeTask?.status === 'running'
                  }
                  onSend={() => void send()}
                />
                <div className="composer-send-tools">
                  <SpeechInput key={`${activeTaskId || projectId || 'new'}:${hasPendingSend || activeTask?.status === 'running'}`} api={api} disabled={!projectId || hasPendingSend || activeTask?.status === 'running'} onInsert={(text) => setPrompt(current => current ? `${current} ${text}` : text)} onLiveTranscript={(next, prev) => setPrompt(current => applyLiveTranscript(current, prev, next))} onActiveChange={setDictating} />
                  <Button
                    className="send-button disabled:opacity-100"
                    aria-label={
                      busy
                        ? 'Running'
                        : uploading
                          ? 'Preparing attachments'
                          : 'Run'
                    }
                    title={
                      uploading
                        ? 'Your files are still preparing'
                        : incompatibleImages
                          ? 'Choose a model with image support'
                          : 'Run'
                    }
                    disabled={
                      (!prompt.trim() &&
                        !attachments.length &&
                        !hasPendingSend) ||
                      uploading ||
                      ((incompatibleImages ||
                        incompatibleWorkerImages ||
                        orchestrationUnavailable) &&
                        !hasPendingSend) ||
                      !projectId ||
                      busy ||
                      activeTask?.status === 'running'
                    }
                    onClick={() => void send()}
                  >
                    {busy ? (
                      <Loader2 className="attachment-spin" />
                    ) : (
                      <Play
                        fill="currentColor"
                        strokeWidth={0}
                        className="size-[14px]"
                      />
                    )}
                  </Button>
                </div>
              </div>
            </AttachmentPicker>
          </div>
          <div className="composer-action-strip">
            <div className="composer-tools">
              <ModelControls
                providers={providers}
                providerId={providerId}
                model={model}
                effort={reasoning}
                effortCapability={effortCapability}
                providerLocked={!!activeTaskId}
                disabled={!projectId || busy || hasPendingSend}
                onModel={(provider, nextModel) => {
                  setProviderId(provider);
                  setModel(nextModel);
                }}
                onEffort={setReasoning}
                permissionMode={permissionMode}
                onPermissionMode={setPermissionMode}
              />
            </div>
            <div className="composer-usage">
              <ContextWindow
                events={detail?.task.id === activeTaskId ? detail.events : []}
                providerId={providerId}
              />
              <UsageLimits key={providerId} api={api} providerId={providerId} />
            </div>
          </div>
        </div>
        <TerminalPanel
          key={projectId}
          api={api}
          projectId={projectId}
          projectName={activeProject?.name ?? 'Project'}
          open={terminalOpen}
          onOpenChange={changeTerminalOpen}
        />
      </section>
      <ProviderSettings
        api={api}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
      <Dialog
        open={projectDialog}
        onOpenChange={(open) =>
          open ? setProjectDialog(true) : closeProjectDialog()
        }
      >
        <DialogContent className="project-picker" showCloseButton={false}>
          {projectSource === 'sources' ? (
            <>
              <div className="project-picker-search">
                <button
                  type="button"
                  onClick={closeProjectDialog}
                  aria-label="Close project picker"
                >
                  <ArrowLeft />
                </button>
                <Input
                  value={sourceSearch}
                  onChange={(event) => setSourceSearch(event.target.value)}
                  placeholder="Search…"
                  aria-label="Search project sources"
                />
              </div>
              <p className="project-picker-label">Sources</p>
              <div className="project-source-list">
                {projectSources.map((source) => {
                  const Icon = source.icon;
                  return (
                    <button
                      key={source.id}
                      type="button"
                      onClick={() => chooseSource(source.id)}
                    >
                      <span className="project-source-icon">
                        <Icon />
                      </span>
                      <span>
                        <strong>{source.title}</strong>
                        <small>{source.description}</small>
                      </span>
                      <ChevronDown />
                    </button>
                  );
                })}
              </div>
            </>
          ) : projectSource === 'local' ? (
            <>
              <div className="folder-commandbar">
                <button
                  type="button"
                  onClick={() => {
                    setProjectSource('sources');
                    setProjectPath('');
                    setError('');
                  }}
                  aria-label="Back to project sources"
                >
                  <ArrowLeft />
                </button>
                <Input
                  value={projectPath}
                  onChange={(event) => setProjectPath(event.target.value)}
                  placeholder="~/"
                  aria-label="Folder path"
                  onKeyDown={(event) => {
                    if (
                      event.key === 'Enter' &&
                      (event.metaKey || event.ctrlKey)
                    )
                      void addProject(projectPath);
                    else if (event.key === 'Enter')
                      void browseDirectories(projectPath);
                  }}
                />
                <Button
                  variant="outline"
                  onClick={() => void addProject(projectPath)}
                  disabled={!directoryView || busy}
                >
                  Add <span>⌘ Enter</span>
                </Button>
              </div>
              <div className="folder-browser">
                <p className="project-picker-label folder-label">Directories</p>
                <div className="folder-list">
                  {directoryView?.parent && (
                    <button
                      type="button"
                      onClick={() =>
                        void browseDirectories(directoryView.parent)
                      }
                    >
                      <ArrowLeft />
                      <span>
                        <strong>Parent folder</strong>
                        <small>{directoryView.parent}</small>
                      </span>
                    </button>
                  )}
                  {directoryView?.directories.map((directory) => (
                    <button
                      key={directory.path}
                      type="button"
                      onClick={() => void browseDirectories(directory.path)}
                    >
                      <FolderGit2 />
                      <span>
                        <strong>{directory.name}</strong>
                        <small>{directory.path}</small>
                      </span>
                      <ChevronDown />
                    </button>
                  ))}
                  {!busy && directoryView?.directories.length === 0 && (
                    <p>This folder has no subfolders.</p>
                  )}
                </div>
              </div>
              {error && <div className="project-picker-error">{error}</div>}
            </>
          ) : (
            <>
              <div className="project-picker-title">
                <button
                  type="button"
                  onClick={() => {
                    setProjectSource('sources');
                    setProjectPath('');
                    setError('');
                  }}
                >
                  <ArrowLeft />
                </button>
                <div>
                  <strong>
                    {projectSource === 'git'
                      ? 'Clone Git repository'
                      : 'Clone GitHub repository'}
                  </strong>
                  <small>
                    The repository will be cloned into your workspace
                  </small>
                </div>
              </div>
              <div className="clone-form">
                <label htmlFor="repository-source">
                  {projectSource === 'git'
                    ? 'Repository URL'
                    : 'GitHub repository'}
                </label>
                <Input
                  id="repository-source"
                  value={projectPath}
                  onChange={(event) => setProjectPath(event.target.value)}
                  placeholder={
                    projectSource === 'git'
                      ? 'https://git.example.com/team/project.git'
                      : 'owner/repository'
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void cloneProject(projectSource);
                  }}
                />
                <p>
                  {projectSource === 'git'
                    ? 'HTTPS and SSH URLs are supported.'
                    : 'Private repositories use the Git credentials configured on your VPS.'}
                </p>
                <div className="project-picker-actions">
                  <Button
                    className="primary-project-action"
                    onClick={() => void cloneProject(projectSource)}
                    disabled={!projectPath.trim() || busy}
                  >
                    {busy ? 'Cloning…' : 'Clone repository'}
                  </Button>
                </div>
              </div>
              {error && <div className="project-picker-error">{error}</div>}
            </>
          )}
        </DialogContent>
      </Dialog>
    </main>
  );
}
