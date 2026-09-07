export interface TerminalSession {
  id: string;
  projectId: string;
  name: string;
  status: 'running' | 'exited';
  createdAt: string;
  exitCode?: number;
}
export type TerminalOutput =
  | {
      type: 'snapshot';
      data: string;
      cols: number;
      rows: number;
      status: 'running' | 'exited';
    }
  | { type: 'output'; data: string }
  | { type: 'exit'; exitCode: number }
  | { type: 'resize'; cols: number; rows: number };
