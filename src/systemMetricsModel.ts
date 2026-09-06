/**
 * Frontend contract for the local machine signals that are useful while
 * coding.  This module deliberately contains no Tauri, DOM, or OS calls: a
 * native adapter can feed a JSON snapshot into `normalizeSystemMetricsSnapshot`
 * and the UI can render the result without having to guess what a missing
 * value means.
 *
 * Missing values stay `undefined`.  In particular, an unavailable sensor is
 * not represented as zero (zero CPU, zero network traffic, and zero battery
 * are all meaningful values).  The distinction is important for an observer
 * that promises to show real local data.
 */

export type SystemMetricState =
  | "known"
  | "partial"
  | "derived"
  | "unknown"
  | "unavailable"
  | string;

export type CpuThermalState =
  | "nominal"
  | "fair"
  | "serious"
  | "critical"
  | string;

export type MemoryPressure = "normal" | "warning" | "critical" | string;

export type BatteryPowerSource =
  | "battery"
  | "ac"
  | "ups"
  | "unknown"
  | string;

export type NetworkType =
  | "wifi"
  | "ethernet"
  | "cellular"
  | "vpn"
  | "other"
  | string;

export type NetworkStatus =
  | "connected"
  | "limited"
  | "offline"
  | "unavailable"
  | string;

export type BatteryStatus =
  | "charging"
  | "discharging"
  | "full"
  | "unavailable"
  | string;

export interface SystemMetricBase {
  state: SystemMetricState;
  source: string;
  updatedAt: number;
  confidence: string;
  evidence: string[];
}

/** CPU totals and scheduler/load signals. Percentages are in [0, 100]. */
export interface CpuMetrics extends SystemMetricBase {
  usagePercent?: number;
  userPercent?: number;
  systemPercent?: number;
  idlePercent?: number;
  load1m?: number;
  load5m?: number;
  load15m?: number;
  logicalCores?: number;
  physicalCores?: number;
  frequencyGHz?: number;
  processCount?: number;
  /** Aggregate CPU percentage of Codex/Codex-launched processes, if measurable. */
  codexCpuPercent?: number;
  /** Raw process CPU expressed as logical-core equivalents (1.0 = one core). */
  codexCpuCores?: number;
  codexProcessCount?: number;
  thermalState?: CpuThermalState;
  temperatureCelsius?: number;
}

/** Memory pressure is more actionable for builds than a raw used percentage. */
export interface MemoryMetrics extends SystemMetricBase {
  totalBytes?: number;
  usedBytes?: number;
  availableBytes?: number;
  usedPercent?: number;
  pressure?: MemoryPressure;
  swapTotalBytes?: number;
  swapUsedBytes?: number;
  swapUsedPercent?: number;
  pageInsPerSecond?: number;
  pageOutsPerSecond?: number;
  /** Resident memory attributed to Codex/Codex-launched processes, if measurable. */
  codexBytes?: number;
}

/** Storage is scoped to the selected project volume/path, not all disks. */
export interface StorageMetrics extends SystemMetricBase {
  path?: string;
  volumeName?: string;
  mountPoint?: string;
  filesystem?: string;
  kind?: string;
  totalBytes?: number;
  usedBytes?: number;
  availableBytes?: number;
  usedPercent?: number;
  readBytesPerSecond?: number;
  writeBytesPerSecond?: number;
  readTotalBytes?: number;
  writeTotalBytes?: number;
  readOperationsPerSecond?: number;
  writeOperationsPerSecond?: number;
  isReadOnly?: boolean;
}

/** Network rates are instantaneous samples, not lifetime transfer totals. */
export interface NetworkMetrics extends SystemMetricBase {
  /** Operational connectivity state; `state` remains the data-quality state. */
  status?: NetworkStatus;
  connected?: boolean;
  interfaceName?: string;
  defaultRoute?: string;
  networkType?: NetworkType;
  downBytesPerSecond?: number;
  upBytesPerSecond?: number;
  totalReceivedBytes?: number;
  totalTransmittedBytes?: number;
  packetsReceived?: number;
  packetsTransmitted?: number;
  errorsReceived?: number;
  errorsTransmitted?: number;
  latencyMs?: number;
  packetLossPercent?: number;
  wifiSignalPercent?: number;
  activeConnections?: number;
  vpnActive?: boolean;
}

/** Battery absence (`present: false`) is different from an unknown sensor. */
export interface BatteryMetrics extends SystemMetricBase {
  /** Operational battery state; `state` remains the data-quality state. */
  status?: BatteryStatus;
  present?: boolean;
  percent?: number;
  charging?: boolean;
  fullyCharged?: boolean;
  powerSource?: BatteryPowerSource;
  timeRemainingMinutes?: number;
  healthPercent?: number;
  cycleCount?: number;
  temperatureCelsius?: number;
  energyRateW?: number;
  voltageV?: number;
  energyWh?: number;
  energyFullWh?: number;
  energyFullDesignWh?: number;
}

export interface SystemMetricsSnapshot {
  schemaVersion: number;
  source: string;
  updatedAt: number;
  confidence: string;
  state: SystemMetricState;
  cpu: CpuMetrics;
  memory: MemoryMetrics;
  storage: StorageMetrics;
  network: NetworkMetrics;
  battery: BatteryMetrics;
  evidence: string[];
}

