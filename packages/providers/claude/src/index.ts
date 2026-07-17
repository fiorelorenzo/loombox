export const PACKAGE_NAME = '@loombox/providers-claude';

export { claudeProvider, claudeProviderModule } from './provider';

export { buildClaudeImageContentBlock } from './image';

export { mapClaudePermissionOptions } from './permissions';
export type { ClaudePermissionButton, ClaudePermissionVerb } from './permissions';

export { claudeBespokeToolName, hasClaudeBespokeWidget } from './tool-widgets';
export type { ClaudeBespokeToolName } from './tool-widgets';
