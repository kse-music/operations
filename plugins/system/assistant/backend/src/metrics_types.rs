use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub hostname: Option<String>,
    pub distribution: Option<String>,
    pub kernel: Option<String>,
    pub architecture: Option<String>,
    pub cpu_model: Option<String>,
    pub cores: Option<usize>,
    pub system_time: Option<String>,
    pub timezone: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuUsage {
    pub name: String,
    pub usage: Option<f64>,
    pub iowait: Option<f64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub total: u64,
    pub used: u64,
    pub available: u64,
    pub usage: f64,
    pub approximate: bool,
    pub swap_total: u64,
    pub swap_used: u64,
    pub swap_usage: Option<f64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    pub mount: String,
    pub source: String,
    pub filesystem: String,
    pub device: String,
    pub pseudo: bool,
    pub image: bool,
    pub container: bool,
    pub duplicate_of: Option<String>,
    pub total: Option<u64>,
    pub used: Option<u64>,
    pub available: Option<u64>,
    pub usage: Option<f64>,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInterface {
    pub name: String,
    pub index: Option<u64>,
    pub addresses: Vec<String>,
    pub received: u64,
    pub sent: u64,
    pub receive_rate: Option<f64>,
    pub send_rate: Option<f64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub sampled_at: u64,
    pub uptime: Option<f64>,
    pub system: SystemInfo,
    pub load: Option<[f64; 3]>,
    pub cpus: Vec<CpuUsage>,
    pub memory: Option<Memory>,
    pub disks: Vec<Disk>,
    pub network: Vec<NetworkInterface>,
    pub warnings: Vec<String>,
    pub rate_status: String,
}
