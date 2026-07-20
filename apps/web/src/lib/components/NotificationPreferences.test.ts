// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createInMemoryNotificationPreferencesStorage } from '$lib/notification-preferences';
import NotificationPreferences from './NotificationPreferences.svelte';

afterEach(() => cleanup());

describe('NotificationPreferences (#166)', () => {
  it('lists every project path with an unchecked mute checkbox by default', () => {
    render(NotificationPreferences, {
      props: {
        projectPaths: ['/repo/a', '/repo/b'],
        storage: createInMemoryNotificationPreferencesStorage(),
      },
    });

    const checkboxA = screen.getByTestId('mute-project-/repo/a') as HTMLInputElement;
    const checkboxB = screen.getByTestId('mute-project-/repo/b') as HTMLInputElement;
    expect(checkboxA.checked).toBe(false);
    expect(checkboxB.checked).toBe(false);
  });

  it('renders nothing to mute when there are no known projects', () => {
    render(NotificationPreferences, {
      props: { projectPaths: [], storage: createInMemoryNotificationPreferencesStorage() },
    });
    expect(screen.queryByText('Mute per project')).toBeNull();
  });

  it('muting a project persists it and calls onChange with the new preferences', async () => {
    const storage = createInMemoryNotificationPreferencesStorage();
    const onChange = vi.fn();
    render(NotificationPreferences, {
      props: { projectPaths: ['/repo/a'], storage, onChange },
    });

    await fireEvent.click(screen.getByTestId('mute-project-/repo/a'));

    expect(storage.get().mutedProjects).toEqual(['/repo/a']);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ mutedProjects: ['/repo/a'] }));
  });

  it('unmuting a project removes it', async () => {
    const storage = createInMemoryNotificationPreferencesStorage();
    storage.set({ mutedProjects: ['/repo/a'], quietHours: undefined });
    render(NotificationPreferences, { props: { projectPaths: ['/repo/a'], storage } });

    const checkbox = screen.getByTestId('mute-project-/repo/a') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    await fireEvent.click(checkbox);

    expect(storage.get().mutedProjects).toEqual([]);
  });

  it('quiet hours are off, with no time inputs shown, by default', () => {
    render(NotificationPreferences, {
      props: { projectPaths: [], storage: createInMemoryNotificationPreferencesStorage() },
    });
    expect((screen.getByTestId('quiet-hours-enabled') as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByTestId('quiet-hours-start')).toBeNull();
  });

  it('enabling quiet hours persists a default window and shows the time inputs', async () => {
    const storage = createInMemoryNotificationPreferencesStorage();
    const onChange = vi.fn();
    render(NotificationPreferences, { props: { projectPaths: [], storage, onChange } });

    await fireEvent.click(screen.getByTestId('quiet-hours-enabled'));

    expect(screen.getByTestId('quiet-hours-start')).toBeTruthy();
    expect(storage.get().quietHours).toEqual({ start: '22:00', end: '07:00' });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ quietHours: { start: '22:00', end: '07:00' } }),
    );
  });

  it('changing the start/end time persists the updated window', async () => {
    const storage = createInMemoryNotificationPreferencesStorage();
    storage.set({ mutedProjects: [], quietHours: { start: '22:00', end: '07:00' } });
    render(NotificationPreferences, { props: { projectPaths: [], storage } });

    const startInput = screen.getByTestId('quiet-hours-start') as HTMLInputElement;
    await fireEvent.change(startInput, { target: { value: '23:30' } });

    expect(storage.get().quietHours).toEqual({ start: '23:30', end: '07:00' });
  });

  it('disabling quiet hours clears the stored window', async () => {
    const storage = createInMemoryNotificationPreferencesStorage();
    storage.set({ mutedProjects: [], quietHours: { start: '22:00', end: '07:00' } });
    render(NotificationPreferences, { props: { projectPaths: [], storage } });

    await fireEvent.click(screen.getByTestId('quiet-hours-enabled'));

    expect(storage.get().quietHours).toBeUndefined();
    expect(screen.queryByTestId('quiet-hours-start')).toBeNull();
  });
});
