import { describe, expect, it } from 'vitest';

import { pickTrayIconPath, type TrayIconPaths } from './tray-icon';

const paths: TrayIconPaths = {
  template: '/assets/tray-iconTemplate.png',
  colored: '/assets/tray-icon-azure.png',
};

describe('pickTrayIconPath', () => {
  it('picks the template image on darwin, which the OS tints itself', () => {
    expect(pickTrayIconPath('darwin', paths)).toBe(paths.template);
  });

  it('picks the colored image on win32, which applies no tinting', () => {
    expect(pickTrayIconPath('win32', paths)).toBe(paths.colored);
  });

  it('picks the colored image on linux, where a dark panel would render an untinted template as a black blob', () => {
    expect(pickTrayIconPath('linux', paths)).toBe(paths.colored);
  });
});
