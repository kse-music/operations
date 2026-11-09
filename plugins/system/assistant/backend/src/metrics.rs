use crate::metrics_types::*;
use std::collections::{BTreeMap, HashMap};

type CpuCounters = BTreeMap<String, [u64; 8]>;
struct Baseline {
    uptime: Option<f64>,
    boot: String,
    cpus: CpuCounters,
    network: Vec<NetworkInterface>,
}
#[derive(Default)]
pub struct Processor {
    previous: Option<Baseline>,
}

pub(crate) fn number(value: &str) -> Option<u64> {
    value.parse().ok()
}
fn finite(value: &str) -> Option<f64> {
    value
        .parse::<f64>()
        .ok()
        .filter(|n| n.is_finite() && *n >= 0.0)
}
fn envelope(data: &[u8]) -> Result<HashMap<&str, &str>, &'static str> {
    let data = std::str::from_utf8(data).map_err(|_| "采集输出不是有效 UTF-8")?;
    let mut parts = data.split('\0');
    if parts.next() != Some("SDMON1") {
        return Err("采集协议头不匹配");
    }
    let mut result = HashMap::new();
    loop {
        let Some(key) = parts.next() else {
            return Err("采集响应缺少结束分隔符");
        };
        if key.is_empty() && parts.next().is_none() {
            break;
        }
        let value = parts.next().ok_or("采集响应不完整")?;
        if key.is_empty()
            || key.len() > 32
            || result.insert(key, value).is_some()
            || result.len() > 48
        {
            return Err("采集字段无效或重复");
        }
    }
    Ok(result)
}
fn section<'a>(
    data: &'a HashMap<&str, &str>,
    key: &str,
    limit: usize,
    warnings: &mut Vec<String>,
) -> Option<&'a str> {
    if data.get(format!("{key}_code").as_str()) != Some(&"0") {
        warnings.push(format!("{key}：读取失败，可能是权限不足或命令不可用"));
        return None;
    }
    match data.get(key).filter(|v| v.len() <= limit) {
        Some(value) => Some(*value),
        None => {
            warnings.push(format!("{key}：缺失或超过采集上限"));
            None
        }
    }
}
fn cpu_counters(data: &str) -> Option<CpuCounters> {
    let mut result = BTreeMap::new();
    for line in data.lines().take_while(|l| l.starts_with("cpu")) {
        let mut parts = line.split_whitespace();
        let name = parts.next()?;
        if name != "cpu"
            && !name
                .strip_prefix("cpu")?
                .chars()
                .all(|c| c.is_ascii_digit())
        {
            return None;
        }
        let values = parts.take(8).map(number).collect::<Option<Vec<_>>>()?;
        if values.len() < 4 || result.len() > 1024 {
            return None;
        }
        let mut counters = [0; 8];
        counters[..values.len()].copy_from_slice(&values);
        if result.insert(name.into(), counters).is_some() {
            return None;
        }
    }
    result.contains_key("cpu").then_some(result)
}
fn cpu_delta(before: &[u64; 8], now: &[u64; 8]) -> Option<(f64, f64)> {
    let mut delta = [0u128; 8];
    for i in 0..8 {
        // Linux explicitly permits iowait to decrease; do not wrap or inflate it.
        delta[i] = if i == 4 {
            now[i].saturating_sub(before[i]) as u128
        } else {
            now[i].checked_sub(before[i])? as u128
        };
    }
    let total = delta.iter().sum::<u128>();
    if total == 0 {
        return None;
    }
    Some((
        (total - delta[3] - delta[4]) as f64 / total as f64 * 100.0,
        delta[4] as f64 / total as f64 * 100.0,
    ))
}
fn memory(data: &str) -> Option<Memory> {
    let mut values = HashMap::new();
    for line in data.lines() {
        let (key, tail) = line.split_once(':')?;
        let mut parts = tail.split_whitespace();
        let count = number(parts.next()?)?;
        let bytes = match parts.next() {
            Some("kB") => count.checked_mul(1024)?,
            None => count,
            _ => return None,
        };
        if values.insert(key, bytes).is_some() {
            return None;
        }
    }
    let total = *values.get("MemTotal")?;
    if total == 0 {
        return None;
    }
    let approximate = !values.contains_key("MemAvailable");
    let available = if let Some(v) = values.get("MemAvailable") {
        *v
    } else {
        values
            .get("MemFree")?
            .checked_add(*values.get("Buffers")?)?
            .checked_add(*values.get("Cached")?)?
            .checked_add(*values.get("SReclaimable")?)?
            .saturating_sub(*values.get("Shmem")?)
    }
    .min(total);
    let swap_total = *values.get("SwapTotal")?;
    let free = *values.get("SwapFree")?;
    if free > swap_total {
        return None;
    }
    Some(Memory {
        total,
        used: total - available,
        available,
        usage: (total - available) as f64 / total as f64 * 100.0,
        approximate,
        swap_total,
        swap_used: swap_total - free,
        swap_usage: (swap_total > 0)
            .then(|| (swap_total - free) as f64 / swap_total as f64 * 100.0),
    })
}
fn network(data: &str, addresses: &str, indices: &str) -> Option<Vec<NetworkInterface>> {
    let mut result = Vec::new();
    let mut names = std::collections::HashSet::new();
    let indices = indices
        .lines()
        .filter_map(|l| l.split_once(' '))
        .filter_map(|(k, v)| Some((k, number(v.trim())?)))
        .collect::<HashMap<_, _>>();
    for line in data.lines().skip(2) {
        let (name, counters) = line.rsplit_once(':')?;
        let name = name.trim();
        let counters = counters
            .split_whitespace()
            .map(number)
            .collect::<Option<Vec<_>>>()?;
        if counters.len() != 16
            || name.is_empty()
            || name.len() > 64
            || result.len() >= 256
            || !names.insert(name.to_owned())
        {
            return None;
        }
        let mut assigned = Vec::new();
        for line in addresses.lines() {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            if fields.len() >= 4
                && fields[1].split('@').next() == Some(name)
                && ["inet", "inet6"].contains(&fields[2])
                && assigned.len() < 32
            {
                assigned.push(fields[3].to_owned());
            }
        }
        result.push(NetworkInterface {
            name: name.into(),
            index: indices.get(name).copied(),
            addresses: assigned,
            received: counters[0],
            sent: counters[8],
            receive_rate: None,
            send_rate: None,
        });
    }
    (!result.is_empty()).then_some(result)
}
fn text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|v| v.chars().take(1024).collect())
}

