export const PACKAGE_NAME = '@loombox/providers-generic';

export { createGenericProvider } from './provider';

export { mapGenericPermissionOptions } from './permissions';
export type { GenericPermissionButton, GenericPermissionVerb } from './permissions';

export { classifyGenericToolKind } from './tool-kind';

export {
  buildImageResourceLinkContentBlock,
  sweepStaleImageTempDirs,
  writeImageTempFile,
} from './image';
export type { ImageTempFileHandle } from './image';
