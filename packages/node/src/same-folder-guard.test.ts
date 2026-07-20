import { describe, expect, it } from 'vitest';
import { SameFolderConflictError, SameFolderGuard } from './same-folder-guard';

describe('SameFolderGuard (issue #68)', () => {
  it('reserves a free key', () => {
    const guard = new SameFolderGuard();
    expect(() => guard.reserve('folder-a', 'session-1')).not.toThrow();
    expect(guard.isHeld('folder-a')).toBe(true);
  });

  it('refuses a second session reserving a key already held by another session', () => {
    const guard = new SameFolderGuard();
    guard.reserve('folder-a', 'session-1');

    expect(() => guard.reserve('folder-a', 'session-2')).toThrow(SameFolderConflictError);
    try {
      guard.reserve('folder-a', 'session-2');
    } catch (error) {
      expect(error).toBeInstanceOf(SameFolderConflictError);
      expect((error as SameFolderConflictError).heldBySessionId).toBe('session-1');
      expect((error as SameFolderConflictError).key).toBe('folder-a');
    }
  });

  it('is a no-op for the same session re-reserving its own key', () => {
    const guard = new SameFolderGuard();
    guard.reserve('folder-a', 'session-1');
    expect(() => guard.reserve('folder-a', 'session-1')).not.toThrow();
  });

  it('allows a different key to be reserved independently', () => {
    const guard = new SameFolderGuard();
    guard.reserve('folder-a', 'session-1');
    expect(() => guard.reserve('folder-b', 'session-2')).not.toThrow();
  });

  it('release frees the key for a new reservation', () => {
    const guard = new SameFolderGuard();
    guard.reserve('folder-a', 'session-1');
    guard.release('folder-a', 'session-1');

    expect(guard.isHeld('folder-a')).toBe(false);
    expect(() => guard.reserve('folder-a', 'session-2')).not.toThrow();
  });

  it('release is a no-op for a session that does not hold the key', () => {
    const guard = new SameFolderGuard();
    guard.reserve('folder-a', 'session-1');
    guard.release('folder-a', 'session-2');

    expect(guard.isHeld('folder-a')).toBe(true);
    expect(() => guard.reserve('folder-a', 'session-2')).toThrow(SameFolderConflictError);
  });

  it('release is idempotent', () => {
    const guard = new SameFolderGuard();
    guard.reserve('folder-a', 'session-1');
    guard.release('folder-a', 'session-1');
    expect(() => guard.release('folder-a', 'session-1')).not.toThrow();
  });
});
