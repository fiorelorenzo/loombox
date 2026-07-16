import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import Page from './+page.svelte';
import { APP_NAME } from '$lib/constants';

describe('shell +page.svelte', () => {
  it('renders the loombox heading', () => {
    const { body } = render(Page);
    expect(body).toContain('<h1');
    expect(body).toContain(`>${APP_NAME}</h1>`);
  });
});
