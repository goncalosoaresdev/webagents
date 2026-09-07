import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { InstallationDriver } from '../../core/installation-driver.ts';
import { parseGrokVersion } from './discovery.ts';

const exec = promisify(execFile);

export class GrokInstallation implements InstallationDriver {
  constructor(private readonly binary: string) {}

  async inspect() {
    try {
      const result = await exec(this.binary, ['--version'], {
        timeout: 10_000,
        killSignal: 'SIGKILL',
        maxBuffer: 512 * 1024,
        cwd: '/',
        env: { ...process.env, GROK_DISABLE_AUTOUPDATER: '1' },
      });
      const version = parseGrokVersion(`${result.stdout}\n${result.stderr}`);
      return {
        version,
        canUpdate: false,
        message:
          'This installation is managed outside Webcode. Update Grok Build with grok update or its official installer.',
      };
    } catch {
      return {
        canUpdate: false,
        message: 'Grok Build is not installed or executable on this server.',
      };
    }
  }

  async latest(): Promise<string> {
    const installed = (await this.inspect()).version;
    if (!installed) throw new Error('Grok Build is not installed');
    return installed;
  }

  async update(): Promise<void> {
    throw new Error('Unsupported installation');
  }
}