/** Short aliases for adapters that call the payload simply `SystemSnapshot`. */
export type SystemSnapshot = SystemMetricsSnapshot;
export type SystemSnapshotInput = SystemMetricsSnapshotInput;

/** Input is intentionally permissive because it sits at a JSON/IPC boundary. */
export type SystemMetricsSnapshotInput = unknown;

export type SystemMetricId = "cpu" | "memory" | "storage" | "network" | "battery";

/** Stable order/labels for settings and the expanded “本机状态” strip. */
export const systemMetricDefinitions = [
  {
    id: "cpu",
    label: "CPU",
    description: "总占用、系统负载、核心数和 Codex 进程占用",
  },
  {
    id: "memory",
    label: "内存",
    description: "已用容量、内存压力、交换空间和 Codex 常驻内存",
  },
  {
    id: "storage",
    label: "项目磁盘",
    description: "当前项目所在卷的可用空间和读写速率",
  },
  {
    id: "network",
    label: "网络",
    description: "连接状态、接口、延迟和上下行速率",
  },
  {
    id: "battery",
    label: "电池",
    description: "电量、充电状态、剩余时间和健康度",
  },
] as const;

export type SystemMetricTone = "neutral" | "positive" | "warning" | "critical";

export interface SystemMetricDisplay {
  id: SystemMetricId;
  label: string;
  value: string;
  detail: string;
  status: string;
  tone: SystemMetricTone;
}

/**
 * A complete, human-readable breakdown for the expanded main-window card.
 * Keeping this in the model means the React surfaces do not each invent a
 * different interpretation of the same native fields.
 */
export interface SystemMetricDetail {
  label: string;
  value: string;
}

const MAX_EVIDENCE = 12;
const MAX_EVIDENCE_CHARS = 512;
const FALLBACK_SOURCE = "system.unknown";
const FALLBACK_CONFIDENCE = "none";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  // Accept numeric strings from command-line adapters, but never coerce null,
  // booleans, or an empty string into zero.
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function nonNegative(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = nonNegative(value);
  return parsed === undefined ? undefined : Math.floor(parsed);
}

function boundedPercent(value: unknown): number | undefined {
  const parsed = nonNegative(value);
  return parsed === undefined ? undefined : Math.min(100, parsed);
}

function boundedTemperature(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  // A broad physical sanity bound prevents a malformed IPC value from
  // dominating the card while retaining valid cold/hot sensor readings.
  return parsed !== undefined && parsed >= -100 && parsed <= 200 ? parsed : undefined;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function optionalText(value: unknown): string | undefined {
  const result = text(value);
  return result || undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function timestamp(value: unknown, fallback: number): number {
  const parsed = nonNegativeInteger(value);
  return parsed === undefined ? fallback : parsed;
}

function evidence(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, MAX_EVIDENCE_CHARS))
    .filter(Boolean)
    .slice(0, MAX_EVIDENCE);
}

function explicitState(value: unknown): SystemMetricState | undefined {
  const state = optionalText(value);
  return state || undefined;
}

function inferState(
  rawState: unknown,
  hasAnyValue: boolean,
  requiredValuesPresent: boolean,
): SystemMetricState {
  const declared = explicitState(rawState);
  // A producer may accidentally leave `state: "known"` behind while the
  // actual value is null.  Downgrade that one claim instead of presenting a
  // misleading live badge. Other explicit states (notably unavailable and
  // unknown) are authoritative and are preserved verbatim.
  if (declared === "known") {
    return !hasAnyValue ? "unknown" : requiredValuesPresent ? "known" : "partial";
  }
  return declared ?? (!hasAnyValue ? "unknown" : requiredValuesPresent ? "known" : "partial");
}

function baseMetric(
  raw: UnknownRecord,
  now: number,
  hasAnyValue: boolean,
  requiredValuesPresent: boolean,
): SystemMetricBase {
  return {
    state: inferState(raw.state, hasAnyValue, requiredValuesPresent),
    source: text(raw.source, FALLBACK_SOURCE),
    updatedAt: timestamp(raw.updatedAt, now),
    confidence: text(raw.confidence, FALLBACK_CONFIDENCE),
    evidence: evidence(raw.evidence),
  };
}

function addIfDefined(target: object, key: string, value: unknown): void {
  if (value !== undefined) (target as Record<string, unknown>)[key] = value;
}

function valuesPresent(values: readonly unknown[]): boolean {
  return values.every((value) => value !== undefined);
}

function hasNormalizedValues(values: readonly unknown[]): boolean {
  // `false` and zero are valid observations; only undefined means that a
  // value could not be normalized from the IPC payload.
  return values.some((value) => value !== undefined);
}

