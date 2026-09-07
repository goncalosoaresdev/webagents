import type { ProviderModel } from './contracts';

export interface ProviderCatalogEntry {
  id: string;
  name: string;
  available: boolean;
  models: readonly ProviderModel[];
}

export const providerCatalog: readonly ProviderCatalogEntry[] = [
  {
    id: 'codex',
    name: 'Codex',
    available: true,
    models: [
      {
        id: 'gpt-5.6-sol',
        label: 'GPT-5.6 Sol',
        capabilities: [
          {
            id: 'reasoningEffort',
            label: 'Reasoning',
            defaultValue: 'high',
            values: [
              { id: 'low', label: 'Low' },
              { id: 'medium', label: 'Medium' },
              { id: 'high', label: 'High' },
              { id: 'xhigh', label: 'Extra high' },
            ],
          },
        ],
      },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', capabilities: [] },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', capabilities: [] },
    ],
  },
  {
    id: 'grok',
    name: 'Grok',
    available: true,
    models: [
      {
        id: 'grok-4.6',
        label: 'Grok 4.6',
        inputModalities: ['text', 'image'],
        capabilities: [
          {
            id: 'reasoningEffort',
            label: 'Reasoning',
            defaultValue: 'high',
            values: [
              { id: 'minimal', label: 'Minimal' },
              { id: 'low', label: 'Low' },
              { id: 'medium', label: 'Medium' },
              { id: 'high', label: 'High' },
              { id: 'xhigh', label: 'Extra high' },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'muse',
    name: 'Muse',
    available: true,
    models: [
      {
        id: 'muse-spark-1.3',
        label: 'Muse Spark 1.3',
        capabilities: [
          {
            id: 'reasoningEffort',
            label: 'Reasoning',
            defaultValue: 'high',
            values: [
              { id: 'low', label: 'Low' },
              { id: 'medium', label: 'Medium' },
              { id: 'high', label: 'High' },
              { id: 'xhigh', label: 'Extra high' },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'claude',
    name: 'Claude Code',
    available: false,
    models: [
      { id: 'provider-default', label: 'Provider default', capabilities: [] },
    ],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    available: false,
    models: [
      { id: 'provider-default', label: 'Provider default', capabilities: [] },
    ],
  },
];
