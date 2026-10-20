/** Product copy only. Never pass conversation text, source files, or tool/terminal output here. */
export function uiMessage(value, fallback = 'This action could not be completed. Try again.') {
  // Keep this function self-contained: isolated plugin views receive the same implementation at build time.
  if (value == null || value === '') return value;
  if (typeof value !== 'string') {
    if (typeof value.message !== 'string') return value;
    value = value.message;
  }
  const messages = {
    EACCES: 'Access was denied. Check your permissions and try again.',
    EPERM: 'This action is not permitted. Check your permissions and try again.',
    ENOENT: 'The required file or program could not be found. Check that it exists and try again.',
    ENOSPC: 'There is not enough disk space. Free some space and try again.',
    EROFS: 'This location is read-only. Choose a writable location.',
    EBUSY: 'The file is in use. Close it in other programs and try again.',
    ECONNREFUSED: 'The service could not be reached. Check that it is running and try again.',
    ECONNRESET: 'The connection was interrupted. Check your connection and try again.',
    ENOTFOUND: 'The server could not be found. Check the address and your connection.',
    EAI_AGAIN: 'The server address could not be resolved. Check your connection and try again.',
    ETIMEDOUT: 'The connection timed out. Check your connection and try again.',
    ERR_NETWORK: 'The service could not be reached. Check your connection and try again.',
    ERR_INTERNET_DISCONNECTED: 'You are offline. Connect to the internet and try again.',
    ERR_CONNECTION_REFUSED: 'The service could not be reached. Check that it is running and try again.',
    ABORT_ERR: 'The action was cancelled.',
    APP_PLUGIN_PERMISSION_DENIED: 'The plugin does not have permission to do this. Review its permissions and try again.',
    APP_PLUGIN_SESSION_UNAVAILABLE: 'This conversation is unavailable. Reopen it and try again.',
    APP_PLUGIN_SHUTTING_DOWN: 'The plugin is shutting down. Reopen the view and try again.',
    APP_PLUGIN_HOST_STOPPED: 'The plugin has stopped. Reopen the view and try again.',
    APP_PLUGIN_HOST_UNAVAILABLE: 'The plugin is unavailable. Reopen the view and try again.',
    APP_PLUGIN_STARTUP_CANCELLED: 'Plugin startup was cancelled.',
    APP_PLUGIN_VIEW_READ_ONLY_PREVIEW_REQUIRED: 'Open this plugin in a read-only preview.',
    WORKSPACE_FILE_SEARCH_CANCELLED: 'File search was cancelled.',
    WORKSPACE_FILE_SEARCH_ROOT_UNAVAILABLE: 'The project folder is unavailable. Reopen the project and try again.',
    WORKSPACE_GIT_PROJECT_REQUIRED: 'Open a Git repository to use this action.',
    WORKSPACE_GIT_REVIEW_NO_COMMON_ANCESTOR: 'These branches have no shared history. Choose another comparison.',
    WORKSPACE_GIT_REVIEW_UNAVAILABLE: 'The Git comparison is unavailable. Refresh the repository and try again.',
    WORKSPACE_TEXT_ENCODING_REQUIRED: 'Choose a text encoding to open this file.',
    WORKSPACE_TEXT_DECODE_FAILED: 'This file could not be read with the selected encoding. Choose another encoding.',
    GIT_SETTINGS_FAILED: 'Git settings could not be saved. Check the repository and try again.',
    WORKTREE_SETTINGS_FAILED: 'Worktree settings could not be saved. Check the folder and try again.',
    WORKTREE_NOT_FOUND: 'This worktree could not be found. Refresh the project list.',
    WORKTREE_LOCKED: 'This worktree is locked. Finish the other Git operation and try again.',
    WORKTREE_REMOVE_FAILED: 'The worktree could not be removed. Check the folder and try again.',
    SNAPSHOT_FAILED: 'The recovery snapshot could not be saved. Check disk space and folder permissions.',
    SESSION_ARCHIVE_FAILED: 'The conversation could not be archived. Try again.',
    CHAT_SESSION_OPERATION_FAILED: 'The conversation could not be updated. Reopen it and try again.',
    AUTH_LOGIN_FAILED: 'Sign-in failed. Try signing in again.',
    AUTH_PROFILE_PERSISTENCE_FAILED: 'Your sign-in details could not be saved. Check disk space and try again.',
    BROWSER_OPEN_FAILED: 'The browser could not be opened. Open the link in your browser.',
    USER_DATA_UNAVAILABLE: 'Your application data is unavailable. Check folder access and restart notch.',
    DATABASE_INITIALIZATION_FAILED: 'The application database could not be opened. Check disk space and restart notch.',
    BYOK_API_KEY_REQUIRED: 'Add an API key in model settings to use this provider.',
    BYOK_AUTHENTICATION_FAILED: 'The provider rejected your API key. Check it in model settings.',
    BYOK_SECURE_STORAGE_UNAVAILABLE: 'Secure credential storage is unavailable. Check your system settings.',
    BYOK_SAVE_FAILED: 'The API key could not be saved. Check your system settings and try again.',
    EXTERNAL_MODEL_QUOTA_EXCEEDED: 'Your provider usage limit has been reached. Check your provider account or choose another model.',
    SSH_AUTHENTICATION_FAILED: 'SSH sign-in failed. Check the username and SSH key.',
    SSH_HOST_KEY_FAILED: 'The SSH host identity could not be verified. Check the host fingerprint before reconnecting.',
    SSH_HOST_NOT_FOUND: 'The SSH host could not be found. Check the hostname and your connection.',
    REMOTE_OS_UNSUPPORTED: 'This remote operating system is not supported.',
    REMOTE_ARCH_UNSUPPORTED: 'This remote processor architecture is not supported.',
    REMOTE_SSH_HOST_MISSING: 'Choose an SSH host before connecting.',
    MCP_HTTP_UNAUTHORIZED: 'The tool server requires sign-in. Reconnect it in tool settings.',
    MCP_HTTP_FORBIDDEN: 'The tool server denied access. Check your account permissions.',
    MCP_HTTP_RATE_LIMITED: 'The tool server is receiving too many requests. Wait a moment and try again.',
    MCP_STDIO_EXECUTABLE_NOT_FOUND: 'The tool server program could not be found. Check its command in tool settings.',
    MCP_STDIO_NPX_NOT_FOUND: 'The tool server needs Node.js. Install it and try again.',
    MCP_HTTP_CONNECTION_REFUSED: 'The tool server could not be reached. Check that it is running.',
    MCP_HTTP_REQUEST_TIMEOUT: 'The tool server took too long to respond. Try again.',
    MCP_PROTOCOL_CONNECTION_CLOSED: 'The tool server disconnected. Reconnect it and try again.',
    EXTENSION_AUTH_REQUIRED: 'Sign in to use this extension.',
    EXTENSION_NETWORK_UNAVAILABLE: 'The extension could not connect. Check your connection and try again.',
    FILE_SIZE_LIMIT: 'This file is too large. Choose a smaller file.',
    FILE_UNSUPPORTED_TYPE: 'This file type is not supported. Choose another file.',
    FILE_DISK_SPACE: 'There is not enough disk space for this file. Free some space and try again.',
    FILE_CANCELED: 'The file transfer was cancelled.',
    LIVE_VOICE_HISTORY_RESTORE_FAILED: 'The voice conversation history could not be restored. Start a new voice session.',
  };
  let text = value.trim();
  if (/\b(?:TypeError|ReferenceError|SyntaxError|RangeError):/u.test(text)) return fallback;
  // Electron can wrap a remote error more than once. Remove only the transport envelope.
  text = text.replace(/^(?:Error invoking remote method '[^'\r\n]+':\s*)+/u, '')
    .replace(/^(?:[A-Za-z]*Error:\s*)+/u, '');
  if (!text) return fallback;
  const diagnostics = text.replace(/(?:[A-Za-z]:[\\/]|\.\.?[\\/]|\/)[^\s"'<>]+|\b[\w-]+\.[\w.-]+/gu, '');
  const code = diagnostics.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\b(?:EACCES|EPERM|ENOENT|ENOSPC|EROFS|EBUSY|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT)\b/u)?.[0];
  if (code && Object.hasOwn(messages, code)) return messages[code];
  const identifiers = new Set(['GH_TOKEN', 'GITHUB_TOKEN', 'HF_TOKEN', 'OPENROUTER_API_KEY', 'TAVILY_API_KEY', 'NODE_ENV', 'PATH', 'CUDA_VISIBLE_DEVICES', 'CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN', 'CURSOR_ORIGIN_ENDPOINT', 'ORIGIN_BIN_DIR', 'ORIGIN_INSTALL_DIR']);
  if ((diagnostics.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/gu) ?? []).some(token => !identifiers.has(token))) return fallback;
  if (/^(?:Failed to fetch|fetch failed|NetworkError when attempting to fetch resource\.?|Load failed)$/iu.test(text)) return messages.ERR_NETWORK;
  if (/^(?:AbortError|The operation was aborted\.?|The user aborted a request\.?)$/iu.test(text)) return messages.ABORT_ERR;
  if (/No handler registered for|Cannot (?:read|set) properties of (?:undefined|null)|\bis not (?:a function|defined)\b/u.test(text)) return fallback;
  // Unknown diagnostics, missing translation keys, serialized responses and stack traces are not product copy.
  if (/\p{Script=Han}/u.test(diagnostics) || /\b(?:TypeError|ReferenceError|SyntaxError):|\n\s*at\s|^\s*[{[]|:\s*\{\s*"/u.test(text)
    || /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?:$|\s*[:(])/u.test(text)
    || /^(?:nav|settings|chatSession|chatActivity|workspace|composer|remoteSsh|startup|common|appError|error|cloudAutomation)\.[\w.-]+$/u.test(text)
    || /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/u.test(text)
    || /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/u.test(text)
    || /^[a-z]+(?:[A-Z][a-z0-9]*)+$/u.test(text)
    || /^[A-Z][A-Z0-9_:-]{2,}$/u.test(text)
    || /^(?:undefined|null|\[object Object\])$/u.test(text)) return fallback;
  // Keep actionable English instructions that mention real identifiers such as GH_TOKEN or AGENTS.md.
  return text;
}
