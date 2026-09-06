export type AdvancedCapabilityId =
  | "appServer"
  | "sessionRecovery"
  | "approvals"
  | "usageApi"
  | "multiProject"
  | "plugins";

export type AdvancedCapabilityStatus =
  | "available"
  | "experimental"
  | "notConfigured"
  | "notVerified"
  | "disabled"
  | "unavailable";

export interface CapabilityEvidence {
  kind: string;
  detail: string;
}

export interface AdvancedCapability {
  id: AdvancedCapabilityId;
  status: AdvancedCapabilityStatus | string;
  label: string;
  detail: string;
  evidence: CapabilityEvidence[];
}

export interface AdvancedCapabilitiesSnapshot {
  schemaVersion: number;
  source: string;
  collectedAt: number;
  confidence: string;
  capabilities: AdvancedCapability[];
}

export interface Workspace {
  id: string;
  name: string;
  path: string;
  addedAt: number;
  lastUsedAt?: number;
}

export interface WorkspaceSnapshot {
  schemaVersion: number;
  source: string;
  updatedAt: number;
  confidence: string;
  activeProjectPath?: string;
  workspaces: Workspace[];
}

export interface SaveWorkspaceRequest {
  workspace: Pick<Workspace, "id" | "name" | "path">;
  makeActive?: boolean;
}

export interface DeleteWorkspaceRequest {
  id: string;
}

export const capabilityStatusText: Record<string, string> = {
  available: "可用",
  experimental: "实验性",
  notConfigured: "未配置",
  notVerified: "未验证",
  disabled: "默认关闭",
  unavailable: "不可用",
};

export function capabilityStatusLabel(status: string): string {
  return capabilityStatusText[status] ?? "未知状态";
}

export function capabilityTone(status: string): string {
  if (status === "available") return "success";
  if (status === "experimental") return "accent";
  if (status === "disabled" || status === "notConfigured") return "warning";
  if (status === "unavailable") return "error";
  return "neutral";
}

export function browserAdvancedCapabilities(): AdvancedCapabilitiesSnapshot {
  const collectedAt = Date.now();
  const detail = "当前是浏览器预览；不会探测 CLI、连接 App Server 或读取凭据。";
  const entries: Array<[AdvancedCapabilityId, string]> = [
    ["appServer", "App Server"],
    ["sessionRecovery", "会话恢复"],
    ["approvals", "审批"],
    ["usageApi", "Usage API"],
    ["multiProject", "多项目"],
    ["plugins", "插件系统"],
  ];
  return {
    schemaVersion: 1,
    source: "browser.preview",
    collectedAt,
    confidence: "none",
    capabilities: entries.map(([id, label]) => ({
      id,
      status: "unavailable",
      label,
      detail,
      evidence: [{ kind: "preview", detail }],
    })),
  };
}

export function browserWorkspaceSnapshot(): WorkspaceSnapshot {
  const updatedAt = Date.now();
  return {
    schemaVersion: 1,
    source: "browser.preview",
    updatedAt,
    confidence: "none",
    workspaces: [],
  };
}