function normalizeCpu(input: unknown, now: number): CpuMetrics {
  const raw = record(input);
  const usagePercent = boundedPercent(raw.usagePercent ?? raw.usage);
  const userPercent = boundedPercent(raw.userPercent);
  const systemPercent = boundedPercent(raw.systemPercent);
  const idlePercent = boundedPercent(raw.idlePercent);
  const load1m = nonNegative(raw.load1m);
  const load5m = nonNegative(raw.load5m);
  const load15m = nonNegative(raw.load15m);
  const logicalCores = nonNegativeInteger(raw.logicalCores ?? raw.coreCount);
  const physicalCores = nonNegativeInteger(raw.physicalCores);
  const frequencyGHz = nonNegative(raw.frequencyGHz);
  const processCount = nonNegativeInteger(raw.processCount);
  const codexCpuPercent = boundedPercent(raw.codexCpuPercent);
  const codexCpuCores = nonNegative(raw.codexCpuCores);
  const codexProcessCount = nonNegativeInteger(raw.codexProcessCount);
  const temperatureCelsius = boundedTemperature(raw.temperatureCelsius);
  const thermalState = optionalText(raw.thermalState);
  const hasAnyValue = hasNormalizedValues([
    usagePercent, userPercent, systemPercent, idlePercent, load1m, load5m,
    load15m, logicalCores, physicalCores, frequencyGHz, processCount,
    codexCpuPercent, codexCpuCores, codexProcessCount, thermalState, temperatureCelsius,
  ]);
  const base = baseMetric(raw, now, hasAnyValue, valuesPresent([usagePercent]));
  const result: CpuMetrics = { ...base };
  addIfDefined(result, "usagePercent", usagePercent);
  addIfDefined(result, "userPercent", userPercent);
  addIfDefined(result, "systemPercent", systemPercent);
  addIfDefined(result, "idlePercent", idlePercent);
  addIfDefined(result, "load1m", load1m);
  addIfDefined(result, "load5m", load5m);
  addIfDefined(result, "load15m", load15m);
  addIfDefined(result, "logicalCores", logicalCores);
  addIfDefined(result, "physicalCores", physicalCores);
  addIfDefined(result, "frequencyGHz", frequencyGHz);
  addIfDefined(result, "processCount", processCount);
  addIfDefined(result, "codexCpuPercent", codexCpuPercent);
  addIfDefined(result, "codexCpuCores", codexCpuCores);
  addIfDefined(result, "codexProcessCount", codexProcessCount);
  addIfDefined(result, "thermalState", thermalState);
  addIfDefined(result, "temperatureCelsius", temperatureCelsius);
  return result;
}

function normalizeMemory(input: unknown, now: number): MemoryMetrics {
  const raw = record(input);
  const totalBytes = nonNegativeInteger(raw.totalBytes);
  const usedBytes = nonNegativeInteger(raw.usedBytes);
  const availableBytes = nonNegativeInteger(raw.availableBytes ?? raw.freeBytes);
  const usedPercent = boundedPercent(raw.usedPercent);
  const pressure = optionalText(raw.pressure);
  const swapTotalBytes = nonNegativeInteger(raw.swapTotalBytes);
  const swapUsedBytes = nonNegativeInteger(raw.swapUsedBytes);
  const swapUsedPercent = boundedPercent(raw.swapUsedPercent);
  const pageInsPerSecond = nonNegative(raw.pageInsPerSecond);
  const pageOutsPerSecond = nonNegative(raw.pageOutsPerSecond);
  const codexBytes = nonNegativeInteger(raw.codexBytes);
  const hasAnyValue = hasNormalizedValues([
    totalBytes, usedBytes, availableBytes, usedPercent, pressure, swapTotalBytes,
    swapUsedBytes, swapUsedPercent, pageInsPerSecond, pageOutsPerSecond, codexBytes,
  ]);
  const base = baseMetric(
    raw,
    now,
    hasAnyValue,
    valuesPresent([totalBytes, usedBytes]),
  );
  const result: MemoryMetrics = { ...base };
  addIfDefined(result, "totalBytes", totalBytes);
  addIfDefined(result, "usedBytes", usedBytes);
  addIfDefined(result, "availableBytes", availableBytes);
  addIfDefined(result, "usedPercent", usedPercent);
  addIfDefined(result, "pressure", pressure);
  addIfDefined(result, "swapTotalBytes", swapTotalBytes);
  addIfDefined(result, "swapUsedBytes", swapUsedBytes);
  addIfDefined(result, "swapUsedPercent", swapUsedPercent);
  addIfDefined(result, "pageInsPerSecond", pageInsPerSecond);
  addIfDefined(result, "pageOutsPerSecond", pageOutsPerSecond);
  addIfDefined(result, "codexBytes", codexBytes);
  return result;
}

