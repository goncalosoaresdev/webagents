'use client';
import { useState } from 'react';
import { Check, ChevronsUpDown, FolderGit2, Plus, Search } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import type { Project } from '@/lib/workspace/contracts';

export function ProjectSwitcher({
  projects,
  selectedId,
  onSelect,
  onAdd,
}: {
  projects: readonly Project[];
  selectedId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const current = projects.find((project) => project.id === selectedId);
  const matches = projects.filter((project) =>
    `${project.name} ${project.path}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) setQuery('');
      }}
    >
      <PopoverTrigger
        className="workspace-switcher"
        aria-label={`Choose project: ${current?.name ?? 'Choose a project'}`}
      >
        <span className="workspace-switcher-icon">
          <FolderGit2 size={17} />
        </span>
        <span className="workspace-switcher-label">
          <small>Project</small>
          <strong>{current?.name ?? 'Choose a project'}</strong>
        </span>
        <ChevronsUpDown size={13} />
      </PopoverTrigger>
      <PopoverContent
        className="workspace-switcher-menu"
        align="start"
        sideOffset={7}
      >
        <PopoverTitle className="workspace-switcher-heading">
          Choose project <span>{projects.length}</span>
        </PopoverTitle>
        {projects.length > 4 && (
          <label className="workspace-switcher-search">
            <Search size={14} />
            <input
              aria-label="Find a project"
              placeholder="Find a project…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        )}
        <div className="workspace-switcher-options">
          {matches.map((project) => (
            <button
              key={project.id}
              type="button"
              className={`workspace-switcher-option${project.id === selectedId ? ' is-current' : ''}`}
              aria-pressed={project.id === selectedId}
              onClick={() => {
                if (project.id !== selectedId) onSelect(project.id);
                setOpen(false);
                setQuery('');
              }}
            >
              <FolderGit2 size={16} />
              <span>
                <strong>{project.name}</strong>
                <small title={project.path}>{project.path}</small>
              </span>
              {project.id === selectedId && <Check size={14} />}
            </button>
          ))}
          {!matches.length && (
            <p className="workspace-switcher-empty">
              {query
                ? 'No matching projects.'
                : 'Add your first project to begin.'}
            </p>
          )}
        </div>
        <button
          type="button"
          className="workspace-switcher-add"
          onClick={() => {
            setOpen(false);
            onAdd();
          }}
        >
          <Plus size={15} />
          Add project
        </button>
      </PopoverContent>
    </Popover>
  );
}
