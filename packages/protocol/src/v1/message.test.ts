import { describe, expect, it } from 'vitest';
import { schemasV1 } from './index';
import { parseWireMessageV1, safeParseWireMessageV1, wireMessageV1 } from './message';

const validEnvelope = {
  resourceId: 'res-1',
  iv: 'aGVsbG8=',
  ciphertext: 'YWJjZA==',
  alg: 'AES-256-GCM' as const,
};

const validSessionMetaPublic = {
  id: 'sess-1',
  nodeId: 'node-1',
  targetId: 'local',
  accountId: 'acct-1',
  provider: 'claude',
  createdAt: 1_700_000_000_000,
};

/** One valid instance of every v1 message family, keyed by its `type` discriminator. */
const messagesByType: Record<string, unknown> = {
  initialize: {
    type: 'initialize',
    protocolVersion: 1,
    role: 'node',
    authToken: 'tok',
    deviceId: 'device-1',
    devicePublicKey: 'YWJjZA==',
  },
  initialize_result: {
    type: 'initialize_result',
    protocolVersion: 1,
    negotiatedVersion: 1,
    capabilities: ['e2e'],
  },
  device_register: {
    type: 'device_register',
    protocolVersion: 1,
    deviceId: 'device-1',
    devicePublicKey: 'YWJjZA==',
  },
  device_revoke: {
    type: 'device_revoke',
    protocolVersion: 1,
    deviceId: 'device-1',
    newEpoch: 1,
    rewrappedAmk: [],
  },
  device_rotate: {
    type: 'device_rotate',
    protocolVersion: 1,
    deviceId: 'device-1',
    newDevicePublicKey: 'YWJjZA==',
  },
  amk_escrow: { type: 'amk_escrow', protocolVersion: 1, wrappedAmk: 'YWJjZA==' },
  amk_epoch_fetch_request: {
    type: 'amk_epoch_fetch_request',
    protocolVersion: 1,
    deviceId: 'device-2',
  },
  amk_epoch_fetch_response: {
    type: 'amk_epoch_fetch_response',
    protocolVersion: 1,
    deviceId: 'device-2',
    pending: {
      epoch: 1,
      fromDeviceId: 'device-1',
      fromDevicePublicKey: 'YWJjZA==',
      envelope: validEnvelope,
    },
  },
  new_device_bootstrap_request: {
    type: 'new_device_bootstrap_request',
    protocolVersion: 1,
    deviceId: 'device-2',
    devicePublicKey: 'YWJjZA==',
  },
  new_device_bootstrap_response: {
    type: 'new_device_bootstrap_response',
    protocolVersion: 1,
    wrappedAmk: 'YWJjZA==',
  },
  qr_pairing_request: {
    type: 'qr_pairing_request',
    protocolVersion: 1,
    pairingCode: '123-456',
    newDeviceId: 'device-3',
    newDevicePublicKey: 'YWJjZA==',
  },
  qr_pairing_response: {
    type: 'qr_pairing_response',
    protocolVersion: 1,
    pairingCode: '123-456',
    envelope: validEnvelope,
  },
  target_announce: {
    type: 'target_announce',
    protocolVersion: 1,
    nodeId: 'node-1',
    targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: ['claude'] }],
  },
  target_list_request: {
    type: 'target_list_request',
    protocolVersion: 1,
    requestId: 'req-1',
  },
  target_list: {
    type: 'target_list',
    protocolVersion: 1,
    requestId: 'req-1',
    targets: [
      {
        nodeId: 'node-1',
        targetId: 'local',
        label: 'This machine',
        kind: 'local',
        reachable: true,
        providers: ['claude'],
      },
    ],
  },
  target_status: {
    type: 'target_status',
    protocolVersion: 1,
    nodeId: 'node-1',
    samples: [
      {
        targetId: 'local',
        cpuPercent: 12,
        memPercent: 20,
        memUsedBytes: 1,
        memTotalBytes: 2,
        diskPercent: 5,
        diskUsedBytes: 1,
        diskTotalBytes: 2,
        healthy: true,
        sampledAt: 1,
      },
    ],
  },
  session_create: {
    type: 'session_create',
    protocolVersion: 1,
    sessionId: 'sess-1',
    targetId: 'local',
    provider: 'claude',
    privateEnvelope: validEnvelope,
  },
  session_announce: {
    type: 'session_announce',
    protocolVersion: 1,
    session: validSessionMetaPublic,
    privateEnvelope: validEnvelope,
  },
  session_resume: { type: 'session_resume', protocolVersion: 1, sessionId: 'sess-1' },
  session_list_request: { type: 'session_list_request', protocolVersion: 1 },
  session_list: {
    type: 'session_list',
    protocolVersion: 1,
    sessions: [{ session: validSessionMetaPublic, privateEnvelope: validEnvelope }],
  },
  session_update: {
    type: 'session_update',
    protocolVersion: 1,
    sessionId: 'sess-1',
    seq: 0,
    envelope: validEnvelope,
  },
  prompt_inject: {
    type: 'prompt_inject',
    protocolVersion: 1,
    sessionId: 'sess-1',
    promptId: 'p1',
    envelope: validEnvelope,
  },
  permission_request: {
    type: 'permission_request',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
    envelope: validEnvelope,
  },
  permission_response: {
    type: 'permission_response',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
    decision: 'allow_once',
  },
  config_option: {
    type: 'config_option',
    protocolVersion: 1,
    sessionId: 'sess-1',
    category: 'model',
    optionId: 'claude-sonnet',
  },
  config_option_result: {
    type: 'config_option_result',
    protocolVersion: 1,
    sessionId: 'sess-1',
    category: 'model',
    result: { outcome: 'ok' },
  },
  blob_upload: {
    type: 'blob_upload',
    protocolVersion: 1,
    sessionId: 'sess-1',
    ref: 'ref-1',
    envelope: validEnvelope,
  },
  blob_ref: {
    type: 'blob_ref',
    protocolVersion: 1,
    sessionId: 'sess-1',
    ref: 'ref-1',
    envelope: validEnvelope,
  },
  blob_download: { type: 'blob_download', protocolVersion: 1, sessionId: 'sess-1', ref: 'ref-1' },
  blob_download_response: {
    type: 'blob_download_response',
    protocolVersion: 1,
    sessionId: 'sess-1',
    ref: 'ref-1',
    envelope: validEnvelope,
  },
  presence: { type: 'presence', protocolVersion: 1, deviceId: 'device-1', online: true },
  resync_request: {
    type: 'resync_request',
    protocolVersion: 1,
    sessionId: 'sess-1',
    sinceSeq: 0,
  },
  resync_marker: {
    type: 'resync_marker',
    protocolVersion: 1,
    sessionId: 'sess-1',
    fromSeq: 0,
    toSeq: 3,
    dropped: true,
  },
  attention_hint: {
    type: 'attention_hint',
    protocolVersion: 1,
    sessionId: 'sess-1',
    class: 'awaiting_input',
  },
  custom_agent_probe_request: {
    type: 'custom_agent_probe_request',
    protocolVersion: 1,
    nodeId: 'node-1',
    targetId: 'local',
    requestId: 'req-1',
    envelope: validEnvelope,
  },
  custom_agent_probe_response: {
    type: 'custom_agent_probe_response',
    protocolVersion: 1,
    targetId: 'local',
    requestId: 'req-1',
    envelope: validEnvelope,
  },
  test_runner_config_get: {
    type: 'test_runner_config_get',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
  },
  test_runner_config_set: {
    type: 'test_runner_config_set',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
    envelope: validEnvelope,
  },
  test_runner_config_result: {
    type: 'test_runner_config_result',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
    envelope: validEnvelope,
  },
  test_runner_config_detect: {
    type: 'test_runner_config_detect',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
  },
  test_runner_config_detected: {
    type: 'test_runner_config_detected',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
    envelope: validEnvelope,
  },
  github_cli_import_request: {
    type: 'github_cli_import_request',
    protocolVersion: 1,
    requestId: 'req-1',
    nodeId: 'node-1',
  },
  github_cli_import_response: {
    type: 'github_cli_import_response',
    protocolVersion: 1,
    requestId: 'req-1',
    nodeId: 'node-1',
    result: { outcome: 'success', entries: [] },
  },
  account_pin_scan_request: {
    type: 'account_pin_scan_request',
    protocolVersion: 1,
    requestId: 'req-1',
    nodeId: 'node-1',
    accountId: 'acct-1',
  },
  account_pin_scan_response: {
    type: 'account_pin_scan_response',
    protocolVersion: 1,
    requestId: 'req-1',
    nodeId: 'node-1',
    accountId: 'acct-1',
    affected: [],
  },
  run_start: {
    type: 'run_start',
    protocolVersion: 1,
    sessionId: 'sess-1',
    targetId: 'local',
    runId: 'run-1',
    requestId: 'req-1',
    envelope: validEnvelope,
  },
  run_started: {
    type: 'run_started',
    protocolVersion: 1,
    sessionId: 'sess-1',
    runId: 'run-1',
    requestId: 'req-1',
    envelope: validEnvelope,
  },
  run_output: {
    type: 'run_output',
    protocolVersion: 1,
    sessionId: 'sess-1',
    runId: 'run-1',
    envelope: validEnvelope,
  },
  run_exit: {
    type: 'run_exit',
    protocolVersion: 1,
    sessionId: 'sess-1',
    runId: 'run-1',
    envelope: validEnvelope,
  },
  run_cancel: {
    type: 'run_cancel',
    protocolVersion: 1,
    sessionId: 'sess-1',
    runId: 'run-1',
  },
  session_view_state_get_request: {
    type: 'session_view_state_get_request',
    protocolVersion: 1,
    requestId: 'req-1',
    sessionId: 'sess-1',
  },
  session_view_state_set: {
    type: 'session_view_state_set',
    protocolVersion: 1,
    requestId: 'req-1',
    sessionId: 'sess-1',
    envelope: validEnvelope,
    revision: 0,
  },
  session_view_state_result: {
    type: 'session_view_state_result',
    protocolVersion: 1,
    requestId: 'req-1',
    sessionId: 'sess-1',
    envelope: validEnvelope,
    revision: 0,
  },
  spend_report_request: {
    type: 'spend_report_request',
    protocolVersion: 1,
    nodeId: 'node-1',
    projectPath: '/repo',
    requestId: 'req-1',
  },
  spend_report_response: {
    type: 'spend_report_response',
    protocolVersion: 1,
    nodeId: 'node-1',
    projectPath: '/repo',
    requestId: 'req-1',
    envelope: validEnvelope,
  },
  pr_open_preview_request: {
    type: 'pr_open_preview_request',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
  },
  pr_open_preview_result: {
    type: 'pr_open_preview_result',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
    envelope: validEnvelope,
  },
  pr_open_request: {
    type: 'pr_open_request',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
    envelope: validEnvelope,
  },
  pr_open_result: {
    type: 'pr_open_result',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
    envelope: validEnvelope,
  },
  git_branch_list_request: {
    type: 'git_branch_list_request',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
  },
  git_branch_list_response: {
    type: 'git_branch_list_response',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
    envelope: validEnvelope,
  },
  git_branch_create_request: {
    type: 'git_branch_create_request',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
    envelope: validEnvelope,
  },
  git_branch_create_response: {
    type: 'git_branch_create_response',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
    envelope: validEnvelope,
  },
  git_branch_switch_request: {
    type: 'git_branch_switch_request',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
    envelope: validEnvelope,
  },
  git_branch_switch_response: {
    type: 'git_branch_switch_response',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
    envelope: validEnvelope,
  },
  git_branch_merge_request: {
    type: 'git_branch_merge_request',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
    envelope: validEnvelope,
  },
  git_branch_merge_response: {
    type: 'git_branch_merge_response',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
    envelope: validEnvelope,
  },
  git_branch_merge_abort_request: {
    type: 'git_branch_merge_abort_request',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
  },
  git_branch_merge_abort_response: {
    type: 'git_branch_merge_abort_response',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
    envelope: validEnvelope,
  },
  git_push_request: {
    type: 'git_push_request',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
    envelope: validEnvelope,
  },
  git_push_response: {
    type: 'git_push_response',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
    envelope: validEnvelope,
  },
  git_stash_save_request: {
    type: 'git_stash_save_request',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
    envelope: validEnvelope,
  },
  git_stash_save_response: {
    type: 'git_stash_save_response',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
    envelope: validEnvelope,
  },
  git_stash_list_request: {
    type: 'git_stash_list_request',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
  },
  git_stash_list_response: {
    type: 'git_stash_list_response',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
    envelope: validEnvelope,
  },
  git_stash_pop_request: {
    type: 'git_stash_pop_request',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
    envelope: validEnvelope,
  },
  git_stash_pop_response: {
    type: 'git_stash_pop_response',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
    envelope: validEnvelope,
  },
  git_stash_drop_request: {
    type: 'git_stash_drop_request',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
    envelope: validEnvelope,
  },
  git_stash_drop_response: {
    type: 'git_stash_drop_response',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
    envelope: validEnvelope,
  },
  ci_check_status: {
    type: 'ci_check_status',
    protocolVersion: 1,
    sessionId: 'sess-1',
    envelope: validEnvelope,
  },
  review_comment_status: {
    type: 'review_comment_status',
    protocolVersion: 1,
    sessionId: 'sess-1',
    envelope: validEnvelope,
  },
  pr_merge_request: {
    type: 'pr_merge_request',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
    envelope: validEnvelope,
  },
  pr_merge_result: {
    type: 'pr_merge_result',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
    envelope: validEnvelope,
  },
  ci_auto_iterate_status: {
    type: 'ci_auto_iterate_status',
    protocolVersion: 1,
    sessionId: 'sess-1',
    envelope: validEnvelope,
  },
  ci_auto_iterate_stop: {
    type: 'ci_auto_iterate_stop',
    protocolVersion: 1,
    sessionId: 'sess-1',
  },
  run_status: {
    type: 'run_status',
    protocolVersion: 1,
    sessionId: 'sess-1',
    envelope: validEnvelope,
  },
};