function normalizeStorage(input: unknown, now: number): StorageMetrics {
  const raw = record(input);
  const path = optionalText(raw.path);
  const volumeName = optionalText(raw.volumeName);
  const totalBytes = nonNegativeInteger(raw.totalBytes);
  const usedBytes = nonNegativeInteger(raw.usedBytes);
  const availableBytes = nonNegativeInteger(raw.availableBytes ?? raw.freeBytes);
  const usedPercent = boundedPercent(raw.usedPercent);
  const readBytesPerSecond = nonNegative(raw.readBytesPerSecond);
  const writeBytesPerSecond = nonNegative(raw.writeBytesPerSecond);
  const readOperationsPerSecond = nonNegative(raw.readOperationsPerSecond);
  const writeOperationsPerSecond = nonNegative(raw.writeOperationsPerSecond);
  const mountPoint = optionalText(raw.mountPoint);
  const filesystem = optionalText(raw.filesystem);
  const kind = optionalText(raw.kind);
  const readTotalBytes = nonNegativeInteger(raw.readTotalBytes);
  const writeTotalBytes = nonNegativeInteger(raw.writeTotalBytes);
  const isReadOnly = optionalBoolean(raw.isReadOnly);
  const hasAnyValue = hasNormalizedValues([
    path, volumeName, totalBytes, usedBytes, availableBytes, usedPercent,
    readBytesPerSecond, writeBytesPerSecond, readOperationsPerSecond,
    writeOperationsPerSecond, isReadOnly, mountPoint, filesystem, kind,
    readTotalBytes, writeTotalBytes,
  ]);
  const base = baseMetric(
    raw,
    now,
    hasAnyValue,
    valuesPresent([totalBytes, availableBytes]),
  );
  const result: StorageMetrics = { ...base };
  addIfDefined(result, "path", path);
  addIfDefined(result, "volumeName", volumeName);
  addIfDefined(result, "mountPoint", mountPoint);
  addIfDefined(result, "filesystem", filesystem);
  addIfDefined(result, "kind", kind);
  addIfDefined(result, "totalBytes", totalBytes);
  addIfDefined(result, "usedBytes", usedBytes);
  addIfDefined(result, "availableBytes", availableBytes);
  addIfDefined(result, "usedPercent", usedPercent);
  addIfDefined(result, "readBytesPerSecond", readBytesPerSecond);
  addIfDefined(result, "writeBytesPerSecond", writeBytesPerSecond);
  addIfDefined(result, "readTotalBytes", readTotalBytes);
  addIfDefined(result, "writeTotalBytes", writeTotalBytes);
  addIfDefined(result, "readOperationsPerSecond", readOperationsPerSecond);
  addIfDefined(result, "writeOperationsPerSecond", writeOperationsPerSecond);
  addIfDefined(result, "isReadOnly", isReadOnly);
  return result;
}

function normalizeNetwork(input: unknown, now: number): NetworkMetrics {
  const raw = record(input);
  const rawOperationalState = optionalText(raw.status) ?? optionalText(raw.state);
  const operationalState = rawOperationalState === "connected" ||
    rawOperationalState === "limited" || rawOperationalState === "offline" ||
    rawOperationalState === "unavailable"
    ? rawOperationalState
    : undefined;
  const connected = optionalBoolean(raw.connected) ??
    (operationalState === "connected" || operationalState === "limited"
      ? true
      : operationalState === "offline"
        ? false
        : undefined);
  const interfaceName = optionalText(raw.interfaceName);
  const networkType = optionalText(raw.networkType);
  const defaultRoute = optionalText(raw.defaultRoute);
  const downBytesPerSecond = nonNegative(raw.downBytesPerSecond ?? raw.downloadBytesPerSecond);
  const upBytesPerSecond = nonNegative(raw.upBytesPerSecond ?? raw.uploadBytesPerSecond);
  const totalReceivedBytes = nonNegativeInteger(raw.totalReceivedBytes);
  const totalTransmittedBytes = nonNegativeInteger(raw.totalTransmittedBytes);
  const packetsReceived = nonNegativeInteger(raw.packetsReceived);
  const packetsTransmitted = nonNegativeInteger(raw.packetsTransmitted);
  const errorsReceived = nonNegativeInteger(raw.errorsReceived);
  const errorsTransmitted = nonNegativeInteger(raw.errorsTransmitted);
  const latencyMs = nonNegative(raw.latencyMs);
  const packetLossPercent = boundedPercent(raw.packetLossPercent);
  const wifiSignalPercent = boundedPercent(raw.wifiSignalPercent);
  const activeConnections = nonNegativeInteger(raw.activeConnections);
  const vpnActive = optionalBoolean(raw.vpnActive);
  const hasAnyValue = hasNormalizedValues([
    operationalState, connected, interfaceName, networkType, downBytesPerSecond,
    upBytesPerSecond, latencyMs, packetLossPercent, wifiSignalPercent,
    activeConnections, vpnActive, defaultRoute, totalReceivedBytes,
    totalTransmittedBytes, packetsReceived, packetsTransmitted,
    errorsReceived, errorsTransmitted,
  ]);
  const baseInput = operationalState === "connected" || operationalState === "limited" ||
    operationalState === "offline"
    ? { ...raw, state: raw.status !== undefined ? raw.state : "known" }
    : raw;
  const base = baseMetric(baseInput, now, hasAnyValue, valuesPresent([connected]));
  const result: NetworkMetrics = { ...base };
  addIfDefined(result, "status", operationalState ?? optionalText(raw.status));
  addIfDefined(result, "connected", connected);
  addIfDefined(result, "interfaceName", interfaceName);
  addIfDefined(result, "defaultRoute", defaultRoute);
  addIfDefined(result, "networkType", networkType);
  addIfDefined(result, "downBytesPerSecond", downBytesPerSecond);
  addIfDefined(result, "upBytesPerSecond", upBytesPerSecond);
  addIfDefined(result, "totalReceivedBytes", totalReceivedBytes);
  addIfDefined(result, "totalTransmittedBytes", totalTransmittedBytes);
  addIfDefined(result, "packetsReceived", packetsReceived);
  addIfDefined(result, "packetsTransmitted", packetsTransmitted);
  addIfDefined(result, "errorsReceived", errorsReceived);
  addIfDefined(result, "errorsTransmitted", errorsTransmitted);
  addIfDefined(result, "latencyMs", latencyMs);
  addIfDefined(result, "packetLossPercent", packetLossPercent);
  addIfDefined(result, "wifiSignalPercent", wifiSignalPercent);
  addIfDefined(result, "activeConnections", activeConnections);
  addIfDefined(result, "vpnActive", vpnActive);
  return result;
}

