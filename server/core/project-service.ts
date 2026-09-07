import { mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import type { Project } from '../../lib/workspace/contracts.ts';
import type { WorkspaceStore } from '../storage/workspace-store.ts';
import { ConflictError } from '../storage/errors.ts';

const execFileAsync = promisify(execFile);

export class InvalidProjectPathError extends Error {}

export class ProjectService {
  readonly #root: string;

  constructor(
    private readonly store: WorkspaceStore,
    workspaceRoot: string,
  ) {
    this.#root = realpathSync(workspaceRoot);
  }

  list(): readonly Project[] {
    return this.store.listProjects().map(withBranch);
  }

  validatePath(path: string): string {
    const registered = this.store.findProjectByPath(path);
    if (!registered) {
      throw new InvalidProjectPathError(
        'Project directory must be registered before execution.',
      );
    }
    const canonical = this.#resolveReadableDirectory(path);
    if (canonical !== registered.path) {
      throw new InvalidProjectPathError(
        'Project directory has moved. Add its current location before running a task.',
      );
    }
    return canonical;
  }

  add(path: string, name?: string): Project {
    const canonical = this.#resolveReadableDirectory(path);
    const existing = this.store.findProjectByPath(canonical);
    if (existing) return existing;
    const now = new Date().toISOString();
    const cleanName = name?.trim().slice(0, 120);
    return withBranch(
      this.store.createProject({
        id: randomUUID(),
        name: cleanName || basename(canonical) || 'Workspace',
        path: canonical,
        isGitRepository: isGitRepository(canonical),
        now,
      }),
    );
  }

  async listDirectories(path = ''): Promise<{
    path: string;
    parent?: string;
    directories: readonly { name: string; path: string }[];
  }> {
    const canonical = this.#resolveReadableDirectory(path || this.#root);
    const entries = await readdir(canonical, { withFileTypes: true });
    const directories = entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name !== '.git' &&
          entry.name !== 'node_modules',
      )
      .map((entry) => ({ name: entry.name, path: join(canonical, entry.name) }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const parentPath = dirname(canonical);
    return {
      path: canonical,
      ...(parentPath !== canonical ? { parent: parentPath } : {}),
      directories,
    };
  }

  async clone(source: 'git' | 'github', value: string): Promise<Project> {
    const url = source === 'github' ? githubUrl(value) : validatedGitUrl(value);
    const destinationName = repositoryName(url);
    const destination = resolve(this.#root, destinationName);
    try {
      await stat(destination);
      throw new ConflictError(
        `A folder named ${destinationName} already exists.`,
      );
    } catch (error) {
      if (error instanceof ConflictError) throw error;
    }
    const staging = await mkdtemp(join(this.#root, '.webcode-clone-'));
    const checkout = join(staging, 'checkout');
    try {
      await execFileAsync('git', ['clone', '--', url, checkout], {
        cwd: this.#root,
        timeout: 5 * 60_000,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_SSH_COMMAND:
            process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
        },
      });
      await rename(checkout, destination);
      return this.add(destination, destinationName);
    } catch (error) {
      if (error instanceof ConflictError) throw error;
      const message =
        error instanceof Error
          ? error.message.split('\n')[0]
          : 'Git clone failed.';
      throw new InvalidProjectPathError(message.slice(0, 300));
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  #resolveReadableDirectory(path: string): string {
    const expanded =
      path === '~'
        ? homedir()
        : path.startsWith('~/')
          ? join(homedir(), path.slice(2))
          : path;
    const requested = isAbsolute(expanded)
      ? resolve(expanded)
      : resolve(this.#root, expanded);
    let canonical: string;
    try {
      if (!statSync(requested).isDirectory())
        throw new Error('not a directory');
      canonical = realpathSync(requested);
    } catch {
      throw new InvalidProjectPathError(
        'Project path must be an existing readable directory.',
      );
    }
    return canonical;
  }
}

function withBranch(project: Project): Project {
  const branch = currentBranch(project.path) ?? nestedBranches(project.path);
  const git = project.isGitRepository || Boolean(branch);
  if (!branch && git === project.isGitRepository) return project;
  return {
    ...project,
    isGitRepository: git,
    ...(branch ? { branch } : {}),
  };
}

function currentBranch(path: string): string | undefined {
  try {
    const name = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: path,
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    if (!name) return undefined;
    if (name === 'HEAD') {
      return (
        execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
          cwd: path,
          timeout: 1500,
          stdio: ['ignore', 'pipe', 'ignore'],
          encoding: 'utf8',
        }).trim() || undefined
      );
    }
    return name.slice(0, 80);
  } catch {
    return undefined;
  }
}

function nestedBranches(path: string): string | undefined {
  try {
    const names = new Set<string>();
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        entry.name.startsWith('.') ||
        entry.name === 'node_modules'
      )
        continue;
      const branch = currentBranch(join(path, entry.name));
      if (branch) names.add(branch);
    }
    if (names.size === 0) return undefined;
    const listed = [...names].slice(0, 2);
    const extra = names.size - listed.length;
    return extra > 0 ? `${listed.join(' · ')} +${extra}` : listed.join(' · ');
  } catch {
    return undefined;
  }
}

function isGitRepository(path: string): boolean {
  try {
    return (
      statSync(resolve(path, '.git')).isDirectory() ||
      statSync(resolve(path, '.git')).isFile()
    );
  } catch {
    return false;
  }
}

function githubUrl(value: string): string {
  const repository = value
    .trim()
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new InvalidProjectPathError(
      'Enter a GitHub repository as owner/repository.',
    );
  }
  return `https://github.com/${repository}.git`;
}

function validatedGitUrl(value: string): string {
  const url = value.trim();
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+$/.test(url)) return url;
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol === 'https:' &&
      parsed.hostname &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    )
      return url;
  } catch {
    /* handled below */
  }
  throw new InvalidProjectPathError('Use an HTTPS or SSH Git URL.');
}

function repositoryName(url: string): string {
  const tail =
    url
      .split(/[/:]/)
      .at(-1)
      ?.replace(/\.git$/, '') ?? '';
  const safe = tail
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 100);
  if (!safe)
    throw new InvalidProjectPathError(
      'The repository URL has no valid project name.',
    );
  return safe;
}
