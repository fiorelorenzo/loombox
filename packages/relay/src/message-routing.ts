import type { WireMessageV1 } from '@loombox/protocol';
/**
 * How the relay disposes of every {@link WireMessageV1} member once it has
 * come in over the wire (SPEC §10, `docs/v1-plan.md`).
 *
 * The three `switch (message.type)` statements in `relay.ts`
 * (`handleDeviceMessage`, `handleNodeMessage`, `handleClientMessage`) are the
 * actual routing — this table doesn't replace them. What it buys (issue
 * #691): the object literal below is typed as a mapped type over
 * `WireMessageV1['type']`, so it must have an entry for every member of the
 * wire union — add a new message type to `@loombox/protocol` without adding
 * a matching entry here and `tsc` fails on this file, not silently at
 * runtime. `message-routing.test.ts` closes the other half of the loop: it
 * reads `relay.ts`'s own source and checks each switch's actual `case`
 * labels against what's declared here, so a `routed` entry that lies about
 * where (or whether) a type is actually cased fails the test suite too.
 */
export type MessageRoute =
  /** Cased in `handleDeviceMessage` — shared device registry/pairing/heartbeat traffic, same handling for a node or a client connection. */
  | { readonly routed: 'device' }
  /** Cased only in `handleNodeMessage` — the relay only ever expects this from a node connection. */
  | { readonly routed: 'node' }
  /** Cased only in `handleClientMessage` — the relay only ever expects this from a client connection. */
  | { readonly routed: 'client' }
  /** Cased in both `handleNodeMessage` and `handleClientMessage` — either role can legitimately send it. */
  | { readonly routed: 'node-and-client' }
  /** Handled by `handleInitialize`, before a `Connection` exists at all — the WS handshake's first frame, never reaches any of the three switches. */
  | { readonly routed: 'handshake' }
  /** Never routed: the relay only ever constructs and sends this itself (a reply/notification); a peer is never expected to send it inbound. */
  | { readonly routed: 'not-routed'; readonly reason: string };