function normalizeBattery(input: unknown, now: number): BatteryMetrics {
  const raw = record(input);
  const rawOperationalState = optionalText(raw.status) ?? optionalText(raw.state);
  const operationalState = rawOperationalState === "charging" ||
    rawOperationalState === "discharging" || rawOperationalState === "full" ||
    rawOperationalState === "unavailable"
    ? rawOperationalState
    : undefined;
  const present = optionalBoolean(raw.present) ??
    (operationalState !== undefined && operationalState !== "unavailable" ? true : undefined);
  const percent = boundedPercent(raw.percent ?? raw.levelPercent ?? raw.batteryPercent);
  const charging = optionalBoolean(raw.charging) ??
    (operationalState === "charging" ? true : operationalState === "discharging" ? false : undefined);
  const fullyCharged = optionalBoolean(raw.fullyCharged) ??
    (operationalState === "full" ? true : undefined);
  const powerSource = optionalText(raw.powerSource);
  const timeRemainingMinutes = nonNegative(raw.timeRemainingMinutes);
  const healthPercent = boundedPercent(raw.healthPercent);
  const cycleCount = nonNegativeInteger(raw.cycleCount);
  const temperatureCelsius = boundedTemperature(raw.temperatureCelsius);
  const energyRateW = nonNegative(raw.energyRateW);
  const voltageV = nonNegative(raw.voltageV);
  const energyWh = nonNegative(raw.energyWh);
  const energyFullWh = nonNegative(raw.energyFullWh);
  const energyFullDesignWh = nonNegative(raw.energyFullDesignWh);
  const hasAnyValue = hasNormalizedValues([
    operationalState, present, percent, charging, fullyCharged, powerSource,
    timeRemainingMinutes, healthPercent, cycleCount, temperatureCelsius,
    energyRateW, voltageV, energyWh, energyFullWh, energyFullDesignWh,
  ]);
  const baseInput = operationalState === "unavailable" || operationalState !== undefined
    ? { ...raw, state: operationalState === "unavailable" ? "unavailable" : "known" }
    : raw;
  const base = baseMetric(baseInput, now, hasAnyValue, valuesPresent([present]));
  const result: BatteryMetrics = { ...base };
  addIfDefined(result, "status", operationalState ?? optionalText(raw.status));
  addIfDefined(result, "present", present);
  addIfDefined(result, "percent", percent);
  addIfDefined(result, "charging", charging);
  addIfDefined(result, "fullyCharged", fullyCharged);
  addIfDefined(result, "powerSource", powerSource);
  addIfDefined(result, "timeRemainingMinutes", timeRemainingMinutes);
  addIfDefined(result, "healthPercent", healthPercent);
  addIfDefined(result, "cycleCount", cycleCount);
  addIfDefined(result, "temperatureCelsius", temperatureCelsius);
  addIfDefined(result, "energyRateW", energyRateW);
  addIfDefined(result, "voltageV", voltageV);
  addIfDefined(result, "energyWh", energyWh);
  addIfDefined(result, "energyFullWh", energyFullWh);
  addIfDefined(result, "energyFullDesignWh", energyFullDesignWh);
  return result;
}

/**
 * Normalize an IPC payload into a stable, display-safe snapshot. The function
 * is total: malformed/null input yields five explicit unknown metric objects.
 */
export function normalizeSystemMetricsSnapshot(
  input: SystemMetricsSnapshotInput,
  now = Date.now(),
): SystemMetricsSnapshot {
  const raw = record(input);
  const cpu = normalizeCpu(raw.cpu, now);
  const memory = normalizeMemory(raw.memory, now);
  const storage = normalizeStorage(raw.storage, now);
  const network = normalizeNetwork(raw.network, now);
  const battery = normalizeBattery(raw.battery, now);
  const metrics = [cpu, memory, storage, network, battery];
  const explicit = explicitState(raw.state);
  const inferredState = metrics.every((metric) => metric.state === "unknown")
    ? "unknown"
    : metrics.every((metric) => metric.state === "known")
      ? "known"
      : "partial";
  // As with an individual metric, a stale top-level `known` marker must not
  // override five empty child snapshots.
  const state = explicit === "known"
    ? inferredState
    : explicit ?? inferredState;
  return {
    schemaVersion: nonNegativeInteger(raw.schemaVersion) ?? 1,
    source: text(raw.source, FALLBACK_SOURCE),
    updatedAt: timestamp(raw.updatedAt, now),
    confidence: text(raw.confidence, FALLBACK_CONFIDENCE),
    state,
    cpu,
    memory,
    storage,
    network,
    battery,
    evidence: evidence(raw.evidence),
  };
}

/** Alias kept deliberately tiny so a Tauri adapter can use its preferred name. */
export const normalizeSystemSnapshot = normalizeSystemMetricsSnapshot;

