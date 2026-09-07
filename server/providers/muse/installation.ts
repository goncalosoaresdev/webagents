import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { InstallationDriver } from '../../core/installation-driver.ts';
import { parseMuseVersion } from './discovery.ts';

const exec = promisify(execFile);

export class MuseInstallation implements InstallationDriver {
  constructor(private readonly binary: string) {}

  async inspect() {
    try {
      const result = await exec(this.binary, ['--version'], {
        timeout: 10_000,
        killSignal: 'SIGKILL',
        maxBuffer: 512 * 1024,
        cwd: '/',
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LANG: process.env.LANG,
          LC_ALL: process.env.LC_ALL,
          MUSE_NO_AUTO_UPDATE: '1',
        },
      });
      const version = parseMuseVersion(`${result.stdout}\n${result.stderr}`);
      return {
        version,
        canUpdate: false,
        message:
          'This installation is managed outside Webcode. Update Muse Code with its official installer or rebuild your server image.',
      };
    } catch {
      return {
        canUpdate: false,
        message: 'Muse Code is not installed or executable on this server.',
      };
    }
  }

  async latest(): Promise<string> {
    const installed = (await this.inspect()).version;
    if (!installed) throw new Error('Muse Code is not installed');
    return installed;
  }

  async update(): Promise<void> {
    throw new Error('Unsupported installation');
  }
}
