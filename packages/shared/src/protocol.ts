// Wire protocol shared by the agent (runs on each VM), the hub (the server
// you run once), and the web/PWA client. Kept as plain data types so all
// three sides can import it without pulling in the Claude Agent SDK.

export type ImageAttachment = {
  mediaType: string;
  dataBase64: string;
};

export type PermissionDecision = 'allow' | 'deny';

export type ClaudeAccount = {
  id: string;
  label: string;
};

// ---------- Agent -> Hub ----------

export type AgentHello = {
  type: 'hello';
  agentVersion: string;
  vmName: string;
  hostname: string;
  accounts: ClaudeAccount[];
  sessions: AgentSessionSummary[];
};

export type AgentSessionSummary = {
  sessionId: string;
  cwd: string;
  title: string;
  createdAt: string;
  status: 'active' | 'idle';
  accountId: string;
};

export type AgentSdkMessage = {
  type: 'sdk_message';
  sessionId: string;
  tempId?: string;
  message: unknown; // raw SDKMessage from @anthropic-ai/claude-agent-sdk
};

export type AgentSessionCreated = {
  type: 'session_created';
  tempId: string;
  sessionId: string;
  cwd: string;
  title: string;
  accountId: string;
};

export type AgentSessionEnded = {
  type: 'session_ended';
  sessionId: string;
  reason?: string;
};

export type AgentPermissionRequest = {
  type: 'permission_request';
  sessionId: string;
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  blockedPath?: string;
};

export type AgentError = {
  type: 'error';
  sessionId?: string;
  tempId?: string;
  message: string;
};

export type AgentProjectsList = {
  type: 'projects_list';
  requestId: string;
  projects: string[]; // relative paths under the agent's workspace root
};

export type AgentToHubMessage =
  | AgentHello
  | AgentSdkMessage
  | AgentSessionCreated
  | AgentSessionEnded
  | AgentPermissionRequest
  | AgentError
  | AgentProjectsList;

// ---------- Hub -> Agent ----------

export type McpServerConfig = { type: 'http'; url: string; headers?: Record<string, string> };

export type HubUserInput = {
  type: 'user_input';
  sessionId: string; // real session id, or the tempId for a brand-new chat
  tempId?: string; // set only when sessionId is a not-yet-created chat
  cwd?: string; // used only when starting/resuming a session
  accountId?: string; // used only when starting a brand-new session
  text: string;
  images?: ImageAttachment[];
  mcpServers?: Record<string, McpServerConfig>; // attached by the hub; used only when starting/resuming a session
};

export type HubInterrupt = {
  type: 'interrupt';
  sessionId: string;
};

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type HubSetPermissionMode = {
  type: 'set_permission_mode';
  sessionId: string;
  mode: PermissionMode;
};

export type HubSetModel = {
  type: 'set_model';
  sessionId: string;
  model?: string;
};

export type HubSetEffort = {
  type: 'set_effort';
  sessionId: string;
  effort: EffortLevel | null;
};

export type HubPermissionResponse = {
  type: 'permission_response';
  requestId: string;
  behavior: PermissionDecision;
  message?: string;
};

export type HubListProjects = {
  type: 'list_projects';
  requestId: string;
};

export type HubToAgentMessage =
  | HubUserInput
  | HubInterrupt
  | HubSetPermissionMode
  | HubSetModel
  | HubSetEffort
  | HubPermissionResponse
  | HubListProjects;

// ---------- Hub -> Browser (push channel) ----------

export type BrowserVmStatus = {
  type: 'vm_status';
  vmId: string;
  name: string;
  connected: boolean;
  accounts: ClaudeAccount[];
};

export type BrowserSdkMessage = {
  type: 'sdk_message';
  vmId: string;
  sessionId: string;
  tempId?: string;
  message: unknown;
  createdAt: string;
};

export type BrowserSessionCreated = {
  type: 'session_created';
  vmId: string;
  tempId: string;
  sessionId: string;
  cwd: string;
  title: string;
  accountId: string;
};

export type BrowserSessionEnded = {
  type: 'session_ended';
  vmId: string;
  sessionId: string;
};

export type BrowserPermissionRequest = {
  type: 'permission_request';
  vmId: string;
  sessionId: string;
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  blockedPath?: string;
};

export type BrowserPermissionResolved = {
  type: 'permission_resolved';
  vmId: string;
  sessionId: string;
  requestId: string;
};

export type HubToBrowserMessage =
  | BrowserVmStatus
  | BrowserSdkMessage
  | BrowserSessionCreated
  | BrowserSessionEnded
  | BrowserPermissionRequest
  | BrowserPermissionResolved;

// ---------- REST DTOs ----------

export type VmDto = {
  id: string;
  name: string;
  connected: boolean;
  lastSeenAt: string | null;
  accounts: ClaudeAccount[];
};

export type SessionDto = {
  id: string;
  vmId: string;
  cwd: string;
  title: string;
  createdAt: string;
  lastMessageAt: string;
  status: 'active' | 'idle' | 'ended';
  accountId: string;
};

export type MessageDto = {
  id: number;
  sessionId: string;
  vmId: string;
  message: unknown;
  createdAt: string;
};