/**
 * v1 types not (yet) covered by a fixture above -- every one of these already has a
 * `type` literal referenced by some other `packages/protocol/src/v1/*.test.ts` file (per
 * issue #910's own literal sweep), just not yet consolidated into this central map. This
 * is the "honest interim shape" issue #910 asks for instead of authoring ~120 fixtures in
 * one PR: the derived check below still requires every `wireMessageV1` member to be
 * fixtured or named here, so a NEW member landing in neither fails immediately -- it is
 * only pre-existing members that get the pass, and only with a stated reason.
 */
const NOT_YET_FIXTURED: Record<string, string> = {
  account_pin_get_request:
    'exercised in packages/protocol/src/v1/account-connect.test.ts; not yet consolidated into this map (issue #910).',
  account_pin_resolve_request:
    'exercised in packages/protocol/src/v1/account-connect.test.ts; not yet consolidated into this map (issue #910).',
  account_pin_resolve_response:
    'exercised in packages/protocol/src/v1/account-connect.test.ts; not yet consolidated into this map (issue #910).',
  account_pin_response:
    'exercised in packages/protocol/src/v1/account-connect.test.ts; not yet consolidated into this map (issue #910).',
  account_pin_set_request:
    'exercised in packages/protocol/src/v1/account-connect.test.ts; not yet consolidated into this map (issue #910).',
  account_pin_unset_request:
    'exercised in packages/protocol/src/v1/account-connect.test.ts; not yet consolidated into this map (issue #910).',
  agent_instructions_get_request:
    'exercised in packages/protocol/src/v1/agent-instructions.test.ts; not yet consolidated into this map (issue #910).',
  agent_instructions_get_response:
    'exercised in packages/protocol/src/v1/agent-instructions.test.ts; not yet consolidated into this map (issue #910).',
  agent_instructions_set_request:
    'exercised in packages/protocol/src/v1/agent-instructions.test.ts; not yet consolidated into this map (issue #910).',
  agent_instructions_set_response:
    'exercised in packages/protocol/src/v1/agent-instructions.test.ts; not yet consolidated into this map (issue #910).',
  agent_profile_list_get:
    'exercised in packages/protocol/src/v1/agent-profile.test.ts; not yet consolidated into this map (issue #910).',
  agent_profile_list_result:
    'exercised in packages/protocol/src/v1/agent-profile.test.ts; not yet consolidated into this map (issue #910).',
  agent_profile_list_set:
    'exercised in packages/protocol/src/v1/agent-profile.test.ts; not yet consolidated into this map (issue #910).',
  agent_profile_session_get:
    'exercised in packages/protocol/src/v1/agent-profile.test.ts; not yet consolidated into this map (issue #910).',
  agent_profile_session_result:
    'exercised in packages/protocol/src/v1/agent-profile.test.ts; not yet consolidated into this map (issue #910).',
  agent_profile_session_set:
    'exercised in packages/protocol/src/v1/agent-profile.test.ts; not yet consolidated into this map (issue #910).',
  checkpoint_create:
    'exercised in packages/protocol/src/v1/checkpoint.test.ts; not yet consolidated into this map (issue #910).',
  checkpoint_list:
    'exercised in packages/protocol/src/v1/checkpoint.test.ts; not yet consolidated into this map (issue #910).',
  checkpoint_list_result:
    'exercised in packages/protocol/src/v1/checkpoint.test.ts; not yet consolidated into this map (issue #910).',
  checkpoint_restore:
    'exercised in packages/protocol/src/v1/checkpoint.test.ts; not yet consolidated into this map (issue #910).',
  checkpoint_restore_preview:
    'exercised in packages/protocol/src/v1/checkpoint.test.ts; not yet consolidated into this map (issue #910).',
  checkpoint_restore_preview_result:
    'exercised in packages/protocol/src/v1/checkpoint.test.ts; not yet consolidated into this map (issue #910).',
  checkpoint_restore_result:
    'exercised in packages/protocol/src/v1/checkpoint.test.ts; not yet consolidated into this map (issue #910).',
  checkpoint_result:
    'exercised in packages/protocol/src/v1/checkpoint.test.ts; not yet consolidated into this map (issue #910).',
  connected_account_announce:
    'exercised in packages/protocol/src/v1/connected-accounts.test.ts; not yet consolidated into this map (issue #910).',
  connected_account_disconnect_request:
    'exercised in packages/protocol/src/v1/account-connect.test.ts; not yet consolidated into this map (issue #910).',
  connected_account_disconnect_response:
    'exercised in packages/protocol/src/v1/account-connect.test.ts; not yet consolidated into this map (issue #910).',
  connected_account_list:
    'exercised in packages/protocol/src/v1/connected-accounts.test.ts; not yet consolidated into this map (issue #910).',
  connected_account_list_request:
    'exercised in packages/protocol/src/v1/connected-accounts.test.ts; not yet consolidated into this map (issue #910).',
  decommission_target_request:
    'exercised in packages/protocol/src/v1/target-lifecycle.test.ts; not yet consolidated into this map (issue #910).',
  decommission_target_response:
    'exercised in packages/protocol/src/v1/target-lifecycle.test.ts; not yet consolidated into this map (issue #910).',
  fs_list_request:
    'exercised in packages/protocol/src/v1/fs.test.ts; not yet consolidated into this map (issue #910).',
  fs_list_response:
    'exercised in packages/protocol/src/v1/fs.test.ts; not yet consolidated into this map (issue #910).',
  fs_read_request:
    'exercised in packages/protocol/src/v1/fs.test.ts; not yet consolidated into this map (issue #910).',
  fs_read_response:
    'exercised in packages/protocol/src/v1/fs.test.ts; not yet consolidated into this map (issue #910).',
  fs_write_request:
    'exercised in packages/protocol/src/v1/fs.test.ts; not yet consolidated into this map (issue #910).',
  fs_write_response:
    'exercised in packages/protocol/src/v1/fs.test.ts; not yet consolidated into this map (issue #910).',
  git_commit_draft_request:
    'exercised in packages/protocol/src/v1/git-commit.test.ts; not yet consolidated into this map (issue #910).',
  git_commit_draft_response:
    'exercised in packages/protocol/src/v1/git-commit.test.ts; not yet consolidated into this map (issue #910).',
  git_commit_request:
    'exercised in packages/protocol/src/v1/git-commit.test.ts; not yet consolidated into this map (issue #910).',
  git_commit_response:
    'exercised in packages/protocol/src/v1/git-commit.test.ts; not yet consolidated into this map (issue #910).',
  git_conflict_resolve_request:
    'exercised in packages/protocol/src/v1/git-conflict-resolve.test.ts; not yet consolidated into this map (issue #910).',
  git_conflict_resolve_response:
    'exercised in packages/protocol/src/v1/git-conflict-resolve.test.ts; not yet consolidated into this map (issue #910).',
  git_diff_explain_request:
    'exercised in packages/protocol/src/v1/git-diff-explain.test.ts; not yet consolidated into this map (issue #910).',
  git_diff_explain_response:
    'exercised in packages/protocol/src/v1/git-diff-explain.test.ts; not yet consolidated into this map (issue #910).',
  git_diff_request:
    'exercised in packages/protocol/src/v1/git-diff.test.ts and packages/protocol/src/v1/git-graph.test.ts; not yet consolidated into this map (issue #910).',
  git_diff_response:
    'exercised in packages/protocol/src/v1/git-diff.test.ts and packages/protocol/src/v1/git-graph.test.ts; not yet consolidated into this map (issue #910).',
  git_graph_request:
    'exercised in packages/protocol/src/v1/git-graph.test.ts; not yet consolidated into this map (issue #910).',
  git_graph_response:
    'exercised in packages/protocol/src/v1/git-graph.test.ts; not yet consolidated into this map (issue #910).',
  git_hunk_action_request:
    'exercised in packages/protocol/src/v1/git-hunks.test.ts; not yet consolidated into this map (issue #910).',
  git_hunk_action_response:
    'exercised in packages/protocol/src/v1/git-hunks.test.ts; not yet consolidated into this map (issue #910).',
  git_hunk_diff_request:
    'exercised in packages/protocol/src/v1/git-hunks.test.ts; not yet consolidated into this map (issue #910).',
  git_hunk_diff_response:
    'exercised in packages/protocol/src/v1/git-hunks.test.ts; not yet consolidated into this map (issue #910).',
  github_connect_cancel_request:
    'exercised in packages/protocol/src/v1/account-connect.test.ts; not yet consolidated into this map (issue #910).',
  github_connect_device_code:
    'exercised in packages/protocol/src/v1/account-connect.test.ts; not yet consolidated into this map (issue #910).',
  github_connect_result:
    'exercised in packages/protocol/src/v1/account-connect.test.ts; not yet consolidated into this map (issue #910).',
  github_connect_start_request:
    'exercised in packages/protocol/src/v1/account-connect.test.ts; not yet consolidated into this map (issue #910).',
  github_pat_connect_request:
    'exercised in packages/protocol/src/v1/account-connect.test.ts; not yet consolidated into this map (issue #910).',
  github_pat_connect_response:
    'exercised in packages/protocol/src/v1/account-connect.test.ts; not yet consolidated into this map (issue #910).',
  jira_connect_request:
    'exercised in packages/protocol/src/v1/account-connect.test.ts; not yet consolidated into this map (issue #910).',
  jira_connect_response:
    'exercised in packages/protocol/src/v1/account-connect.test.ts; not yet consolidated into this map (issue #910).',
  keymap_get_request:
    'exercised in packages/protocol/src/v1/keymap.test.ts; not yet consolidated into this map (issue #910).',
  keymap_result:
    'exercised in packages/protocol/src/v1/keymap.test.ts; not yet consolidated into this map (issue #910).',
  keymap_set_request:
    'exercised in packages/protocol/src/v1/keymap.test.ts; not yet consolidated into this map (issue #910).',
  lease_release:
    'exercised in packages/protocol/src/v1/lease.test.ts; not yet consolidated into this map (issue #910).',
  lease_release_result:
    'exercised in packages/protocol/src/v1/lease.test.ts; not yet consolidated into this map (issue #910).',
  lease_request:
    'exercised in packages/protocol/src/v1/lease.test.ts; not yet consolidated into this map (issue #910).',
  lease_result:
    'exercised in packages/protocol/src/v1/lease.test.ts; not yet consolidated into this map (issue #910).',
  mcp_prompt_get_request:
    'exercised in packages/protocol/src/v1/mcp-prompts.test.ts; not yet consolidated into this map (issue #910).',
  mcp_prompt_get_response:
    'exercised in packages/protocol/src/v1/mcp-prompts.test.ts; not yet consolidated into this map (issue #910).',
  node_self_update_apply_request:
    'exercised in packages/protocol/src/v1/node-self-update.test.ts; not yet consolidated into this map (issue #910).',
  node_self_update_apply_response:
    'exercised in packages/protocol/src/v1/node-self-update.test.ts; not yet consolidated into this map (issue #910).',
  node_self_update_status:
    'exercised in packages/protocol/src/v1/node-self-update.test.ts; not yet consolidated into this map (issue #910).',
  permission_policy_get:
    'exercised in packages/protocol/src/v1/permission-policy.test.ts; not yet consolidated into this map (issue #910).',
  permission_policy_result:
    'exercised in packages/protocol/src/v1/permission-policy.test.ts; not yet consolidated into this map (issue #910).',
  permission_policy_set:
    'exercised in packages/protocol/src/v1/permission-policy.test.ts; not yet consolidated into this map (issue #910).',
  permission_policy_violation:
    'exercised in packages/protocol/src/v1/permission-policy.test.ts; not yet consolidated into this map (issue #910).',
  ping: 'exercised in packages/protocol/src/v1/heartbeat.test.ts; not yet consolidated into this map (issue #910).',
  pong: 'exercised in packages/protocol/src/v1/heartbeat.test.ts; not yet consolidated into this map (issue #910).',
  prompt_inject_result:
    'exercised in packages/protocol/src/v1/steering.test.ts; not yet consolidated into this map (issue #910).',
  provision_progress:
    'exercised in packages/protocol/src/v1/provisioning.test.ts; not yet consolidated into this map (issue #910).',
  provision_target_request:
    'exercised in packages/protocol/src/v1/provisioning.test.ts; not yet consolidated into this map (issue #910).',
  provision_target_result:
    'exercised in packages/protocol/src/v1/provisioning.test.ts; not yet consolidated into this map (issue #910).',
  session_archive_request:
    'exercised in packages/protocol/src/v1/session-lifecycle.test.ts; not yet consolidated into this map (issue #910).',
  session_archive_response:
    'exercised in packages/protocol/src/v1/session-lifecycle.test.ts; not yet consolidated into this map (issue #910).',
  session_fork_request:
    'exercised in packages/protocol/src/v1/session-lifecycle.test.ts; not yet consolidated into this map (issue #910).',
  session_fork_response:
    'exercised in packages/protocol/src/v1/session-lifecycle.test.ts; not yet consolidated into this map (issue #910).',
  session_rewind:
    'exercised in packages/protocol/src/v1/rewind.test.ts; not yet consolidated into this map (issue #910).',
  session_rewind_preview:
    'exercised in packages/protocol/src/v1/rewind.test.ts; not yet consolidated into this map (issue #910).',
  session_rewind_preview_result:
    'exercised in packages/protocol/src/v1/rewind.test.ts; not yet consolidated into this map (issue #910).',
  session_rewind_result:
    'exercised in packages/protocol/src/v1/rewind.test.ts; not yet consolidated into this map (issue #910).',
  session_spend_cap_resume:
    'exercised in packages/protocol/src/v1/spend-cap.test.ts; not yet consolidated into this map (issue #910).',
  session_template_list_get:
    'exercised in packages/protocol/src/v1/session-template.test.ts; not yet consolidated into this map (issue #910).',
  session_template_list_result:
    'exercised in packages/protocol/src/v1/session-template.test.ts; not yet consolidated into this map (issue #910).',
  session_template_list_set:
    'exercised in packages/protocol/src/v1/session-template.test.ts; not yet consolidated into this map (issue #910).',
  snippet_list_get:
    'exercised in packages/protocol/src/v1/snippet.test.ts; not yet consolidated into this map (issue #910).',
  snippet_list_result:
    'exercised in packages/protocol/src/v1/snippet.test.ts; not yet consolidated into this map (issue #910).',
  snippet_list_set:
    'exercised in packages/protocol/src/v1/snippet.test.ts; not yet consolidated into this map (issue #910).',
  spend_cap_get:
    'exercised in packages/protocol/src/v1/spend-cap.test.ts; not yet consolidated into this map (issue #910).',
  spend_cap_result:
    'exercised in packages/protocol/src/v1/spend-cap.test.ts; not yet consolidated into this map (issue #910).',
  spend_cap_set:
    'exercised in packages/protocol/src/v1/spend-cap.test.ts; not yet consolidated into this map (issue #910).',
  ssh_discovery_request:
    'exercised in packages/protocol/src/v1/ssh-discovery.test.ts; not yet consolidated into this map (issue #910).',
  ssh_discovery_response:
    'exercised in packages/protocol/src/v1/ssh-discovery.test.ts; not yet consolidated into this map (issue #910).',
  target_fs_list_request:
    'exercised in packages/protocol/src/v1/target-fs.test.ts; not yet consolidated into this map (issue #910).',
  target_fs_list_response:
    'exercised in packages/protocol/src/v1/target-fs.test.ts; not yet consolidated into this map (issue #910).',
  target_update_request:
    'exercised in packages/protocol/src/v1/target-lifecycle.test.ts; not yet consolidated into this map (issue #910).',
  target_update_response:
    'exercised in packages/protocol/src/v1/target-lifecycle.test.ts; not yet consolidated into this map (issue #910).',
  terminal_close:
    'exercised in packages/protocol/src/v1/terminal.test.ts; not yet consolidated into this map (issue #910).',
  terminal_closed:
    'exercised in packages/protocol/src/v1/terminal.test.ts; not yet consolidated into this map (issue #910).',
  terminal_input:
    'exercised in packages/protocol/src/v1/terminal.test.ts; not yet consolidated into this map (issue #910).',
  terminal_open:
    'exercised in packages/protocol/src/v1/terminal.test.ts; not yet consolidated into this map (issue #910).',
  terminal_opened:
    'exercised in packages/protocol/src/v1/terminal.test.ts; not yet consolidated into this map (issue #910).',
  terminal_output:
    'exercised in packages/protocol/src/v1/terminal.test.ts; not yet consolidated into this map (issue #910).',
  terminal_resize:
    'exercised in packages/protocol/src/v1/terminal.test.ts; not yet consolidated into this map (issue #910).',
  terminal_resync_marker:
    'exercised in packages/protocol/src/v1/terminal.test.ts; not yet consolidated into this map (issue #910).',
  tracker_connectivity_status:
    'exercised in packages/protocol/src/v1/tracker-connectivity.test.ts; not yet consolidated into this map (issue #910).',
  tracker_mode_get_request:
    'exercised in packages/protocol/src/v1/tracker.test.ts; not yet consolidated into this map (issue #910).',
  tracker_mode_response:
    'exercised in packages/protocol/src/v1/tracker.test.ts; not yet consolidated into this map (issue #910).',
  tracker_mode_set_request:
    'exercised in packages/protocol/src/v1/tracker.test.ts; not yet consolidated into this map (issue #910).',
  tracker_snapshot_request:
    'exercised in packages/protocol/src/v1/tracker-records.test.ts; not yet consolidated into this map (issue #910).',
  tracker_snapshot_response:
    'exercised in packages/protocol/src/v1/tracker-records.test.ts; not yet consolidated into this map (issue #910).',
  tracker_write_request:
    'exercised in packages/protocol/src/v1/tracker-records.test.ts; not yet consolidated into this map (issue #910).',
  tracker_write_response:
    'exercised in packages/protocol/src/v1/tracker-records.test.ts; not yet consolidated into this map (issue #910).',
};

