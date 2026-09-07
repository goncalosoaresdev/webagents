import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { InvalidProjectPathError, ProjectService } from './project-service.ts';
import { SqliteWorkspaceStore } from '../storage/sqlite-workspace-store.ts';
import { AgentService } from './agent-service.ts';
import { ConnectionHub } from '../realtime/connection-hub.ts';

void test('registered external projects can browse and execute without moving into the clone root', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'webcode-projects-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'workspace');
  const external = join(directory, 'existing-project');
  mkdirSync(root);
  mkdirSync(join(external, '.git'), { recursive: true });
  const store = new SqliteWorkspaceStore(':memory:');
  const projects = new ProjectService(store, root);
  const project = projects.add(external);
  assert.equal(project.path, realpathSync(external));
  assert.equal(project.isGitRepository, true);
  assert.equal(projects.add(external).id, project.id);
  assert.equal((await projects.listDirectories(external)).path, project.path);
  assert.equal((await projects.listDirectories()).path, realpathSync(root));
  let executedPath: string | undefined;
  const agents = new AgentService(
    store,
    new ConnectionHub(),
    [
      {
        providerId: 'fixture',
        async executeTurn(input) {
          executedPath = input.cwd;
          return { status: 'completed' };
        },
        async interrupt() {
          return false;
        },
        async close() {},
      },
    ],
    { validatePath: (path) => projects.validatePath(path) },
  );
  context.after(async () => {
    await agents.close();
    store.close();
  });
  const task = agents.createTask({
    projectId: project.id,
    providerId: 'fixture',
  });
  agents.startTurn(task.id, {
    clientRequestId: crypto.randomUUID(),
    prompt: 'hello',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executedPath, project.path);
  assert.equal(agents.getTask(task.id).task.status, 'completed');
});

void test('execution revalidates legacy registered paths and rejects missing or redirected directories', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'webcode-paths-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'workspace');
  const external = join(directory, 'legacy');
  mkdirSync(root);
  mkdirSync(external);
  const store = new SqliteWorkspaceStore(':memory:');
  context.after(() => store.close());
  const canonical = realpathSync(external);
  // Existing data predates the current project service's validation policy.
  store.createProject({
    id: 'legacy',
    name: 'Legacy',
    path: canonical,
    isGitRepository: false,
    now: new Date().toISOString(),
  });
  const projects = new ProjectService(store, root);
  assert.equal(projects.validatePath(canonical), canonical);
  assert.throws(() => projects.validatePath(root), /registered/);
  renameSync(external, `${external}-moved`);
  assert.throws(
    () => projects.validatePath(canonical),
    /existing readable directory/,
  );
  symlinkSync(`${external}-moved`, external, 'dir');
  assert.throws(() => projects.validatePath(canonical), /has moved/);
  assert.throws(
    () => projects.add(join(directory, 'missing')),
    InvalidProjectPathError,
  );
});

function initRepo(path: string, branch: string) {
  mkdirSync(path, { recursive: true });
  execFileSync('git', ['init', '-b', branch], { cwd: path });
  execFileSync('git', ['config', 'user.email', 'dev@example.com'], {
    cwd: path,
  });
  execFileSync('git', ['config', 'user.name', 'Dev'], { cwd: path });
  writeFileSync(join(path, 'README'), 'ok');
  execFileSync('git', ['add', 'README'], { cwd: path });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: path });
}

void test('lists the current git branch for registered repositories', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'webcode-branch-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'workspace');
  const repo = join(directory, 'repo');
  mkdirSync(root);
  initRepo(repo, 'feature-x');
  const store = new SqliteWorkspaceStore(':memory:');
  context.after(() => store.close());
  const projects = new ProjectService(store, root);
  const project = projects.add(repo);
  assert.equal(project.branch, 'feature-x');
  assert.equal(projects.list()[0]?.branch, 'feature-x');
});

void test('lists nested repository branches when the folder itself is not git', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'webcode-nested-branch-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'workspace');
  const workspace = join(directory, 'apps');
  mkdirSync(root);
  initRepo(join(workspace, 'app'), 'main');
  initRepo(join(workspace, 'docs'), '13.x');
  const store = new SqliteWorkspaceStore(':memory:');
  context.after(() => store.close());
  const projects = new ProjectService(store, root);
  const project = projects.add(workspace);
  assert.equal(project.isGitRepository, true);
  assert.ok(project.branch?.includes('main'));
  assert.ok(project.branch?.includes('13.x'));
});
