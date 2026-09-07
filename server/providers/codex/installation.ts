import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
const exec = promisify(execFile);
import {
  isNewerVersion,
  stableVersion,
  type InstallationDriver,
} from '../../core/installation-driver.ts';
async function run(
  binary: string,
  args: string[],
  timeout = 10000,
): Promise<string> {
  const result = await exec(binary, args, {
    timeout,
    killSignal: 'SIGKILL',
    maxBuffer: 512 * 1024,
    cwd: '/',
    env: {
      ...process.env,
      npm_config_update_notifier: 'false',
      HOMEBREW_NO_INSTALL_CLEANUP: '1',
      HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK: '1',
      HOMEBREW_NO_ASK: '1',
    },
  });
  return result.stdout.trim();
}
async function resolveBinary(binary: string): Promise<string> {
  const candidates =
    isAbsolute(binary) || binary.includes('/')
      ? [resolve(binary)]
      : (process.env.PATH ?? '')
          .split(delimiter)
          .map((part) => join(part, binary));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      /* Try next PATH entry. */
    }
  }
  throw new Error('Codex is not installed or executable.');
}
export class CodexInstallation implements InstallationDriver {
  constructor(private readonly binary: string) {}
  private async manager(): Promise<'npm' | 'homebrew' | undefined> {
    const binary = await resolveBinary(this.binary);
    try {
      const prefix = await run('brew', ['--prefix']);
      const root = await realpath(join(prefix, 'Caskroom', 'codex'));
      if (isHomebrewCodex(binary, root)) return 'homebrew';
    } catch {
      /* Not a Homebrew installation. */
    }
    try {
      const root = await run('npm', ['root', '-g']);
      if (binary === (await realpath(join(root, '@openai/codex/bin/codex.js'))))
        return 'npm';
    } catch {
      /* Not a global npm installation. */
    }
    return undefined;
  }
  async inspect() {
    let version: string | undefined;
    try {
      version = (await run(this.binary, ['--version'])).match(
        /codex(?:-cli)?\s+(\S+)/,
      )?.[1];
    } catch {
      return {
        canUpdate: false,
        message: 'Codex is not installed or executable on this server.',
      };
    }
    try {
      const manager = await this.manager();
      if (manager === 'homebrew') {
        const prefix = await run('brew', ['--prefix']);
        await access(join(prefix, 'Caskroom', 'codex'), constants.W_OK);
        await access(join(prefix, 'bin'), constants.W_OK);
        return { version, canUpdate: true, message: 'Managed with Homebrew.' };
      }
      if (manager !== 'npm') throw new Error('Externally managed installation');
      const root = await run('npm', ['root', '-g']);
      await access(dirname(root), constants.W_OK);
      await access(join(root, '@openai/codex'), constants.W_OK);
      return { version, canUpdate: true };
    } catch {
      return {
        version,
        canUpdate: false,
        message:
          'This installation is managed outside Webcode. Update it with its original installer or rebuild your server image.',
      };
    }
  }
  async latest(): Promise<string> {
    if ((await this.manager().catch(() => undefined)) === 'homebrew') {
      const response = await fetch(
        'https://formulae.brew.sh/api/cask/codex.json',
        { signal: AbortSignal.timeout(12000) },
      );
      if (!response.ok) throw new Error('Homebrew release check failed');
      const data = (await response.json()) as { version?: unknown };
      if (typeof data.version !== 'string' || !stableVersion(data.version))
        throw new Error('Invalid Homebrew release');
      return data.version;
    }
    const version: unknown = JSON.parse(
      await run(
        'npm',
        [
          'view',
          '@openai/codex',
          'dist-tags.latest',
          '--json',
          '--registry=https://registry.npmjs.org',
        ],
        12000,
      ),
    );
    if (typeof version !== 'string' || !stableVersion(version))
      throw new Error('Invalid stable release');
    return version;
  }
  async update(version: string): Promise<void> {
    if (!stableVersion(version) || !(await this.inspect()).canUpdate)
      throw new Error('Unsupported installation');
    if ((await this.manager()) === 'homebrew') {
      await run('brew', ['upgrade', '--cask', 'codex'], 180000);
    } else
      await run(
        'npm',
        [
          'install',
          '-g',
          `@openai/codex@${version}`,
          '--registry=https://registry.npmjs.org',
          '--no-audit',
          '--no-fund',
        ],
        180000,
      );
    const installed = (await this.inspect()).version;
    if (
      !installed ||
      (installed !== version && !isNewerVersion(version, installed))
    )
      throw new Error('Updated version could not be verified');
  }
}

/** Match only the versioned executable owned by the Codex cask. */
export function isHomebrewCodex(binary: string, caskRoot: string): boolean {
  if (!binary.startsWith(caskRoot + '/')) return false;
  return /^\d+\.\d+\.\d+\/bin\/codex$/.test(binary.slice(caskRoot.length + 1));
}
