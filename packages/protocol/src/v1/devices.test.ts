import { describe, expect, it } from 'vitest';
import {
  amkEpochFetchRequest,
  amkEpochFetchResponse,
  amkEscrow,
  deviceRegister,
  deviceRevoke,
  deviceRotate,
  newDeviceBootstrapRequest,
  newDeviceBootstrapResponse,
  qrPairingRequest,
  qrPairingResponse,
  wrappedAmkEnvelope,
} from './devices';

describe('deviceRegister', () => {
  const valid = {
    type: 'device_register',
    protocolVersion: 1,
    deviceId: 'device-1',
    devicePublicKey: 'YWJjZA==',
  };

  it('parses a valid deviceRegister', () => {
    expect(deviceRegister.parse(valid)).toEqual(valid);
  });

  it('accepts an optional label', () => {
    expect(deviceRegister.parse({ ...valid, label: "Lorenzo's phone" }).label).toBe(
      "Lorenzo's phone",
    );
  });

  it('rejects a non-base64 devicePublicKey', () => {
    expect(() => deviceRegister.parse({ ...valid, devicePublicKey: 'nope!' })).toThrow();
  });

  it('rejects a missing deviceId', () => {
    const { deviceId: _deviceId, ...rest } = valid;
    expect(() => deviceRegister.parse(rest)).toThrow();
  });
});

describe('wrappedAmkEnvelope', () => {
  const validEnvelope = {
    resourceId: 'amk-epoch-2',
    iv: 'aGVsbG8=',
    ciphertext: 'YWJjZA==',
    alg: 'AES-256-GCM' as const,
  };

  it('parses a valid wrapped-AMK envelope', () => {
    const valid = { deviceId: 'device-2', envelope: validEnvelope };
    expect(wrappedAmkEnvelope.parse(valid)).toEqual(valid);
  });

  it('rejects a malformed inner envelope', () => {
    expect(() =>
      wrappedAmkEnvelope.parse({ deviceId: 'device-2', envelope: { ...validEnvelope, iv: 'x' } }),
    ).toThrow();
  });
});

describe('deviceRevoke', () => {
  const valid = {
    type: 'device_revoke',
    protocolVersion: 1,
    deviceId: 'device-1',
    newEpoch: 1,
    rewrappedAmk: [
      {
        deviceId: 'device-2',
        envelope: {
          resourceId: 'amk-epoch-2',
          iv: 'aGVsbG8=',
          ciphertext: 'YWJjZA==',
          alg: 'AES-256-GCM' as const,
        },
      },
    ],
  };

  it('parses a valid deviceRevoke carrying rewrapped AMK copies', () => {
    expect(deviceRevoke.parse(valid)).toEqual(valid);
  });

  it('accepts an empty rewrappedAmk list (last device revoked)', () => {
    expect(deviceRevoke.parse({ ...valid, rewrappedAmk: [] }).rewrappedAmk).toEqual([]);
  });

  it('rejects a malformed rewrappedAmk entry', () => {
    expect(() =>
      deviceRevoke.parse({ ...valid, rewrappedAmk: [{ deviceId: 'device-2' }] }),
    ).toThrow();
  });

  it('rejects a missing newEpoch', () => {
    const { newEpoch: _newEpoch, ...rest } = valid;
    expect(() => deviceRevoke.parse(rest)).toThrow();
  });

  it('rejects a non-positive newEpoch', () => {
    expect(() => deviceRevoke.parse({ ...valid, newEpoch: 0 })).toThrow();
    expect(() => deviceRevoke.parse({ ...valid, newEpoch: -1 })).toThrow();
  });
});