/** Browser/SSR fallback. It intentionally does not pretend to know the host. */
export function browserSystemMetricsSnapshot(now = Date.now()): SystemMetricsSnapshot {
  return normalizeSystemMetricsSnapshot(
    {
      schemaVersion: 1,
      source: "browser.preview",
      updatedAt: now,
      confidence: "none",
      state: "unknown",
      evidence: ["浏览器预览没有本机系统资源采集器，不会伪造 CPU、内存、磁盘、网络或电池数据。"],
    },
    now,
  );
}

export const browserSystemSnapshot = browserSystemMetricsSnapshot;

export function systemMetricStateLabel(state: SystemMetricState): string {
  if (state === "known") return "实时";
  if (state === "partial") return "部分数据";
  if (state === "derived") return "计算值";
  if (state === "unavailable") return "暂不可用";
  return "未知";
}

export function systemMetricTone(state: SystemMetricState): SystemMetricTone {
  if (state === "known" || state === "derived") return "positive";
  if (state === "partial") return "warning";
  return "neutral";
}

function numberFormatter(maximumFractionDigits = 1): Intl.NumberFormat {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits });
}

export function formatSystemPercent(value: number | undefined): string {
  return value === undefined ? "—" : `${numberFormatter(1).format(value)}%`;
}

/** Format bytes using IEC units; this avoids calling decimal MB “MB” by mistake. */
export function formatBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "—";
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  let scaled = value;
  let unitIndex = -1;
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  return `${numberFormatter(scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2).format(scaled)} ${units[unitIndex]}`;
}

export function formatRate(bytesPerSecond: number | undefined): string {
  return bytesPerSecond === undefined ? "—" : `${formatBytes(bytesPerSecond)}/s`;
}

export function formatMilliseconds(milliseconds: number | undefined): string {
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  return `${numberFormatter(0).format(milliseconds)} ms`;
}

