/**
 * `@loombox/providers-ohmypi` intentionally ships only `provider.ts` — no
 * `image.ts`/`permissions.ts`/`tool-widgets.ts`, unlike its
 * `@loombox/providers-claude`/`@loombox/providers-codex` siblings. Neither
 * is part of the `AcpProvider`/`AcpProviderModule` contract
 * (`packages/providers/core/src/provider-registry.ts`/`types.ts` require
 * only `id`, `requiredCommand`, `spawnConfig`, and an optional `enrich`);
 * they are optional per-provider UI enrichment (image hand-off gating,
 * permission-verb-button mapping, bespoke tool-widget routing), and a
 * repo-wide grep before this package was created found neither claude's nor
 * codex's versions imported by anything outside their own owning package.
 * Building omp equivalents now would mean guessing at its real
 * image-capability advertisement, permission-option vocabulary, and
 * tool-call title format with no verification for any of the three —
 * exactly the kind of unverified placeholder AGENTS.md's grounding
 * convention (SPEC.md §16) rules out, unlike the spawn recipe and
 * `requiredCommand` below, which were verified against the real `omp acp`
 * binary (see `provider.ts`'s doc comment). Add them once a build-time
 * verification spike confirms the real behavior for each, mirroring the
 * codex/claude modules' shape.
 */
export const PACKAGE_NAME = '@loombox/providers-ohmypi';

export { ohmypiProvider, ohmypiProviderModule } from './provider';
