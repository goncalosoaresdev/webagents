import { spawn } from 'node:child_process';

try {
  process.loadEnvFile('.env');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const children = [start('dev:server'), start('dev:web')];
let stopping = false;

function start(script) {
  return spawn('npm', ['run', script], { stdio: 'inherit', shell: process.platform === 'win32' });
}

function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

for (const child of children) {
  child.once('error', (error) => {
    console.error(error.message);
    stop();
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    if (stopping) return;
    stop();
    process.exitCode = signal ? 1 : (code ?? 1);
  });
}

process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
