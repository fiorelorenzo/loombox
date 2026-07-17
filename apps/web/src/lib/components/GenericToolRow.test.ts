// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import type { TranscriptToolCallItem } from '@loombox/providers-core';
import GenericToolRow from './GenericToolRow.svelte';

afterEach(() => cleanup());

const item: TranscriptToolCallItem = {
  type: 'tool_call',
  id: 'tc1',
  turnId: 't1',
  title: 'Search for TODOs',
  toolKind: 'search',
  status: 'in_progress',
  diff: undefined,
  rawInput: { pattern: 'TODO' },
  content: undefined,
  parentToolCallId: undefined,
};

describe('GenericToolRow', () => {
  it('renders the ToolKind badge, title, and status', () => {
    render(GenericToolRow, { props: { item } });
    expect(screen.getByText('search')).toBeTruthy();
    expect(screen.getByText('Search for TODOs')).toBeTruthy();
    expect(screen.getByText('in_progress')).toBeTruthy();
  });

  it('renders rawInput as a fallback preview when there is no content yet', () => {
    render(GenericToolRow, { props: { item } });
    expect(screen.getByText(/"pattern": "TODO"/)).toBeTruthy();
  });
});