describe('amkEpochFetchRequest / amkEpochFetchResponse', () => {
  const request = {
    type: 'amk_epoch_fetch_request',
    protocolVersion: 1,
    deviceId: 'device-2',
  };
  const responseWithPending = {
    type: 'amk_epoch_fetch_response',
    protocolVersion: 1,
    deviceId: 'device-2',
    pending: {
      epoch: 1,
      fromDeviceId: 'device-1',
      fromDevicePublicKey: 'YWJjZA==',
      envelope: {
        resourceId: 'loombox-amk-rotation-v1:acct_1:device-2:1',
        iv: 'aGVsbG8=',
        ciphertext: 'YWJjZA==',
        alg: 'AES-256-GCM' as const,
      },
    },
  };
  const responseWithoutPending = {
    type: 'amk_epoch_fetch_response',
    protocolVersion: 1,
    deviceId: 'device-2',
  };

  it('parses a valid request', () => {
    expect(amkEpochFetchRequest.parse(request)).toEqual(request);
  });

  it('rejects a missing deviceId on the request', () => {
    const { deviceId: _deviceId, ...rest } = request;
    expect(() => amkEpochFetchRequest.parse(rest)).toThrow();
  });

  it('parses a valid response carrying a pending envelope', () => {
    expect(amkEpochFetchResponse.parse(responseWithPending)).toEqual(responseWithPending);
  });

  it('parses a valid response with no pending envelope (already current)', () => {
    expect(amkEpochFetchResponse.parse(responseWithoutPending).pending).toBeUndefined();
  });

  it('rejects a pending envelope missing fromDevicePublicKey', () => {
    const { fromDevicePublicKey: _fromDevicePublicKey, ...restPending } =
      responseWithPending.pending;
    expect(() =>
      amkEpochFetchResponse.parse({ ...responseWithPending, pending: restPending }),
    ).toThrow();
  });

  it('rejects a non-positive pending epoch', () => {
    expect(() =>
      amkEpochFetchResponse.parse({
        ...responseWithPending,
        pending: { ...responseWithPending.pending, epoch: 0 },
      }),
    ).toThrow();
  });
});

describe('deviceRotate', () => {
  const valid = {
    type: 'device_rotate',
    protocolVersion: 1,
    deviceId: 'device-1',
    newDevicePublicKey: 'YWJjZA==',
  };

  it('parses a valid deviceRotate', () => {
    expect(deviceRotate.parse(valid)).toEqual(valid);
  });

  it('rejects a non-base64 newDevicePublicKey', () => {
    expect(() => deviceRotate.parse({ ...valid, newDevicePublicKey: 'nope!' })).toThrow();
  });
});

describe('amkEscrow', () => {
  const valid = { type: 'amk_escrow', protocolVersion: 1, wrappedAmk: 'YWJjZA==' };

  it('parses a valid amkEscrow', () => {
    expect(amkEscrow.parse(valid)).toEqual(valid);
  });

  it('rejects a non-base64 wrappedAmk blob', () => {
    expect(() => amkEscrow.parse({ ...valid, wrappedAmk: 'not base64' })).toThrow();
  });
});

describe('newDeviceBootstrapRequest / newDeviceBootstrapResponse', () => {
  const request = {
    type: 'new_device_bootstrap_request',
    protocolVersion: 1,
    deviceId: 'device-3',
    devicePublicKey: 'YWJjZA==',
  };
  const response = {
    type: 'new_device_bootstrap_response',
    protocolVersion: 1,
    wrappedAmk: 'YWJjZA==',
  };

  it('parses a valid request', () => {
    expect(newDeviceBootstrapRequest.parse(request)).toEqual(request);
  });

  it('parses a valid response', () => {
    expect(newDeviceBootstrapResponse.parse(response)).toEqual(response);
  });

  it('rejects a request with the wrong type discriminator', () => {
    expect(() =>
      newDeviceBootstrapRequest.parse({ ...request, type: 'device_register' }),
    ).toThrow();
  });
});

describe('qrPairingRequest / qrPairingResponse', () => {
  const request = {
    type: 'qr_pairing_request',
    protocolVersion: 1,
    pairingCode: '123-456',
    newDeviceId: 'device-4',
    newDevicePublicKey: 'YWJjZA==',
  };
  const response = {
    type: 'qr_pairing_response',
    protocolVersion: 1,
    pairingCode: '123-456',
    envelope: {
      resourceId: 'amk-epoch-1',
      iv: 'aGVsbG8=',
      ciphertext: 'YWJjZA==',
      alg: 'AES-256-GCM' as const,
    },
  };

  it('parses a valid request', () => {
    expect(qrPairingRequest.parse(request)).toEqual(request);
  });

  it('parses a valid response', () => {
    expect(qrPairingResponse.parse(response)).toEqual(response);
  });

  it('rejects a missing pairingCode', () => {
    const { pairingCode: _pairingCode, ...rest } = request;
    expect(() => qrPairingRequest.parse(rest)).toThrow();
  });
});
