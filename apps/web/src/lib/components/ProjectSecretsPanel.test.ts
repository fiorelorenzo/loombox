// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createInMemoryProjectEnvStorage } from '$lib/project-env-store';
import ProjectSecretsPanel from './ProjectSecretsPanel.svelte';

afterEach(() => cleanup());

describe('ProjectSecretsPanel (issue #258)', () => {
  it('starts with an empty state when nothing is declared', () => {
    render(ProjectSecretsPanel, {
      props: { projectPath: '/tmp/project', storage: createInMemoryProjectEnvStorage() },
    });
    expect(screen.getByTestId('ui-empty-state')).toBeTruthy();
  });

  it('declaring a secret-reference env var adds it to storage, shows a "needs secret" badge, and calls onSecretRequired — never a value', async () => {
    const storage = createInMemoryProjectEnvStorage();
    const onSecretRequired = vi.fn();
    render(ProjectSecretsPanel, {
      props: { projectPath: '/tmp/project', storage, onSecretRequired },
    });

    await fireEvent.input(screen.getByTestId('env-add-name'), {
      target: { value: 'DB_PASSWORD' },
    });
    await fireEvent.input(screen.getByTestId('env-add-secret'), {
      target: { value: 'db-password' },
    });
    await fireEvent.click(screen.getByTestId('env-add-submit'));

    expect(storage.get()).toEqual([{ name: 'DB_PASSWORD', secret: 'db-password' }]);
    expect(screen.getByTestId('project-secret-DB_PASSWORD')).toBeTruthy();
    expect(screen.getByTestId('secret-badge-DB_PASSWORD').textContent).toMatch(/db-password/);
    expect(onSecretRequired).toHaveBeenCalledWith('DB_PASSWORD', 'db-password');
  });

  it('declaring a literal-value env var adds it with a "Literal value" badge and never calls onSecretRequired', async () => {
    const storage = createInMemoryProjectEnvStorage();
    const onSecretRequired = vi.fn();
    render(ProjectSecretsPanel, {
      props: { projectPath: '/tmp/project', storage, onSecretRequired },
    });

    await fireEvent.input(screen.getByTestId('env-add-name'), {
      target: { value: 'NODE_ENV' },
    });
    await fireEvent.input(screen.getByTestId('env-add-value'), {
      target: { value: 'test' },
    });
    await fireEvent.click(screen.getByTestId('env-add-submit'));

    expect(storage.get()).toEqual([{ name: 'NODE_ENV', value: 'test' }]);
    expect(screen.getByTestId('literal-badge-NODE_ENV')).toBeTruthy();
    expect(onSecretRequired).not.toHaveBeenCalled();
  });

  it('rejects an add with neither a secret name nor a literal value, with a visible reason', async () => {
    const storage = createInMemoryProjectEnvStorage();
    render(ProjectSecretsPanel, { props: { projectPath: '/tmp/project', storage } });

    await fireEvent.input(screen.getByTestId('env-add-name'), {
      target: { value: 'EMPTY' },
    });
    await fireEvent.click(screen.getByTestId('env-add-submit'));

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(storage.get()).toEqual([]);
  });

  it('adding a duplicate env var name shows a clear duplicate error rather than silently no-oping', async () => {
    const storage = createInMemoryProjectEnvStorage();
    render(ProjectSecretsPanel, { props: { projectPath: '/tmp/project', storage } });

    for (let i = 0; i < 2; i += 1) {
      await fireEvent.input(screen.getByTestId('env-add-name'), {
        target: { value: 'DB_PASSWORD' },
      });
      await fireEvent.input(screen.getByTestId('env-add-secret'), {
        target: { value: 'db-password' },
      });
      await fireEvent.click(screen.getByTestId('env-add-submit'));
    }

    expect(screen.getByRole('alert').textContent).toMatch(/duplicate/i);
  });

  it('removing a declared env var updates the list and calls onChange', async () => {
    const storage = createInMemoryProjectEnvStorage();
    const onChange = vi.fn();
    render(ProjectSecretsPanel, { props: { projectPath: '/tmp/project', storage, onChange } });

    await fireEvent.input(screen.getByTestId('env-add-name'), {
      target: { value: 'DB_PASSWORD' },
    });
    await fireEvent.input(screen.getByTestId('env-add-secret'), {
      target: { value: 'db-password' },
    });
    await fireEvent.click(screen.getByTestId('env-add-submit'));
    onChange.mockClear();

    await fireEvent.click(screen.getByTestId('decl-remove-DB_PASSWORD'));
    expect(storage.get()).toEqual([]);
    expect(onChange).toHaveBeenCalledWith([]);
    expect(screen.queryByTestId('project-secret-DB_PASSWORD')).toBeNull();
  });

  it('no Field in this panel renders prose as its control (design spec §0.7, applied repo-wide)', () => {
    render(ProjectSecretsPanel, {
      props: { projectPath: '/tmp/project', storage: createInMemoryProjectEnvStorage() },
    });
    const fields = screen.getAllByTestId('ui-field');
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      const control = field.querySelector('.ui-field-control');
      expect(control?.querySelector('input, button, textarea, select, [role]')).not.toBeNull();
    }
  });
});