/** Exhaustive over {@link WireMessageV1}'s `type` — see {@link MessageRoute}'s doc comment. */
export const MESSAGE_ROUTES: { readonly [T in WireMessageV1['type']]: MessageRoute } = {
  initialize: { routed: 'handshake' },
  initialize_result: {
    routed: 'not-routed',
    reason:
      'relay-constructed reply to `initialize`, sent by `handleInitialize` — never legitimately arrives inbound.',
  },
  device_register: { routed: 'device' },
  device_revoke: { routed: 'device' },
  device_rotate: { routed: 'device' },
  amk_escrow: { routed: 'device' },
  amk_epoch_fetch_request: { routed: 'device' },
  amk_epoch_fetch_response: { routed: 'device' },
  new_device_bootstrap_request: { routed: 'device' },
  new_device_bootstrap_response: { routed: 'device' },
  qr_pairing_request: { routed: 'device' },
  qr_pairing_response: { routed: 'device' },
  target_announce: { routed: 'node' },
  target_list_request: { routed: 'client' },
  target_list: {
    routed: 'not-routed',
    reason:
      "relay-constructed reply to `target_list_request`, sent by `handleClientMessage`'s own case — never legitimately arrives inbound.",
  },
  target_status: { routed: 'node' },
  session_create: { routed: 'client' },
  session_announce: { routed: 'node' },
  session_resume: { routed: 'client' },
  session_list_request: { routed: 'client' },
  session_list: {
    routed: 'not-routed',
    reason:
      "relay-constructed reply to `session_list_request`, sent by `handleClientMessage`'s own case — never legitimately arrives inbound.",
  },
  session_archive_request: { routed: 'client' },
  session_archive_response: { routed: 'node' },
  session_fork_request: { routed: 'client' },
  session_fork_response: { routed: 'node' },
  session_update: { routed: 'node' },
  prompt_inject: { routed: 'client' },
  permission_request: { routed: 'node' },
  permission_response: { routed: 'client' },
  config_option: { routed: 'client' },
  config_option_result: { routed: 'node' },
  blob_upload: { routed: 'client' },
  blob_ref: { routed: 'node' },
  blob_download: { routed: 'node-and-client' },
  blob_download_response: {
    routed: 'not-routed',
    reason:
      'relay-constructed reply to `blob_download`, sent by `handleBlobDownload` — never legitimately arrives inbound.',
  },
  fs_list_request: { routed: 'client' },
  fs_list_response: { routed: 'node' },
  mcp_prompt_get_request: { routed: 'client' },
  mcp_prompt_get_response: { routed: 'node' },
  fs_read_request: { routed: 'client' },
  fs_read_response: { routed: 'node' },
  git_diff_request: { routed: 'client' },
  git_diff_response: { routed: 'node' },
  target_fs_list_request: { routed: 'client' },
  target_fs_list_response: { routed: 'node' },
  custom_agent_probe_request: { routed: 'client' },
  custom_agent_probe_response: { routed: 'node' },
  terminal_open: { routed: 'client' },
  terminal_opened: { routed: 'node' },
  terminal_input: { routed: 'client' },
  terminal_output: { routed: 'node' },
  terminal_resize: { routed: 'client' },
  terminal_close: { routed: 'client' },
  terminal_closed: { routed: 'node' },
  presence: { routed: 'client' },
  resync_request: { routed: 'client' },
  resync_marker: {
    routed: 'not-routed',
    reason:
      'relay-constructed reply to `resync_request` (or a drop-oldest backpressure notice), sent directly — never legitimately arrives inbound.',
  },
  lease_request: { routed: 'node' },
  lease_result: {
    routed: 'not-routed',
    reason:
      'relay-constructed reply to `lease_request`, sent by `handleLeaseRequest` — never legitimately arrives inbound.',
  },
  lease_release: { routed: 'node' },
  lease_release_result: {
    routed: 'not-routed',
    reason:
      'relay-constructed reply to `lease_release`, sent by `handleLeaseRelease` — never legitimately arrives inbound.',
  },
  attention_hint: { routed: 'node' },
  provision_target_request: { routed: 'client' },
  provision_progress: { routed: 'node' },
  provision_target_result: { routed: 'node' },
  ssh_discovery_request: { routed: 'client' },
  ssh_discovery_response: { routed: 'node' },
  decommission_target_request: { routed: 'client' },
  decommission_target_response: { routed: 'node' },
  target_update_request: { routed: 'client' },
  target_update_response: { routed: 'node' },
  connected_account_announce: { routed: 'node' },
  connected_account_list_request: { routed: 'node-and-client' },
  connected_account_list: {
    routed: 'not-routed',
    reason:
      'relay-constructed reply to `connected_account_list_request`, sent by `sendConnectedAccountList` — never legitimately arrives inbound.',
  },
  test_runner_config_get: { routed: 'client' },
  test_runner_config_set: { routed: 'client' },
  test_runner_config_result: { routed: 'node' },
  test_runner_config_detect: { routed: 'client' },
  test_runner_config_detected: { routed: 'node' },
  github_connect_start_request: { routed: 'client' },
  github_connect_cancel_request: { routed: 'client' },
  github_connect_device_code: { routed: 'node' },
  github_connect_result: { routed: 'node' },
  jira_connect_request: { routed: 'client' },
  jira_connect_response: { routed: 'node' },
  connected_account_disconnect_request: { routed: 'client' },
  connected_account_disconnect_response: { routed: 'node' },
  account_pin_get_request: { routed: 'client' },
  account_pin_set_request: { routed: 'client' },
  account_pin_unset_request: { routed: 'client' },
  account_pin_response: { routed: 'node' },
  account_pin_resolve_request: { routed: 'client' },
  account_pin_resolve_response: { routed: 'node' },
  tracker_mode_get_request: { routed: 'client' },
  tracker_mode_set_request: { routed: 'client' },
  tracker_mode_response: { routed: 'node' },
  tracker_snapshot_request: { routed: 'client' },
  tracker_snapshot_response: { routed: 'node' },
  tracker_write_request: { routed: 'client' },
  tracker_write_response: { routed: 'node' },
  run_start: { routed: 'client' },
  run_started: { routed: 'node' },
  run_output: { routed: 'node' },
  run_exit: { routed: 'node' },
  run_cancel: { routed: 'client' },
  permission_policy_get: { routed: 'client' },
  permission_policy_set: { routed: 'client' },
  permission_policy_result: { routed: 'node' },
  permission_policy_violation: { routed: 'node' },
  spend_cap_get: { routed: 'client' },
  spend_cap_set: { routed: 'client' },
  spend_cap_result: { routed: 'node' },
  session_spend_cap_resume: { routed: 'client' },
  spend_report_request: { routed: 'client' },
  spend_report_response: { routed: 'node' },
  keymap_get_request: { routed: 'client' },
  keymap_set_request: { routed: 'client' },
  keymap_result: {
    routed: 'not-routed',
    reason:
      "relay-constructed reply to `keymap_get_request`/`keymap_set_request`, sent by `handleClientMessage`'s own cases — never legitimately arrives inbound.",
  },
  agent_profile_list_get: { routed: 'client' },
  agent_profile_list_set: { routed: 'client' },
  agent_profile_list_result: { routed: 'node' },
  agent_profile_session_get: { routed: 'client' },
  agent_profile_session_set: { routed: 'client' },
  agent_profile_session_result: { routed: 'node' },
  checkpoint_create: { routed: 'client' },
  checkpoint_result: { routed: 'node' },
  checkpoint_list: { routed: 'client' },
  checkpoint_list_result: { routed: 'node' },
  checkpoint_restore_preview: { routed: 'client' },
  checkpoint_restore_preview_result: { routed: 'node' },
  checkpoint_restore: { routed: 'client' },
  checkpoint_restore_result: { routed: 'node' },
  session_rewind_preview: { routed: 'client' },
  session_rewind_preview_result: { routed: 'node' },
  session_rewind: { routed: 'client' },
  session_rewind_result: { routed: 'node' },
  pr_open_preview_request: { routed: 'client' },
  pr_open_preview_result: { routed: 'node' },
  pr_open_request: { routed: 'client' },
  pr_open_result: { routed: 'node' },
  ping: { routed: 'device' },
  pong: {
    routed: 'not-routed',
    reason:
      "relay-constructed reply to `ping`, sent by `handleDeviceMessage`'s own case — never legitimately arrives inbound.",
  },
};