describe('wireMessageV1', () => {
  it('routes every fixtured v1 message family through the discriminated union', () => {
    for (const [type, message] of Object.entries(messagesByType)) {
      const parsed = wireMessageV1.parse(message);
      expect(parsed.type).toBe(type);
    }
  });

  it('rejects an unknown type discriminator', () => {
    expect(() => wireMessageV1.parse({ type: 'not_a_real_type', protocolVersion: 1 })).toThrow();
  });

  it('rejects a v0-shaped message (missing v1-only fields) even with type reused, e.g. session_list', () => {
    // v0's session_list carries `sessions: SessionMeta[]` directly; v1's carries
    // `{ session, privateEnvelope }[]`. The two unions are independent, but a
    // same-named v0 payload must not slip through the v1 parser.
    const v0Shaped = {
      type: 'session_list',
      protocolVersion: 1,
      sessions: [{ id: 'sess-1', nodeId: 'node-1', title: 'leak' }],
    };
    expect(() => wireMessageV1.parse(v0Shaped)).toThrow();
  });
});

describe('reachability (issue #910)', () => {
  /**
   * A v1 wire message type counts as "reachable" here when all three hold:
   *
   *  1. Registered -- its schema object is a member of `wireMessageV1.options` (the
   *     discriminated union itself) AND that exact same schema object is one of
   *     `schemasV1`'s values (`./index.ts`'s introspection registry). Both are meant to
   *     be exhaustive by design; only the first is actually enforced by the type system
   *     (`z.discriminatedUnion`'s own dispatch table). `schemasV1` is a plain object
   *     literal with no such guarantee -- this is exactly the gap #224 hit:
   *     `github_pat_connect_response` shipped in the union, in `index.ts`'s named
   *     exports, and in the relay's routing table, but was missing from `schemasV1`, and
   *     nothing but a runtime error happening to fire in an unrelated test caught it. The
   *     check below is derived from the union itself, not a hand-written list of type
   *     strings, so a member silently missing from `schemasV1` fails here immediately.
   *  2. Decodable -- a syntactically valid instance parses through `wireMessageV1` and
   *     reports back the same `type` (proven by a fixture in `messagesByType`), or the
   *     type is named in `NOT_YET_FIXTURED` with a reason. Every real member of the union
   *     must appear in exactly one of the two -- a brand-new member in neither fails
   *     immediately, which is the point of deriving this from `wireMessageV1.options`
   *     rather than growing `messagesByType` by convention (or by nobody noticing).
   *  3. Routable -- `packages/relay/src/message-routing.ts`'s `MESSAGE_ROUTES` names
   *     which connection role(s) send the type, or gives an explicit `reason` for a type
   *     that is `'not-routed'` (relay-originated only, e.g. `initialize_result`).
   *     `MESSAGE_ROUTES` is declared as `{ readonly [T in WireMessageV1['type']]:
   *     MessageRoute }` -- a mapped type exhaustive over this exact union -- so a member
   *     without an entry fails `tsc` on `@loombox/relay` before it ever reaches a test.
   *     Not re-checked here since `@loombox/protocol` cannot depend on `@loombox/relay`;
   *     `message-routing.test.ts` closes the runtime half of that guarantee (that the
   *     table's claims match `relay.ts`'s actual `case` labels), and every `'not-routed'`
   *     entry there already carries its own `reason` string -- the "explicit allowlist
   *     with a reason per entry" issue #910 asks for node-internal/relay-only types.
   */
  const allOptions = wireMessageV1.options;
  const allTypes = allOptions.map((option) => option.shape.type.value);

  type UnionMember = (typeof wireMessageV1.options)[number];

  /** Every option in `options` whose exact schema object is absent from `registry`'s values. */
  function findUnregisteredSchemas(
    options: readonly UnionMember[],
    registry: Record<string, unknown>,
  ): string[] {
    const registered = new Set<unknown>(Object.values(registry));
    return options
      .filter((option) => !registered.has(option))
      .map((option) => option.shape.type.value);
  }

  it('has no duplicate type discriminators in the union (sanity check for the derived checks below)', () => {
    expect(new Set(allTypes).size).toBe(allTypes.length);
  });

  it('every wireMessageV1 member is registered in schemasV1', () => {
    expect(findUnregisteredSchemas(allOptions, schemasV1)).toEqual([]);
  });

  it('findUnregisteredSchemas actually catches an absence -- proof that a message missing from a registry fails this test, not a vacuous pass on an already-complete one (issue #910 acceptance)', () => {
    const withoutPresence = Object.fromEntries(
      Object.entries(schemasV1).filter(([key]) => key !== 'presence'),
    );
    expect(findUnregisteredSchemas(allOptions, withoutPresence)).toEqual(['presence']);
  });

  it('every wireMessageV1 member is fixtured or explicitly allowlisted, and never both', () => {
    const fixtured = new Set(Object.keys(messagesByType));
    const allowlisted = new Set(Object.keys(NOT_YET_FIXTURED));
    const uncovered = allTypes.filter((type) => !fixtured.has(type) && !allowlisted.has(type));
    expect(uncovered).toEqual([]);
    // A type in both would be dead weight in the allowlist, silently hiding that it could
    // shrink -- `messagesByType` gaining a fixture for an already-allowlisted type must
    // remove that allowlist entry in the same change, not just add the fixture.
    const inBoth = allTypes.filter((type) => fixtured.has(type) && allowlisted.has(type));
    expect(inBoth).toEqual([]);
  });

  it('NOT_YET_FIXTURED names only real, current union members (no stale entries surviving a rename/removal)', () => {
    const typeSet = new Set<string>(allTypes);
    const stale = Object.keys(NOT_YET_FIXTURED).filter((type) => !typeSet.has(type));
    expect(stale).toEqual([]);
  });
});

describe('parseWireMessageV1', () => {
  it('routes a session_update payload to the right variant', () => {
    const parsed = parseWireMessageV1(messagesByType.session_update);
    expect(parsed.type).toBe('session_update');
    if (parsed.type === 'session_update') {
      expect(parsed.seq).toBe(0);
    }
  });

  it('throws on garbage input', () => {
    expect(() => parseWireMessageV1({ foo: 'bar' })).toThrow();
    expect(() => parseWireMessageV1(null)).toThrow();
    expect(() => parseWireMessageV1('nope')).toThrow();
  });
});

describe('safeParseWireMessageV1', () => {
  it('returns a success result for a valid message', () => {
    const result = safeParseWireMessageV1(messagesByType.presence);
    expect(result.success).toBe(true);
  });

  it('returns a failure result for garbage input, without throwing', () => {
    const result = safeParseWireMessageV1({ nope: true });
    expect(result.success).toBe(false);
  });
});