export function formatMinutes(minutes: number | undefined): string {
  if (minutes === undefined || !Number.isFinite(minutes) || minutes < 0) return "—";
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded} 分钟`;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
}

function cpuDisplay(metric: CpuMetrics): SystemMetricDisplay {
  const load = metric.load1m === undefined ? "负载未知" : `1 分钟负载 ${numberFormatter(2).format(metric.load1m)}`;
  const cores = metric.logicalCores === undefined ? "核心数未知" : `${metric.logicalCores} 线程`;
  const codex = metric.codexCpuPercent === undefined
    ? "Codex 进程占用未知"
    : `Codex 相关进程 ${formatSystemPercent(metric.codexCpuPercent)}${metric.codexCpuCores === undefined ? "" : `（${numberFormatter(2).format(metric.codexCpuCores)} 核）`}`;
  const detail = `${load} · ${cores} · ${codex}`;
  return {
    id: "cpu",
    label: "CPU",
    value: formatSystemPercent(metric.usagePercent),
    detail,
    status: systemMetricStateLabel(metric.state),
    tone: systemMetricTone(metric.state),
  };
}

function memoryDisplay(metric: MemoryMetrics): SystemMetricDisplay {
  const capacity = metric.usedBytes !== undefined && metric.totalBytes !== undefined
    ? `${formatBytes(metric.usedBytes)} / ${formatBytes(metric.totalBytes)}`
    : "容量未知";
  const pressure = metric.pressure
    ? `压力 ${metric.pressure === "normal" ? "正常" : metric.pressure === "warning" ? "注意" : metric.pressure === "critical" ? "紧张" : metric.pressure}`
    : "压力未知";
  const codex = metric.codexBytes === undefined
    ? "Codex 内存未知"
    : `Codex ${formatBytes(metric.codexBytes)}`;
  return {
    id: "memory",
    label: "内存",
    value: formatSystemPercent(metric.usedPercent),
    detail: `${capacity} · ${pressure} · ${codex}`,
    status: systemMetricStateLabel(metric.state),
    tone: systemMetricTone(metric.state),
  };
}

function storageDisplay(metric: StorageMetrics): SystemMetricDisplay {
  const volume = metric.volumeName || metric.mountPoint || metric.path || "项目磁盘";
  const capacity = metric.availableBytes === undefined
    ? "可用空间未知"
    : `可用 ${formatBytes(metric.availableBytes)}`;
  const io = metric.readBytesPerSecond === undefined && metric.writeBytesPerSecond === undefined
    ? "I/O 未采样"
    : `读 ${formatRate(metric.readBytesPerSecond)} · 写 ${formatRate(metric.writeBytesPerSecond)}`;
  const kind = metric.kind && metric.kind !== "Unknown" ? ` · ${metric.kind}` : "";
  return {
    id: "storage",
    label: "磁盘",
    value: formatSystemPercent(metric.usedPercent),
    detail: `${volume}${kind} · ${capacity} · ${io}`,
    status: systemMetricStateLabel(metric.state),
    tone: systemMetricTone(metric.state),
  };
}

function networkDisplay(metric: NetworkMetrics): SystemMetricDisplay {
  const connection = metric.connected === undefined
    ? "连接未知"
    : metric.connected
      ? metric.interfaceName || "已连接"
      : "未连接";
  const latency = metric.latencyMs === undefined ? "延迟未知" : `延迟 ${formatMilliseconds(metric.latencyMs)}`;
  const traffic = `↓ ${formatRate(metric.downBytesPerSecond)} · ↑ ${formatRate(metric.upBytesPerSecond)}`;
  const errors = metric.errorsReceived === undefined && metric.errorsTransmitted === undefined
    ? "错误未知"
    : `错误 ${metric.errorsReceived === undefined ? "—" : metric.errorsReceived}/${metric.errorsTransmitted === undefined ? "—" : metric.errorsTransmitted}`;
  return {
    id: "network",
    label: "网络",
    value: metric.connected === false ? "离线" : metric.connected === true ? "在线" : "—",
    detail: `${connection} · ${latency} · ${traffic} · ${errors}`,
    status: systemMetricStateLabel(metric.state),
    tone: systemMetricTone(metric.state),
  };
}

function batteryDisplay(metric: BatteryMetrics): SystemMetricDisplay {
  if (metric.present === false) {
    return {
      id: "battery",
      label: "电池",
      value: "无电池",
      detail: "当前设备未报告电池",
      status: systemMetricStateLabel(metric.state),
      tone: "neutral",
    };
  }
  const power = metric.charging === true
    ? "充电中"
    : metric.charging === false
      ? "使用电池"
      : "电源状态未知";
  const remaining = metric.timeRemainingMinutes === undefined
    ? "剩余时间未知"
    : `约 ${formatMinutes(metric.timeRemainingMinutes)}`;
  const health = metric.healthPercent === undefined
    ? "健康度未知"
    : `健康度 ${formatSystemPercent(metric.healthPercent)}`;
  const energyPower = metric.energyRateW === undefined
    ? "功率未知"
    : `功率 ${numberFormatter(1).format(metric.energyRateW)} W`;
  return {
    id: "battery",
    label: "电池",
    value: formatSystemPercent(metric.percent),
    detail: `${power} · ${remaining} · ${health} · ${energyPower}`,
    status: systemMetricStateLabel(metric.state),
    tone: systemMetricTone(metric.state),
  };
}

function detailText(value: string | undefined): string {
  return value && value.trim() ? value : "—";
}

function detailNumber(value: number | undefined, digits = 1): string {
  return value === undefined ? "—" : numberFormatter(digits).format(value);
}

function detailPercent(value: number | undefined): string {
  return formatSystemPercent(value);
}

function detailBoolean(value: boolean | undefined, yes: string, no: string): string {
  return value === undefined ? "—" : value ? yes : no;
}

function detailPowerSource(value: BatteryPowerSource | undefined): string {
  if (value === "ac") return "外部电源";
  if (value === "battery") return "电池";
  if (value === "ups") return "UPS";
  return detailText(value);
}

/**
 * Return every useful field that the native collector knows for one metric.
 * The main card keeps this behind a disclosure so the default dashboard stays
 * calm, while a developer can inspect the complete coding-relevant snapshot.
 */
export function systemMetricDetails(
  snapshot: SystemMetricsSnapshot,
  id: SystemMetricId,
): SystemMetricDetail[] {
  switch (id) {
    case "cpu": {
      const metric = snapshot.cpu;
      const codex = metric.codexCpuPercent === undefined
        ? "—"
        : `${detailPercent(metric.codexCpuPercent)}${metric.codexCpuCores === undefined ? "" : ` · ${detailNumber(metric.codexCpuCores, 2)} 核`}`;
      return [
        { label: "系统总占用", value: detailPercent(metric.usagePercent) },
        { label: "Codex 相关进程", value: codex },
        {
          label: "负载（1 / 5 / 15 分钟）",
          value: [metric.load1m, metric.load5m, metric.load15m]
            .map((value) => detailNumber(value, 2))
            .join(" / "),
        },
        {
          label: "核心（逻辑 / 物理）",
          value: `${detailText(metric.logicalCores === undefined ? undefined : `${metric.logicalCores}`)} / ${detailText(metric.physicalCores === undefined ? undefined : `${metric.physicalCores}`)}`,
        },
        { label: "平均频率", value: metric.frequencyGHz === undefined ? "—" : `${detailNumber(metric.frequencyGHz, 2)} GHz` },
        { label: "进程数", value: detailText(metric.processCount === undefined ? undefined : `${metric.processCount}`) },
        { label: "热状态", value: detailText(metric.thermalState) },
      ];
    }
    case "memory": {
      const metric = snapshot.memory;
      const swap = metric.swapUsedBytes === undefined && metric.swapTotalBytes === undefined
        ? "—"
        : `${formatBytes(metric.swapUsedBytes)} / ${formatBytes(metric.swapTotalBytes)}${metric.swapUsedPercent === undefined ? "" : ` · ${detailPercent(metric.swapUsedPercent)}`}`;
      return [
        { label: "已用 / 总量", value: `${formatBytes(metric.usedBytes)} / ${formatBytes(metric.totalBytes)}` },
        { label: "可用", value: formatBytes(metric.availableBytes) },
        { label: "使用率", value: detailPercent(metric.usedPercent) },
        { label: "压力（本地推导）", value: detailText(metric.pressure) },
        { label: "交换空间已用 / 总量", value: swap },
        { label: "Codex 常驻内存", value: formatBytes(metric.codexBytes) },
        { label: "分页读入 / 写出", value: `${detailNumber(metric.pageInsPerSecond)} / ${detailNumber(metric.pageOutsPerSecond)} 页/s` },
      ];
    }
    case "storage": {
      const metric = snapshot.storage;
      const volume = metric.volumeName || metric.mountPoint;
      return [
        { label: "项目路径", value: detailText(metric.path) },
        { label: "所在卷 / 挂载点", value: `${detailText(volume)} · ${detailText(metric.mountPoint)}` },
        { label: "已用 / 总量", value: `${formatBytes(metric.usedBytes)} / ${formatBytes(metric.totalBytes)}` },
        { label: "可用 / 使用率", value: `${formatBytes(metric.availableBytes)} · ${detailPercent(metric.usedPercent)}` },
        { label: "文件系统 / 类型", value: `${detailText(metric.filesystem)} · ${detailText(metric.kind)}` },
        { label: "读 / 写速率", value: `${formatRate(metric.readBytesPerSecond)} / ${formatRate(metric.writeBytesPerSecond)}` },
        { label: "累计读 / 写", value: `${formatBytes(metric.readTotalBytes)} / ${formatBytes(metric.writeTotalBytes)}` },
        { label: "只读卷", value: detailBoolean(metric.isReadOnly, "是", "否") },
      ];
    }
    case "network": {
      const metric = snapshot.network;
      const status = metric.connected === undefined ? undefined : metric.connected ? "在线" : "离线";
      const errors = metric.errorsReceived === undefined && metric.errorsTransmitted === undefined
        ? "—"
        : `${detailText(metric.errorsReceived === undefined ? undefined : `${metric.errorsReceived}`)} / ${detailText(metric.errorsTransmitted === undefined ? undefined : `${metric.errorsTransmitted}`)}`;
      return [
        { label: "连接状态", value: detailText(status) },
        { label: "接口 / 类型", value: `${detailText(metric.interfaceName)} · ${detailText(metric.networkType)}` },
        { label: "默认路由", value: detailText(metric.defaultRoute) },
        { label: "下载 / 上传速率", value: `${formatRate(metric.downBytesPerSecond)} / ${formatRate(metric.upBytesPerSecond)}` },
        { label: "累计接收 / 发送", value: `${formatBytes(metric.totalReceivedBytes)} / ${formatBytes(metric.totalTransmittedBytes)}` },
        { label: "数据包接收 / 发送", value: `${detailText(metric.packetsReceived === undefined ? undefined : `${metric.packetsReceived}`)} / ${detailText(metric.packetsTransmitted === undefined ? undefined : `${metric.packetsTransmitted}`)}` },
        { label: "错误接收 / 发送", value: errors },
        { label: "延迟 / 丢包", value: `${formatMilliseconds(metric.latencyMs)} / ${detailPercent(metric.packetLossPercent)}` },
        { label: "VPN", value: detailBoolean(metric.vpnActive, "已启用", "未启用") },
      ];
    }
    case "battery": {
      const metric = snapshot.battery;
      if (metric.present === false) {
        return [
          { label: "状态", value: "当前设备未报告电池" },
          { label: "采集说明", value: "台式机、外接显示器或部分 UPS 可能没有电池传感器" },
        ];
      }
      const state = metric.fullyCharged
        ? "已充满"
        : metric.charging === true
          ? "充电中"
          : metric.charging === false
            ? "使用电池"
            : undefined;
      const energy = metric.energyWh === undefined && metric.energyFullWh === undefined
        ? "—"
        : `${metric.energyWh === undefined ? "—" : `${detailNumber(metric.energyWh, 1)} Wh`} / ${metric.energyFullWh === undefined ? "—" : `${detailNumber(metric.energyFullWh, 1)} Wh`}`;
      return [
        { label: "电量", value: detailPercent(metric.percent) },
        { label: "状态 / 电源", value: `${detailText(state)} · ${detailPowerSource(metric.powerSource)}` },
        { label: "剩余时间", value: formatMinutes(metric.timeRemainingMinutes) },
        { label: "健康度 / 循环次数", value: `${detailPercent(metric.healthPercent)} · ${detailText(metric.cycleCount === undefined ? undefined : `${metric.cycleCount}`)}` },
        { label: "功率 / 电压", value: `${metric.energyRateW === undefined ? "—" : `${detailNumber(metric.energyRateW, 1)} W`} · ${metric.voltageV === undefined ? "—" : `${detailNumber(metric.voltageV, 2)} V`}` },
        { label: "能量 / 满充能量", value: energy },
        { label: "温度", value: metric.temperatureCelsius === undefined ? "—" : `${detailNumber(metric.temperatureCelsius, 1)} °C` },
      ];
    }
  }
}

export function systemMetricDisplay(
  snapshot: SystemMetricsSnapshot,
  id: SystemMetricId,
): SystemMetricDisplay {
  switch (id) {
    case "cpu":
      return cpuDisplay(snapshot.cpu);
    case "memory":
      return memoryDisplay(snapshot.memory);
    case "storage":
      return storageDisplay(snapshot.storage);
    case "network":
      return networkDisplay(snapshot.network);
    case "battery":
      return batteryDisplay(snapshot.battery);
  }
}

export function systemMetricDisplays(snapshot: SystemMetricsSnapshot): SystemMetricDisplay[] {
  return (["cpu", "memory", "storage", "network", "battery"] as const).map((id) =>
    systemMetricDisplay(snapshot, id),
  );
}
