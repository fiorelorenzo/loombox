// The single list of secrets each release-mobile.yml step needs, shared by
// check-secrets.mjs (the explicit pre-flight gate a workflow step runs
// before anything credential-driven) and sign-android.mjs (which re-checks
// its own slice defensively right before writing a keystore to disk, since
// it can also run standalone). One list, not two copies drifting apart.
export const GATES = {
  'android-signing': [
    'ANDROID_KEYSTORE_BASE64',
    'ANDROID_KEYSTORE_PASSWORD',
    'ANDROID_KEY_ALIAS',
    'ANDROID_KEY_PASSWORD',
  ],
  'play-submission': ['PLAY_SERVICE_ACCOUNT_JSON_BASE64'],
  'ios-signing': [
    'APPLE_TEAM_ID',
    'IOS_DIST_CERTIFICATE_BASE64',
    'IOS_DIST_CERTIFICATE_PASSWORD',
    'IOS_PROVISIONING_PROFILE_BASE64',
  ],
  'app-store-submission': [
    'APP_STORE_CONNECT_KEY_ID',
    'APP_STORE_CONNECT_ISSUER_ID',
    'APP_STORE_CONNECT_API_KEY_BASE64',
    'APP_STORE_CONNECT_APPLE_ID',
    'APP_STORE_CONNECT_ASC_PUBLIC_ID',
  ],
};

/** Returns the names in `gate` that are unset in `env` (default `process.env`). */
export function missingSecrets(gate, env = process.env) {
  return GATES[gate].filter((name) => !env[name]);
}
