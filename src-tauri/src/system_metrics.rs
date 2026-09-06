//! Read-only local machine metrics that are useful while coding.
//!
//! The collector is intentionally separate from Codex usage and task data. It
//! reports the host's CPU, memory, project-volume, battery, and network state;
//! it never turns a missing sensor into zero and it never performs an external
//! bandwidth/latency test. `sysinfo` is kept alive between calls because CPU,
//! network, and disk rates are deltas between samples.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use sysinfo::{
    CpuRefreshKind, Disks, InterfaceOperationalState, MemoryRefreshKind, Networks,
    ProcessRefreshKind, ProcessesToUpdate, System,
};

const SCHEMA_VERSION: u8 = 1;
const SOURCE: &str = "local.sysinfo";
const MIN_CPU_SAMPLE: Duration = Duration::from_millis(220);
const BATTERY_REFRESH_INTERVAL: Duration = Duration::from_secs(30);
const MAX_EVIDENCE: usize = 12;
const MAX_EVIDENCE_CHARS: usize = 512;

/// State shared by all calls from the main window and the widget. Keeping the
/// provider alive is required for meaningful CPU/network/disk deltas.
#[derive(Clone)]
pub struct SystemMetricsState {
    collector: Arc<Mutex<Collector>>,
}

impl Default for SystemMetricsState {
    fn default() -> Self {
        Self {
            collector: Arc::new(Mutex::new(Collector::default())),
        }
    }
}