impl Processor {
    pub fn ingest(&mut self, data: &[u8], sampled_at: u64) -> Result<Sample, &'static str> {
        let data = envelope(data)?;
        let mut warnings = Vec::new();
        let mut read = |key, limit| section(&data, key, limit, &mut warnings);
        let cpu_raw = read("stat", 262144).and_then(cpu_counters);
        let mem = read("memory", 65536).and_then(memory);
        let uptime = read("uptime", 1024)
            .and_then(|s| s.split_whitespace().next())
            .and_then(finite);
        let boot = read("boot", 128).map(str::trim).unwrap_or("").to_owned();
        let load = read("load", 1024).and_then(|s| {
            let v = s
                .split_whitespace()
                .take(3)
                .map(finite)
                .collect::<Option<Vec<_>>>()?;
            v.try_into().ok()
        });
        let hostname = text(read("hostname", 4096));
        let kernel = text(read("kernel", 4096));
        let architecture = text(read("arch", 4096));
        let distribution = read("os", 16384)
            .and_then(|s| s.lines().find_map(|l| l.strip_prefix("PRETTY_NAME=")))
            .map(|s| s.trim_matches('"').trim_matches('\'').to_owned());
        let cpu_model = read("cpuinfo", 65536).and_then(|s| {
            s.lines().find_map(|l| {
                let (k, v) = l.split_once(':')?;
                ["model name", "Hardware", "Processor"]
                    .contains(&k.trim())
                    .then(|| v.trim().to_owned())
            })
        });
        let system_time = text(read("time", 4096));
        let addresses = read("addresses", 131072).unwrap_or("");
        let mut net = read("net", 65536)
            .and_then(|s| network(s, addresses, data.get("indices").unwrap_or(&"")))
            .unwrap_or_default();
        let mounts = read("mounts", 524288).unwrap_or("");
        // df may return useful rows with exit 1; rows without stats retain explicit errors.
        let df = read("df", 262144)
            .or_else(|| data.get("df").filter(|v| v.len() <= 262144).copied())
            .unwrap_or("");
        let disks = crate::disk::parse(mounts, df, &mut warnings);
        let unavailable = disks
            .iter()
            .filter(|d| !d.pseudo && !d.image && d.duplicate_of.is_none() && d.error.is_some())
            .count();
        if unavailable > 0 {
            warnings.push(format!("{unavailable} 个挂载点容量不可用，详见磁盘列表"));
        }
        if cpu_raw.is_none() {
            warnings.push("CPU 计数器缺失或格式不兼容".into());
        }
        if mem.is_none() {
            warnings.push("内存采集失败或格式不兼容".into());
        }
        if mem.as_ref().is_some_and(|m| m.approximate) {
            warnings.push("内存缺少 MemAvailable，使用可回收缓存近似口径".into());
        }
        if uptime.is_none() || load.is_none() {
            warnings.push("Uptime 或负载不可用".into());
        }
        if net.is_empty() {
            warnings.push("网络计数器缺失或格式不兼容".into());
        }
        let elapsed = self
            .previous
            .as_ref()
            .and_then(|p| Some(uptime? - p.uptime?));
        let valid = self
            .previous
            .as_ref()
            .is_some_and(|p| !boot.is_empty() && p.boot == boot)
            && elapsed.is_some_and(|n| (0.1..=120.0).contains(&n));
        let rate_status = if self.previous.is_none() {
            "initial"
        } else if !valid {
            "reset"
        } else {
            "ready"
        }
        .to_owned();
        let counters = cpu_raw.unwrap_or_default();
        let mut cpus = Vec::new();
        for (name, now) in &counters {
            let delta = valid
                .then(|| {
                    self.previous
                        .as_ref()?
                        .cpus
                        .get(name)
                        .and_then(|p| cpu_delta(p, now))
                })
                .flatten();
            if valid && delta.is_none() {
                warnings.push(format!(
                    "{name}：计数器重置、热插拔或无有效差值，等待下一次采样"
                ));
            }
            cpus.push(CpuUsage {
                name: name.clone(),
                usage: delta.map(|v| v.0),
                iowait: delta.map(|v| v.1),
            });
        }
        for interface in &mut net {
            let before = self.previous.as_ref().and_then(|p| {
                p.network.iter().find(|n| {
                    n.name == interface.name && n.index.is_some() && n.index == interface.index
                })
            });
            if valid
                && let Some(before) = before
                && let (Some(rx), Some(tx)) = (
                    interface.received.checked_sub(before.received),
                    interface.sent.checked_sub(before.sent),
                )
            {
                let seconds = elapsed.unwrap_or(1.0);
                let rx = rx as f64 / seconds;
                let tx = tx as f64 / seconds;
                if rx <= 1e12 && tx <= 1e12 {
                    interface.receive_rate = Some(rx);
                    interface.send_rate = Some(tx);
                }
            }
            if valid && interface.receive_rate.is_none() {
                warnings.push(format!(
                    "{}：接口新增、重置或计数异常，速率待计算",
                    interface.name
                ));
            }
        }
        if !valid && self.previous.is_some() {
            warnings.push("采样间隔无效、暂停恢复或服务器重启，差分指标重新计算".into());
        }
        let timezone = text(data.get("timezone").copied())
            .map(|s| s.split("/zoneinfo/").last().unwrap_or(&s).to_owned())
            .or_else(|| {
                system_time
                    .as_ref()
                    .and_then(|s| s.split_whitespace().nth(1).map(str::to_owned))
            });
        let cores = counters.len().checked_sub(1).filter(|n| *n > 0);
        self.previous = Some(Baseline {
            uptime,
            boot,
            cpus: counters,
            network: net.clone(),
        });
        Ok(Sample {
            sampled_at,
            uptime,
            system: SystemInfo {
                hostname,
                distribution,
                kernel,
                architecture,
                cpu_model,
                cores,
                system_time,
                timezone,
            },
            load,
            cpus,
            memory: mem,
            disks,
            network: net,
            warnings,
            rate_status,
        })
    }
}
