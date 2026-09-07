export const permissionModes = [
  'read-only',
  'workspace',
  'full-access',
] as const;
export type PermissionMode = (typeof permissionModes)[number];
export const permissionOptions: readonly {
  id: PermissionMode;
  label: string;
  description: string;
}[] = [
  {
    id: 'read-only',
    label: 'Read only',
    description: 'Inspect files. No filesystem writes or sandbox escalation.',
  },
  {
    id: 'workspace',
    label: 'Workspace',
    description:
      'Edit the project and temporary files. Ask when broader access is needed.',
  },
  {
    id: 'full-access',
    label: 'Full access',
    description:
      'Run commands with network and host filesystem access, without approval prompts.',
  },
];
