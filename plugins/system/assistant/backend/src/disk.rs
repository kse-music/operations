use crate::metrics_types::Disk;
use std::collections::HashMap;

fn is_desktop_fuse(filesystem: &str, mount: &str) -> bool {
    if matches!(filesystem, "fuse.portal" | "fuse.gvfsd-fuse") {
        return true;
    }
    // GNOME clipboard mounts have no FUSE subtype. Keep other FUSE storage monitored.
    if filesystem != "fuse" {
        return false;
    }
    let Some((uid, path)) = mount
        .strip_prefix("/run/user/")
        .and_then(|p| p.split_once('/'))
    else {
        return false;
    };
    !uid.is_empty()
        && uid.bytes().all(|b| b.is_ascii_digit())
        && path
            .strip_prefix("gnome-remote-desktop/cliprdr-")
            .is_some_and(|suffix| !suffix.is_empty() && !suffix.contains('/'))
}

fn unescape(value: &str) -> Option<String> {
    let mut bytes = Vec::new();
    let mut i = 0;
    let source = value.as_bytes();
    while i < source.len() {
        if source[i] == b'\\' {
            let octal = source.get(i + 1..i + 4)?;
            if !octal.iter().all(|b| (b'0'..=b'7').contains(b)) {
                return None;
            }
            let n = (octal[0] - b'0') as u16 * 64
                + (octal[1] - b'0') as u16 * 8
                + (octal[2] - b'0') as u16;
            if n == 0 || n > 255 {
                return None;
            }
            bytes.push(n as u8);
            i += 4;
        } else {
            bytes.push(source[i]);
            i += 1;
        }
    }
    String::from_utf8(bytes).ok()
}
pub fn parse(mountinfo: &str, df: &str, warnings: &mut Vec<String>) -> Vec<Disk> {
    let mut disks = Vec::new();
    for line in mountinfo.lines() {
        if disks.len() >= 2048 {
            warnings.push("挂载点超过 2048 个，磁盘列表不可用".into());
            return vec![];
        }
        let Some((head, tail)) = line.split_once(" - ") else {
            warnings.push("挂载记录格式不兼容".into());
            continue;
        };
        let h = head.split_whitespace().collect::<Vec<_>>();
        let t = tail.split_whitespace().collect::<Vec<_>>();
        if h.len() < 6 || t.len() < 3 {
            warnings.push("挂载记录不完整".into());
            continue;
        }
        let (Some(mount), Some(source)) = (unescape(h[4]), unescape(t[1])) else {
            warnings.push("挂载路径编码不兼容".into());
            continue;
        };
        let filesystem = t[0];
        let pseudo = matches!(
            filesystem,
            "proc"
                | "sysfs"
                | "devtmpfs"
                | "devpts"
                | "tmpfs"
                | "cgroup"
                | "cgroup2"
                | "securityfs"
                | "pstore"
                | "debugfs"
                | "tracefs"
                | "configfs"
                | "fusectl"
                | "mqueue"
                | "hugetlbfs"
                | "autofs"
                | "binfmt_misc"
                | "rpc_pipefs"
                | "nsfs"
                | "efivarfs"
                | "bpf"
        ) || is_desktop_fuse(filesystem, &mount);
        disks.push(Disk {
            mount,
            source,
            filesystem: filesystem.into(),
            device: h[2].into(),
            pseudo,
            image: matches!(filesystem, "squashfs" | "erofs" | "iso9660" | "udf"),
            container: filesystem == "overlay"
                || h[3].contains("/docker/")
                || h[4].contains("/containers/"),
            duplicate_of: None,
            total: None,
            used: None,
            available: None,
            usage: None,
            error: Some("df 未返回该挂载点：可能是伪文件系统、重复挂载、无权限或不可访问".into()),
        });
    }
    // Match the complete decoded mount suffix; never split a path containing spaces.
    for line in df.lines().skip(1) {
        let matched = disks
            .iter()
            .enumerate()
            .filter(|(_, d)| {
                line.strip_suffix(&d.mount)
                    .is_some_and(|p| p.ends_with(char::is_whitespace))
            })
            .max_by_key(|(_, d)| d.mount.len())
            .map(|(i, _)| i);
        let Some(i) = matched else {
            continue;
        };
        let disk = &mut disks[i];
        let prefix = &line[..line.len() - disk.mount.len()];
        let mut fields = prefix.split_whitespace().rev();
        let stats = (|| {
            let usage = fields.next()?.strip_suffix('%')?.parse::<f64>().ok()?;
            let available = u64::try_from(fields.next()?.parse::<i128>().ok()?.max(0))
                .ok()?
                .checked_mul(1024)?;
            let used = super::metrics::number(fields.next()?)?.checked_mul(1024)?;
            let total = super::metrics::number(fields.next()?)?.checked_mul(1024)?;
            if fields.next()? != disk.filesystem
                || total == 0
                || !usage.is_finite()
                || !(0.0..=1000.0).contains(&usage)
                || used > total
                || available > total
            {
                return None;
            }
            Some((total, used, available, usage))
        })();
        if let Some((total, used, available, usage)) = stats {
            disk.total = Some(total);
            disk.used = Some(used);
            disk.available = Some(available);
            disk.usage = Some(usage);
            disk.error = None;
        }
    }
    disks.sort_by_key(|d| (!d.mount.eq("/"), d.mount.len(), d.mount.clone()));
    let mut devices: HashMap<(String, String), String> = HashMap::new();
    for disk in &mut disks {
        if !disk.pseudo {
            let key = (disk.device.clone(), disk.filesystem.clone());
            if let Some(path) = devices.get(&key) {
                disk.duplicate_of = Some(path.clone());
            } else {
                devices.insert(key, disk.mount.clone());
            }
        }
    }
    disks
}
