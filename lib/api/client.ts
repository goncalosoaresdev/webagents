import type { Attachment } from '../workspace/contracts.ts';
import type { ProviderSnapshot } from '../providers/contracts.ts';
import type {
  ApprovalDecision,
  Project,
  Task,
  TaskDetail,
  Turn,
} from '../workspace/contracts.ts';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class WebcodeApi {
  #token = '';
  setToken(token: string): void {
    this.#token = token;
  }
  constructor(readonly baseUrl = '/api/v1') {}
  authHeaders(): Record<string, string> {
    return this.#token ? { authorization: `Bearer ${this.#token}` } : {};
  }
  attachment(id: string) {
    return this.get<Attachment>(`/attachments/${id}`);
  }
  async attachmentImage(id: string) {
    const response = await fetch(`${this.baseUrl}/attachments/${id}/content`, {
      headers: this.authHeaders(),
    });
    if (!response.ok) throw new Error('Image unavailable');
    return URL.createObjectURL(await response.blob());
  }
  async attachmentPreview(id: string) {
    const response = await fetch(`${this.baseUrl}/attachments/${id}/preview`, {
      headers: this.authHeaders(),
    });
    if (!response.ok) throw new Error('Preview unavailable');
    return URL.createObjectURL(await response.blob());
  }
  completeAttachment(id: string) {
    return this.post<Attachment>(`/attachments/${id}/complete`, {});
  }
  removeAttachment(id: string) {
    return this.request(`/attachments/${id}`, { method: 'DELETE' });
  }
  async downloadAttachment(asset: Attachment) {
    const response = await fetch(
      `${this.baseUrl}/attachments/${asset.id}/content`,
      { headers: this.authHeaders() },
    );
    if (!response.ok)
      throw new Error(
        'Attachment unavailable. Check your connection and authentication.',
      );
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = asset.name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  limits(providerId: string, refresh = false) {
    const path = `/providers/${encodeURIComponent(providerId)}/limits`;
    return refresh
      ? this.post<import('../providers/limits.ts').ProviderLimits>(
          path + '/refresh',
          {},
        )
      : this.get<import('../providers/limits.ts').ProviderLimits>(path);
  }
  installations() {
    return this.get<
      import('../providers/installation.ts').ProviderInstallation[]
    >('/provider-installations');
  }
  checkInstallation(id: string) {
    return this.post<
      import('../providers/installation.ts').ProviderInstallation
    >(`/providers/${encodeURIComponent(id)}/installation/check`, {});
  }
  updateInstallation(id: string) {
    return this.post<
      import('../providers/installation.ts').ProviderInstallation
    >(`/providers/${encodeURIComponent(id)}/installation/update`, {});
  }
  terminals(projectId: string) {
    return this.get<import('../workspace/terminal.ts').TerminalSession[]>(
      `/terminals?projectId=${encodeURIComponent(projectId)}`,
    );
  }
  createTerminal(projectId: string, id: string) {
    return this.post<import('../workspace/terminal.ts').TerminalSession>(
      '/terminals',
      { projectId, id },
    );
  }
  terminalTicket(id: string) {
    return this.post<{ token: string }>(`/terminals/${id}/ticket`, {});
  }
  endTerminal(id: string) {
    return this.request(`/terminals/${id}`, { method: 'DELETE' });
  }
  providers() {
    return this.get<readonly ProviderSnapshot[]>('/providers');
  }
  projects() {
    return this.get<readonly Project[]>('/projects');
  }
  archiveTask(id: string, archived: boolean) {
    return this.post<Task>(`/tasks/${id}/archive`, { archived });
  }
  tasks(projectId?: string) {
    return this.get<readonly Task[]>(
      `/tasks?includeArchived=true${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`,
    );
  }
  task(id: string, after = 0, signal?: AbortSignal) {
    return this.request<TaskDetail>(`/tasks/${id}?after=${after}`, {
      method: 'GET',
      signal,
    });
  }
  addProject(path: string, name?: string) {
    return this.post<Project>('/projects', { path, name });
  }
  directories(path = '') {
    return this.get<{
      path: string;
      parent?: string;
      directories: readonly { name: string; path: string }[];
    }>(`/projects/directories?path=${encodeURIComponent(path)}`);
  }
  cloneProject(source: 'git' | 'github', value: string) {
    return this.post<Project>('/projects/clone', { source, value });
  }
  createTask(input: {
    projectId: string;
    providerId: string;
    title?: string;
    model?: string;
    reasoningEffort?: string;
    permissionMode?: import('../workspace/permissions.ts').PermissionMode;
  }) {
    return this.post<Task>('/tasks', input);
  }
  startTurn(
    taskId: string,
    input: {
      attachmentIds?: string[];
      clientRequestId: string;
      prompt: string;
      model?: string;
      reasoningEffort?: string;
      permissionMode?: import('../workspace/permissions.ts').PermissionMode;
    },
  ) {
    return this.post<Turn>(`/tasks/${taskId}/turns`, input);
  }
  decide(approvalId: string, decision: ApprovalDecision) {
    return this.post(`/approvals/${approvalId}/decision`, { decision });
  }
  interrupt(taskId: string) {
    return this.post<{ interrupted: boolean }>(
      `/tasks/${taskId}/interrupt`,
      {},
    );
  }
  private get<T>(path: string): Promise<T> {
    return this.request(path, { method: 'GET' });
  }
  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request(path, { method: 'POST', body: JSON.stringify(body) });
  }
  private async request<T>(path: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: init.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(path === '/projects/clone' ? 330_000 : 30_000),
        headers: {
          ...(init.body != null ? { 'content-type': 'application/json' } : {}),
          ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
        },
      });
    } catch {
      if (init.signal?.aborted) throw init.signal.reason;
      throw new ApiError('Connection interrupted. Reconnecting…', 0);
    }
    const body = await response.text();
    let payload: { data?: T; error?: { message?: string } } = {};
    if (body) {
      try {
        payload = JSON.parse(body) as typeof payload;
      } catch {
        throw new ApiError(
          response.ok
            ? 'The server returned an invalid response.'
            : `The server returned HTTP ${response.status}.`,
          response.status,
        );
      }
    }
    if (!response.ok || payload.data === undefined)
      throw new ApiError(
        payload.error?.message ??
          `The server returned HTTP ${response.status}.`,
        response.status,
      );
    return payload.data;
  }
}