#[derive(Debug, Default)]
struct Collector {
    system: System,
    networks: Networks,
    disks: Disks,
    last_sample: Option<Instant>,
    last_battery_sample: Option<Instant>,
    battery_snapshot: Option<BatteryMetrics>,
    initialized: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemMetricsRequest {
    pub project_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemMetricsSnapshot {
    pub schema_version: u8,
    pub source: String,
    pub updated_at: u64,
    pub confidence: String,
    pub state: String,
    pub cpu: CpuMetrics,
    pub memory: MemoryMetrics,
    pub storage: StorageMetrics,
    pub network: NetworkMetrics,
    pub battery: BatteryMetrics,
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CpuMetrics {
    pub state: String,
    pub source: String,
    pub updated_at: u64,
    pub confidence: String,
    pub evidence: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load1m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load5m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load15m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logical_cores: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub physical_cores: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frequency_ghz: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex_cpu_percent: Option<f64>,
    /// Raw process CPU expressed as logical-core equivalents (1.0 ≈ one
    /// fully busy logical core). The bounded percentage below is normalized
    /// by host logical cores so it remains comparable with global CPU usage.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex_cpu_cores: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex_process_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thermal_state: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMetrics {
    pub state: String,
    pub source: String,
    pub updated_at: u64,
    pub confidence: String,
    pub evidence: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pressure: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub swap_total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub swap_used_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub swap_used_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StorageMetrics {
    pub state: String,
    pub source: String,
    pub updated_at: u64,
    pub confidence: String,
    pub evidence: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mount_point: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filesystem: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_bytes_per_second: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub write_bytes_per_second: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub write_total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_read_only: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NetworkMetrics {
    pub state: String,
    pub source: String,
    pub updated_at: u64,
    pub confidence: String,
    pub evidence: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connected: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interface_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_route: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub down_bytes_per_second: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub up_bytes_per_second: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_received_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_transmitted_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub packets_received: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub packets_transmitted: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub errors_received: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub errors_transmitted: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub packet_loss_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wifi_signal_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_connections: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vpn_active: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BatteryMetrics {
    pub state: String,
    pub source: String,
    pub updated_at: u64,
    pub confidence: String,
    pub evidence: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub present: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub charging: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fully_charged: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub power_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_remaining_minutes: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cycle_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature_celsius: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub energy_rate_w: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voltage_v: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub energy_wh: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub energy_full_wh: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub energy_full_design_wh: Option<f64>,
}

#[tauri::command]
pub async fn get_system_metrics(
    request: SystemMetricsRequest,
    state: tauri::State<'_, SystemMetricsState>,
) -> Result<SystemMetricsSnapshot, String> {
    let collector = state.collector.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = collector
            .lock()
            .map_err(|_| "系统指标采集器暂时不可用（锁已损坏）。".to_string())?;
        Ok(collect_snapshot(&mut guard, &request.project_path))
    })
    .await
    .map_err(|error| format!("系统指标读取线程异常结束：{error}"))?
}

fn collect_snapshot(collector: &mut Collector, project_path: &str) -> SystemMetricsSnapshot {
    let now = now_millis();
    let first_sample = !collector.initialized;
    let elapsed = collector.last_sample.map(|instant| instant.elapsed());

    if !sysinfo::IS_SUPPORTED_SYSTEM {
        return unavailable_snapshot(now, "当前平台不在 sysinfo 支持范围内。".to_string());
    }

    // CPU values are calculated from a counter delta. sysinfo documents that
    // the first reading is inaccurate, so always warm it up once. Subsequent
    // calls are normally separated by the UI's 3–5 second poll interval.
    collector
        .system
        .refresh_memory_specifics(MemoryRefreshKind::everything());
    collector
        .system
        .refresh_cpu_specifics(CpuRefreshKind::everything());
    collector.system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cpu().with_memory(),
    );
    if first_sample {
        thread::sleep(MIN_CPU_SAMPLE);
        collector
            .system
            .refresh_cpu_specifics(CpuRefreshKind::everything());
        collector.system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_cpu().with_memory(),
        );
    } else if let Some(sample_elapsed) = elapsed {
        if sample_elapsed < MIN_CPU_SAMPLE {
            thread::sleep(MIN_CPU_SAMPLE - sample_elapsed);
            collector
                .system
                .refresh_cpu_specifics(CpuRefreshKind::everything());
            collector.system.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing().with_cpu().with_memory(),
            );
        }
    }

    collector.networks.refresh(!first_sample);
    collector.disks.refresh(!first_sample);

    let cpu = collect_cpu(&collector.system, now);
    let memory = collect_memory(&collector.system, now);
    let storage = collect_storage(&collector.disks, project_path, elapsed, now);
    let network = collect_network(&collector.networks, elapsed, now);
    // Battery/IOKit reads are much more expensive than the in-memory CPU and
    // counter refreshes. Keep the last sensor result for a short, explicit
    // interval; the metric retains its own sample timestamp so the UI can see
    // that it is older than the surrounding host snapshot when appropriate.
    let battery_age = collector.last_battery_sample.map(|sample| sample.elapsed());
    let battery = if collector.battery_snapshot.is_none()
        || battery_age
            .map(|age| age >= BATTERY_REFRESH_INTERVAL)
            .unwrap_or(true)
    {
        let next = collect_battery(now);
        collector.battery_snapshot = Some(next.clone());
        collector.last_battery_sample = Some(Instant::now());
        next
    } else {
        collector
            .battery_snapshot
            .clone()
            .expect("battery snapshot exists after the cache check")
    };

    collector.last_sample = Some(Instant::now());
    collector.initialized = true;

    let metrics_known = [
        cpu.state.as_str(),
        memory.state.as_str(),
        storage.state.as_str(),
        network.state.as_str(),
        battery.state.as_str(),
    ];
    let state = if metrics_known
        .iter()
        .all(|value| *value == "known" || *value == "derived")
    {
        "known"
    } else if metrics_known
        .iter()
        .all(|value| *value == "unknown" || *value == "unavailable")
    {
        "unknown"
    } else {
        "partial"
    };
    let confidence = if state == "known" { "high" } else { "partial" };
    let mut evidence = vec![
        "系统资源来自本机只读采集器；不读取 Codex 登录凭据。".to_string(),
        "网络速率与磁盘 I/O 速率是相邻采样差值，首帧不会伪造 0。".to_string(),
        "电池传感器按约 30 秒缓存一次；卡片会保留电池自身的采样时间。".to_string(),
    ];
    if !project_path.trim().is_empty() {
        evidence.push("磁盘容量对应当前项目所在卷，不代表项目目录本身。".to_string());
    }
    SystemMetricsSnapshot {
        schema_version: SCHEMA_VERSION,
        source: SOURCE.to_string(),
        updated_at: now,
        confidence: confidence.to_string(),
        state: state.to_string(),
        cpu,
        memory,
        storage,
        network,
        battery,
        evidence: trim_evidence(evidence),
    }
}

fn collect_cpu(system: &System, now: u64) -> CpuMetrics {
    let mut evidence = vec![
        "系统 CPU 是主机总体占用，不等于某一个 Codex 任务。".to_string(),
        "Codex 进程值按进程名匹配，可能包含 Codex App Server 与本观察台。".to_string(),
        "Codex CPU 百分比已按逻辑核心数归一化；括号中的核心数保留原始进程总和。".to_string(),
    ];
    let usage = finite_percent(system.global_cpu_usage() as f64);
    let load = System::load_average();
    let load1 = finite_non_negative(load.one);
    let load5 = finite_non_negative(load.five);
    let load15 = finite_non_negative(load.fifteen);
    let logical_cores = (!system.cpus().is_empty()).then_some(system.cpus().len() as u32);
    let physical_cores = System::physical_core_count().and_then(|value| u32::try_from(value).ok());
    let process_count = (!system.processes().is_empty()).then_some(system.processes().len() as u32);
    // A sysinfo process percentage can exceed 100 when it uses multiple
    // cores. Keep the raw sum, then normalize it to the host-wide share.
    let mut codex_cpu_raw_percent = 0.0_f64;
    let mut codex_count = 0_u32;
    let mut frequency_sum = 0_u64;
    let mut frequency_count = 0_u64;
    for cpu in system.cpus() {
        if cpu.frequency() > 0 {
            frequency_sum = frequency_sum.saturating_add(cpu.frequency());
            frequency_count += 1;
        }
    }
    for process in system.processes().values() {
        let name = process.name().to_string_lossy().to_ascii_lowercase();
        if name.contains("codex") {
            let process_cpu = process.cpu_usage() as f64;
            if process_cpu.is_finite() && process_cpu >= 0.0 {
                codex_cpu_raw_percent += process_cpu;
            }
            codex_count = codex_count.saturating_add(1);
        }
    }
    if codex_count == 0 {
        evidence.push(
            "当前没有可按名称匹配到的 Codex 进程；这不代表没有其他编码工具在运行。".to_string(),
        );
    }
    let frequency_ghz =
        (frequency_count > 0).then(|| frequency_sum as f64 / frequency_count as f64 / 1_000.0);
    let codex_cpu_cores = (codex_count > 0).then_some(codex_cpu_raw_percent / 100.0);
    let codex_cpu_percent = (codex_count > 0).then(|| {
        let divisor = logical_cores.unwrap_or(1).max(1) as f64;
        (codex_cpu_raw_percent / divisor).clamp(0.0, 100.0)
    });
    let has_required = usage.is_some();
    CpuMetrics {
        state: if has_required { "known" } else { "unknown" }.to_string(),
        source: SOURCE.to_string(),
        updated_at: now,
        confidence: if has_required { "high" } else { "none" }.to_string(),
        evidence: trim_evidence(evidence),
        usage_percent: usage,
        load1m: load1,
        load5m: load5,
        load15m: load15,
        logical_cores,
        physical_cores,
        frequency_ghz,
        process_count,
        codex_cpu_percent,
        codex_cpu_cores,
        codex_process_count: (codex_count > 0).then_some(codex_count),
        thermal_state: None,
    }
}

fn collect_memory(system: &System, now: u64) -> MemoryMetrics {
    let total = positive_u64(system.total_memory());
    let used = positive_or_zero_u64(system.used_memory(), total.is_some());
    let available = positive_or_zero_u64(system.available_memory(), total.is_some());
    let used_percent = match (used, total) {
        (Some(used), Some(total)) if total > 0 => {
            Some((used as f64 / total as f64 * 100.0).clamp(0.0, 100.0))
        }
        _ => None,
    };
    let swap_total = positive_or_zero_u64(system.total_swap(), true);
    let swap_used = positive_or_zero_u64(system.used_swap(), true);
    let swap_used_percent = match (swap_used, swap_total) {
        (Some(used), Some(total)) if total > 0 => {
            Some((used as f64 / total as f64 * 100.0).clamp(0.0, 100.0))
        }
        _ => None,
    };
    let pressure = available
        .zip(total)
        .filter(|(_, total)| *total > 0)
        .map(|(available, total)| {
            let ratio = available as f64 / total as f64;
            if ratio < 0.10 {
                "critical"
            } else if ratio < 0.20 {
                "warning"
            } else {
                "normal"
            }
        })
        .map(str::to_string);
    let mut codex_bytes = 0_u64;
    let mut codex_count = 0_u32;
    for process in system.processes().values() {
        let name = process.name().to_string_lossy().to_ascii_lowercase();
        if name.contains("codex") {
            codex_bytes = codex_bytes.saturating_add(process.memory());
            codex_count = codex_count.saturating_add(1);
        }
    }
    let mut evidence = vec![
        "内存口径来自 sysinfo；macOS 的 wired、压缩和缓存会影响系统的 used/available 定义。"
            .to_string(),
        "压力是根据 available/total 的本地规则推导，不等同于 macOS Memory Pressure 图表。"
            .to_string(),
    ];
    if codex_count > 0 {
        evidence.push("Codex 内存为匹配到的进程 RSS 总和，不是 Token 或单一任务内存。".to_string());
    }
    MemoryMetrics {
        state: if total.is_some() && used.is_some() {
            "known"
        } else {
            "unknown"
        }
        .to_string(),
        source: SOURCE.to_string(),
        updated_at: now,
        confidence: if total.is_some() && used.is_some() {
            "medium"
        } else {
            "none"
        }
        .to_string(),
        evidence: trim_evidence(evidence),
        total_bytes: total,
        used_bytes: used,
        available_bytes: available,
        used_percent,
        pressure,
        swap_total_bytes: swap_total,
        swap_used_bytes: swap_used,
        swap_used_percent,
        codex_bytes: (codex_count > 0).then_some(codex_bytes),
    }
}

fn collect_storage(
    disks: &Disks,
    requested_path: &str,
    elapsed: Option<Duration>,
    now: u64,
) -> StorageMetrics {
    let requested = requested_path.trim();
    let path = if requested.is_empty() {
        None
    } else {
        let raw = PathBuf::from(requested);
        Some(std::fs::canonicalize(&raw).unwrap_or(raw))
    };
    let Some(path) = path else {
        return unavailable_storage(
            now,
            "尚未选择项目目录，无法确定项目所在磁盘卷。".to_string(),
        );
    };
    let disk = disks
        .list()
        .iter()
        .filter(|disk| path.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().components().count());
    let Some(disk) = disk else {
        return unavailable_storage(now, "sysinfo 没有返回包含该项目路径的挂载卷。".to_string());
    };
    let total = disk.total_space();
    let available = disk.available_space();
    let used = total.saturating_sub(available);
    let used_percent =
        (total > 0).then_some((used as f64 / total as f64 * 100.0).clamp(0.0, 100.0));
    let usage = disk.usage();
    let seconds = elapsed
        .map(|value| value.as_secs_f64())
        .filter(|value| *value >= 0.2);
    let read_rate = seconds.map(|seconds| usage.read_bytes as f64 / seconds);
    let write_rate = seconds.map(|seconds| usage.written_bytes as f64 / seconds);
    let mut evidence =
        vec!["容量对应项目所在卷；读写速率是整个卷/设备的采样估计，不是项目目录 I/O。".to_string()];
    if read_rate.is_none() && write_rate.is_none() {
        evidence.push("I/O 速率将在下一次采样后显示；首帧不填 0。".to_string());
    }
    StorageMetrics {
        state: "known".to_string(),
        source: SOURCE.to_string(),
        updated_at: now,
        confidence: "high".to_string(),
        evidence: trim_evidence(evidence),
        path: Some(path.to_string_lossy().into_owned()),
        volume_name: Some(disk.name().to_string_lossy().into_owned()),
        mount_point: Some(disk.mount_point().to_string_lossy().into_owned()),
        filesystem: Some(disk.file_system().to_string_lossy().into_owned()),
        kind: Some(disk.kind().to_string()),
        total_bytes: Some(total),
        used_bytes: Some(used),
        available_bytes: Some(available),
        used_percent,
        read_bytes_per_second: read_rate,
        write_bytes_per_second: write_rate,
        read_total_bytes: Some(usage.total_read_bytes),
        write_total_bytes: Some(usage.total_written_bytes),
        is_read_only: Some(disk.is_read_only()),
    }
}

fn collect_network(networks: &Networks, elapsed: Option<Duration>, now: u64) -> NetworkMetrics {
    let default_route = default_route_interface();
    let selected = default_route
        .as_deref()
        .and_then(|name| {
            networks
                .list()
                .get(name)
                .map(|data| (name.to_string(), data))
        })
        .or_else(|| {
            networks
                .list()
                .iter()
                .filter(|(name, data)| {
                    !name.starts_with("lo")
                        && !data.ip_networks().is_empty()
                        && potentially_operational(data.operational_state())
                })
                .max_by_key(|(_, data)| {
                    data.total_received()
                        .saturating_add(data.total_transmitted())
                })
                .map(|(name, data)| (name.clone(), data))
        });
    let Some((interface_name, data)) = selected else {
        return NetworkMetrics {
            state: "known".to_string(),
            source: SOURCE.to_string(),
            updated_at: now,
            confidence: "medium".to_string(),
            evidence: trim_evidence(vec![
                "没有发现带 IP 地址的活动网络接口；这只表示当前本机连接状态，不代表互联网可达性。"
                    .to_string(),
            ]),
            status: Some("offline".to_string()),
            connected: Some(false),
            default_route,
            ..NetworkMetrics::default()
        };
    };
    let active =
        potentially_operational(data.operational_state()) && !data.ip_networks().is_empty();
    let seconds = elapsed
        .map(|value| value.as_secs_f64())
        .filter(|value| *value >= 0.2);
    let down_rate = seconds.map(|seconds| data.received() as f64 / seconds);
    let up_rate = seconds.map(|seconds| data.transmitted() as f64 / seconds);
    let network_type = if interface_name.starts_with("utun") {
        Some("vpn".to_string())
    } else {
        None
    };
    let mut evidence = vec![
        "网络状态来自本机接口计数器；已连接不等于互联网/API 一定可达。".to_string(),
        "未自动运行 ping 或 networkQuality，避免外网流量、延迟和权限副作用。".to_string(),
    ];
    if down_rate.is_none() && up_rate.is_none() {
        evidence.push("网络速率将在下一次采样后显示；首帧不填 0。".to_string());
    }
    NetworkMetrics {
        state: "known".to_string(),
        source: SOURCE.to_string(),
        updated_at: now,
        confidence: "high".to_string(),
        evidence: trim_evidence(evidence),
        status: Some(if active { "connected" } else { "offline" }.to_string()),
        connected: Some(active),
        interface_name: Some(interface_name.clone()),
        default_route,
        network_type,
        down_bytes_per_second: down_rate,
        up_bytes_per_second: up_rate,
        total_received_bytes: Some(data.total_received()),
        total_transmitted_bytes: Some(data.total_transmitted()),
        packets_received: Some(data.total_packets_received()),
        packets_transmitted: Some(data.total_packets_transmitted()),
        errors_received: Some(data.total_errors_on_received()),
        errors_transmitted: Some(data.total_errors_on_transmitted()),
        vpn_active: Some(interface_name.starts_with("utun")),
        ..NetworkMetrics::default()
    }
}

#[cfg(target_os = "macos")]
fn collect_battery(now: u64) -> BatteryMetrics {
    use battery::units::{
        electric_potential::volt, energy::watt_hour, power::watt, ratio::percent,
        thermodynamic_temperature::degree_celsius, time::minute,
    };

    let manager = match battery::Manager::new() {
        Ok(manager) => manager,
        Err(error) => {
            return unavailable_battery(
                now,
                format!("电池传感器不可用：{}", redact_error(&error.to_string())),
            );
        }
    };
    let mut batteries = match manager.batteries() {
        Ok(batteries) => batteries,
        Err(error) => {
            return unavailable_battery(
                now,
                format!("电池列表读取失败：{}", redact_error(&error.to_string())),
            );
        }
    };
    let Some(first) = batteries.next() else {
        return BatteryMetrics {
            state: "known".to_string(),
            source: "local.battery".to_string(),
            updated_at: now,
            confidence: "high".to_string(),
            evidence: vec![
                "当前设备没有报告可用电池；台式机、外接显示器或部分 UPS 可能属于此情况。"
                    .to_string(),
            ],
            status: Some("unavailable".to_string()),
            present: Some(false),
            ..BatteryMetrics::default()
        };
    };
    let battery = match first {
        Ok(battery) => battery,
        Err(error) => {
            return unavailable_battery(
                now,
                format!("电池读取失败：{}", redact_error(&error.to_string())),
            );
        }
    };
    let state = battery.state();
    let charging = matches!(state, battery::State::Charging);
    let fully_charged = matches!(state, battery::State::Full);
    let time_remaining = if charging {
        battery.time_to_full()
    } else {
        battery.time_to_empty()
    }
    .map(|value| value.get::<minute>() as f64)
    .filter(|value| value.is_finite() && *value >= 0.0);
    let percent_value = battery.state_of_charge().get::<percent>() as f64;
    let health_value = battery.state_of_health().get::<percent>() as f64;
    let temperature = battery
        .temperature()
        .map(|value| value.get::<degree_celsius>() as f64)
        .filter(|value| value.is_finite());
    let energy_rate = battery.energy_rate().get::<watt>() as f64;
    let voltage = battery.voltage().get::<volt>() as f64;
    let energy = battery.energy().get::<watt_hour>() as f64;
    let energy_full = battery.energy_full().get::<watt_hour>() as f64;
    let energy_full_design = battery.energy_full_design().get::<watt_hour>() as f64;
    let mut evidence =
        vec!["电池数据来自本机 IOKit 适配器；剩余时间是瞬时估计，可能随负载变化。".to_string()];
    if charging || fully_charged {
        evidence.push("当前由外部电源供电或已充满；不会推断构建一定会降频。".to_string());
    } else {
        evidence.push("电池供电可能影响长时间构建，但是否降频取决于系统电源策略。".to_string());
    }
    BatteryMetrics {
        state: "known".to_string(),
        source: "local.battery".to_string(),
        updated_at: now,
        confidence: "medium".to_string(),
        evidence: trim_evidence(evidence),
        status: Some(
            if fully_charged {
                "full"
            } else if charging {
                "charging"
            } else {
                "discharging"
            }
            .to_string(),
        ),
        present: Some(true),
        percent: finite_percent(percent_value),
        charging: Some(charging),
        fully_charged: Some(fully_charged),
        power_source: Some(
            if charging || fully_charged {
                "ac"
            } else {
                "battery"
            }
            .to_string(),
        ),
        time_remaining_minutes: time_remaining,
        health_percent: finite_percent(health_value),
        cycle_count: battery.cycle_count(),
        temperature_celsius: temperature,
        energy_rate_w: finite_non_negative(energy_rate),
        voltage_v: finite_non_negative(voltage),
        energy_wh: finite_non_negative(energy),
        energy_full_wh: finite_non_negative(energy_full),
        energy_full_design_wh: finite_non_negative(energy_full_design),
    }
}

#[cfg(not(target_os = "macos"))]
fn collect_battery(now: u64) -> BatteryMetrics {
    unavailable_battery(now, "当前平台尚未接入电池传感器适配器。".to_string())
}

fn unavailable_snapshot(now: u64, detail: String) -> SystemMetricsSnapshot {
    let cpu = unavailable_cpu(now, detail.clone());
    let memory = unavailable_memory(now, detail.clone());
    let storage = unavailable_storage(now, detail.clone());
    let network = NetworkMetrics {
        state: "unavailable".to_string(),
        source: SOURCE.to_string(),
        updated_at: now,
        confidence: "none".to_string(),
        evidence: vec![detail.clone()],
        status: Some("unavailable".to_string()),
        ..NetworkMetrics::default()
    };
    let battery = unavailable_battery(now, detail.clone());
    SystemMetricsSnapshot {
        schema_version: SCHEMA_VERSION,
        source: SOURCE.to_string(),
        updated_at: now,
        confidence: "none".to_string(),
        state: "unavailable".to_string(),
        cpu,
        memory,
        storage,
        network,
        battery,
        evidence: vec![detail],
    }
}

fn unavailable_cpu(now: u64, detail: String) -> CpuMetrics {
    CpuMetrics {
        state: "unavailable".to_string(),
        source: SOURCE.to_string(),
        updated_at: now,
        confidence: "none".to_string(),
        evidence: vec![detail],
        ..CpuMetrics::default()
    }
}

fn unavailable_memory(now: u64, detail: String) -> MemoryMetrics {
    MemoryMetrics {
        state: "unavailable".to_string(),
        source: SOURCE.to_string(),
        updated_at: now,
        confidence: "none".to_string(),
        evidence: vec![detail],
        ..MemoryMetrics::default()
    }
}

fn unavailable_storage(now: u64, detail: String) -> StorageMetrics {
    StorageMetrics {
        state: "unavailable".to_string(),
        source: SOURCE.to_string(),
        updated_at: now,
        confidence: "none".to_string(),
        evidence: vec![detail],
        ..StorageMetrics::default()
    }
}

fn unavailable_battery(now: u64, detail: String) -> BatteryMetrics {
    BatteryMetrics {
        state: "unavailable".to_string(),
        source: "local.battery".to_string(),
        updated_at: now,
        confidence: "none".to_string(),
        evidence: vec![detail],
        status: Some("unavailable".to_string()),
        ..BatteryMetrics::default()
    }
}

fn default_route_interface() -> Option<String> {
    #[cfg(target_os = "macos")]
    let command = "/sbin/route";
    #[cfg(not(target_os = "macos"))]
    let command = "route";
    let output = std::process::Command::new(command)
        .args(["-n", "get", "default"])
        .env("LC_ALL", "C")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        (key.trim() == "interface")
            .then(|| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

fn potentially_operational(state: InterfaceOperationalState) -> bool {
    matches!(
        state,
        InterfaceOperationalState::Up
            | InterfaceOperationalState::Dormant
            | InterfaceOperationalState::Unknown
    )
}

fn finite_non_negative(value: f64) -> Option<f64> {
    value
        .is_finite()
        .then_some(value)
        .filter(|value| *value >= 0.0)
}

fn finite_percent(value: f64) -> Option<f64> {
    finite_non_negative(value).map(|value| value.clamp(0.0, 100.0))
}

fn positive_u64(value: u64) -> Option<u64> {
    (value > 0).then_some(value)
}

fn positive_or_zero_u64(value: u64, supported: bool) -> Option<u64> {
    supported.then_some(value)
}

fn trim_evidence(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .map(|value| {
            value
                .trim()
                .chars()
                .take(MAX_EVIDENCE_CHARS)
                .collect::<String>()
        })
        .filter(|value| !value.is_empty())
        .take(MAX_EVIDENCE)
        .collect()
}

fn redact_error(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(240)
        .collect()
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn picks_the_longest_mount_prefix() {
        let root = Path::new("/Volumes/dev/project");
        let mount = Path::new("/Volumes/dev");
        assert!(root.starts_with(mount));
        assert!(!Path::new("/Volumes/device/project").starts_with(mount));
    }

    #[test]
    fn percent_helpers_reject_invalid_values() {
        assert_eq!(finite_percent(-1.0), None);
        assert_eq!(finite_percent(f64::NAN), None);
        assert_eq!(finite_percent(120.0), Some(100.0));
    }

    #[test]
    fn evidence_is_bounded() {
        let result = trim_evidence(vec!["x".repeat(1000); 20]);
        assert_eq!(result.len(), MAX_EVIDENCE);
        assert!(result[0].len() <= MAX_EVIDENCE_CHARS);
    }

    #[test]
    fn snapshot_collection_returns_a_schema_even_when_a_sensor_is_missing() {
        let mut collector = Collector::default();
        let snapshot = collect_snapshot(&mut collector, ".");
        assert_eq!(snapshot.schema_version, SCHEMA_VERSION);
        assert!(snapshot.updated_at > 0);
        assert!(!snapshot.evidence.is_empty());

        // This is deliberately a shape assertion rather than a machine-specific
        // value assertion: CI runners may be headless, battery-less, offline,
        // or expose no mounted volume for the requested path.
        let json = serde_json::to_value(snapshot).expect("snapshot must serialize");
        for key in ["cpu", "memory", "storage", "network", "battery"] {
            assert!(json.get(key).is_some(), "missing metric: {key}");
        }
    }
}
