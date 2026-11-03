use serverdeck_monitor::parse::Processor;
use std::collections::BTreeMap;

fn payload(overrides: &[(&str, &str)]) -> Vec<u8> {
    let mut data = BTreeMap::from([
        (
            "stat",
            "cpu 100 0 50 800 50 0 0 0 100 0\ncpu0 100 0 50 800 50 0 0 0 100 0\n",
        ),
        (
            "memory",
            "MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 600 kB\nBuffers: 100 kB\nCached: 400 kB\nSReclaimable: 50 kB\nShmem: 50 kB\nSwapTotal: 100 kB\nSwapFree: 60 kB\n",
        ),
        ("uptime", "100.0 90.0"),
        ("boot", "boot-a"),
        ("load", "1.0 2.0 3.0 1/200 20"),
        ("hostname", "test-host"),
        ("kernel", "6.8.0"),
        ("arch", "x86_64"),
        ("os", "PRETTY_NAME=\"Linux fixture\""),
        ("cpuinfo", "model name : real parser fixture"),
        ("time", "2026-11-01T12:00:00+0800 CST"),
        ("timezone", "Asia/Shanghai"),
        ("indices", "eth0 2\nlo 1"),
        (
            "net",
            "Inter-| Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0\n",
        ),
        (
            "addresses",
            "2: eth0 inet 192.0.2.1/24 scope global eth0\n2: eth0 inet6 2001:db8::1/64 scope global",
        ),
        (
            "mounts",
            "1 0 8:1 / / rw - ext4 /dev/sda1 rw\n2 1 8:1 / /bind rw - ext4 /dev/sda1 rw\n3 1 0:1 / /proc rw - proc proc rw\n4 1 8:2 / /space\\040中文 rw - xfs /dev/sdb rw",
        ),
        (
            "df",
            "Filesystem Type 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 ext4 1000 900 50 95% /\n/dev/sdb xfs 2000 100 1900 5% /space 中文\n",
        ),
    ]);
    for (k, v) in overrides {
        data.insert(k, v);
    }
    let mut output = b"SDMON1\0".to_vec();
    for (k, v) in data {
        output.extend_from_slice(k.as_bytes());
        output.push(0);
        output.extend_from_slice(v.as_bytes());
        output.push(0);
        if !["indices", "timezone"].contains(&k) {
            output.extend_from_slice(
                format!(
                    "{k}_code\0{}\0",
                    if k == "addresses" && v == "DENIED" {
                        "1"
                    } else {
                        "0"
                    }
                )
                .as_bytes(),
            );
        }
    }
    output
}
#[test]
fn first_sample_memory_available_swap_and_mount_identity() {
    let sample = Processor::default()
        .ingest(&payload(&[]), 1)
        .expect("sample");
    assert_eq!(sample.cpus[0].usage, None);
    assert_eq!(sample.network[0].receive_rate, None);
    let memory = sample.memory.expect("memory");
    assert_eq!(memory.used, 400 * 1024);
    assert_eq!(memory.available, 600 * 1024);
    assert_eq!(memory.swap_usage, Some(40.0));
    assert_eq!(sample.system.hostname.as_deref(), Some("test-host"));
    assert_eq!(sample.system.cores, Some(1));
    assert_eq!(sample.load, Some([1.0, 2.0, 3.0]));
    assert_eq!(
        sample
            .disks
            .iter()
            .find(|d| d.mount == "/space 中文")
            .expect("space")
            .total,
        Some(2000 * 1024)
    );
    assert_eq!(
        sample
            .disks
            .iter()
            .find(|d| d.mount == "/bind")
            .expect("bind")
            .duplicate_of
            .as_deref(),
        Some("/")
    );
    assert!(
        sample
            .disks
            .iter()
            .find(|d| d.mount == "/proc")
            .expect("proc")
            .pseudo
    );
    assert_eq!(sample.network[0].addresses.len(), 2);
}
#[test]
fn deltas_exclude_guest_and_iowait_and_use_remote_elapsed() {
    let mut p = Processor::default();
    p.ingest(&payload(&[]), 1).expect("baseline");
    let sample = p
        .ingest(
            &payload(&[
                (
                    "stat",
                    "cpu 120 0 60 840 80 0 0 0 10000 0\ncpu0 120 0 60 840 80 0 0 0 10000 0",
                ),
                ("uptime", "105 90"),
                (
                    "net",
                    "head\nhead\neth0: 1500 0 0 0 0 0 0 0 3000 0 0 0 0 0 0 0",
                ),
            ]),
            500000,
        )
        .expect("sample");
    assert_eq!(sample.cpus[0].usage, Some(30.0));
    assert_eq!(sample.cpus[0].iowait, Some(30.0));
    assert_eq!(sample.network[0].receive_rate, Some(100.0));
    assert_eq!(sample.network[0].send_rate, Some(200.0));
}
#[test]
fn iowait_decrease_is_not_wrapped_and_other_rollbacks_are_unknown() {
    let mut p = Processor::default();
    p.ingest(&payload(&[]), 0).expect("base");
    let s = p
        .ingest(
            &payload(&[("stat", "cpu 110 0 50 810 40 0 0 0"), ("uptime", "103")]),
            3000,
        )
        .expect("sample");
    assert_eq!(s.cpus[0].usage, Some(50.0));
    assert_eq!(s.cpus[0].iowait, Some(0.0));
    let s = p
        .ingest(
            &payload(&[("stat", "cpu 2 0 50 820 40 0 0 0"), ("uptime", "106")]),
            6000,
        )
        .expect("sample");
    assert_eq!(s.cpus[0].usage, None);
    assert!(!s.warnings.is_empty());
}
#[test]
fn network_reset_hotplug_index_change_and_implausible_rates_are_pending() {
    for change in [
        "head\nhead\neth0: 2 0 0 0 0 0 0 0 3 0 0 0 0 0 0 0",
        "head\nhead\neth1: 2000 0 0 0 0 0 0 0 3000 0 0 0 0 0 0 0",
        "head\nhead\neth0: 18446744073709551615 0 0 0 0 0 0 0 3 0 0 0 0 0 0 0",
    ] {
        let mut p = Processor::default();
        p.ingest(&payload(&[]), 0).expect("base");
        let s = p
            .ingest(&payload(&[("net", change), ("uptime", "103")]), 3000)
            .expect("sample");
        assert_eq!(s.network[0].receive_rate, None);
    }
    let mut p = Processor::default();
    p.ingest(&payload(&[]), 0).expect("base");
    let s = p
        .ingest(&payload(&[("indices", "eth0 99"), ("uptime", "103")]), 3000)
        .expect("sample");
    assert_eq!(s.network[0].receive_rate, None);
}
#[test]
fn reboot_pause_and_invalid_intervals_reset_baselines() {
    for changes in [
        vec![("uptime", "99")],
        vec![("uptime", "100.01")],
        vec![("uptime", "1000")],
        vec![("uptime", "103"), ("boot", "other-boot")],
    ] {
        let mut p = Processor::default();
        p.ingest(&payload(&[]), 0).expect("base");
        let s = p.ingest(&payload(&changes), 3000).expect("sample");
        assert_eq!(s.rate_status, "reset");
        assert_eq!(s.cpus[0].usage, None);
        assert_eq!(s.network[0].receive_rate, None);
    }
    let mut p = Processor::default();
    p.ingest(&payload(&[]), 0).expect("base");
    p.reset();
    assert_eq!(
        p.ingest(&payload(&[]), 3).expect("resumed").rate_status,
        "initial"
    );
}
#[test]
fn old_kernel_memory_fallback_is_explicit_and_failures_are_not_zero() {
    let raw = payload(&[]);
    let raw = String::from_utf8(raw)
        .expect("UTF8")
        .replace("MemAvailable: 600 kB\n", "");
    let s = Processor::default()
        .ingest(raw.as_bytes(), 1)
        .expect("sample");
    assert!(s.memory.as_ref().expect("memory").approximate);
    assert_eq!(s.memory.expect("memory").available, 600 * 1024);
    assert!(!s.warnings.is_empty());
    let s = Processor::default()
        .ingest(
            &payload(&[
                ("memory", "not a meminfo file"),
                ("stat", "DENIED"),
                ("addresses", "DENIED"),
            ]),
            1,
        )
        .expect("partial");
    assert!(s.memory.is_none());
    assert!(s.cpus.is_empty());
    assert!(s.warnings.len() >= 3);
}
#[test]
fn malformed_truncated_and_duplicate_envelopes_are_rejected() {
    assert!(Processor::default().ingest(b"not a response", 1).is_err());
    assert!(
        Processor::default()
            .ingest(b"SDMON1\0stat\0x\0stat\0y\0", 1)
            .is_err()
    );
    let mut data = payload(&[]);
    data.pop();
    assert!(Processor::default().ingest(&data, 1).is_err());
    let s = Processor::default()
        .ingest(&payload(&[("stat", &"x".repeat(262145))]), 1)
        .expect("partial");
    assert!(s.cpus.is_empty());
    assert!(!s.warnings.is_empty());
}

#[test]
fn disk_images_containers_unavailable_mounts_and_overfull_filesystems_are_explicit() {
    let s=Processor::default().ingest(&payload(&[
        ("mounts","1 0 0:1 / / rw - overlay overlay rw\n2 1 7:1 / /snap/image ro - squashfs /dev/loop0 ro\n3 1 8:9 / /private rw - xfs /dev/sdz rw"),
        ("df","Filesystem Type 1024-blocks Used Available Capacity Mounted on\nsource with spaces overlay 1000 1000 -5 101% /\n")
    ]),1).expect("sample");
    let root = s.disks.iter().find(|d| d.mount == "/").expect("root");
    assert!(root.container);
    assert_eq!(root.available, Some(0));
    assert_eq!(root.usage, Some(101.0));
    assert!(root.error.is_none());
    assert!(
        s.disks
            .iter()
            .find(|d| d.mount == "/snap/image")
            .expect("image")
            .image
    );
    assert!(
        s.disks
            .iter()
            .find(|d| d.mount == "/private")
            .expect("private")
            .error
            .is_some()
    );
    assert!(s.warnings.iter().any(|w| w.starts_with("1 个挂载点")));
}

const DESKTOP_MOUNTS: &str = "1 0 8:1 / / rw - ext4 /dev/sda1 rw\n\
    2 1 0:2 / /run/user/1000/doc rw - fuse.portal portal rw\n\
    3 1 0:3 / /run/user/1000/gvfs rw - fuse.gvfsd-fuse gvfsd-fuse rw\n\
    4 1 0:4 / /run/user/1000/gnome-remote-desktop/cliprdr-WR3kdo rw - fuse grd-fuse-clipboard rw";
const ROOT_DF: &str = "Filesystem Type 1024-blocks Used Available Capacity Mounted on\n\
    /dev/sda1 ext4 1000 500 500 50% /\n";

#[test]
fn desktop_virtual_mounts_without_capacity_do_not_degrade_monitoring() {
    for uid in ["1000", "1001", "65534"] {
        let mounts = DESKTOP_MOUNTS.replace("/1000/", &format!("/{uid}/"));
        let sample = Processor::default()
            .ingest(&payload(&[("mounts", &mounts), ("df", ROOT_DF)]), 1)
            .expect("sample");
        assert!(sample.warnings.is_empty(), "{:?}", sample.warnings);
        assert_eq!(sample.disks.len(), 4);
        let root = &sample.disks[0];
        assert_eq!(root.mount, "/");
        assert!(!root.pseudo);
        assert_eq!(root.total, Some(1000 * 1024));
        assert!(root.error.is_none());
        for disk in &sample.disks[1..] {
            assert!(disk.pseudo, "{}: {}", disk.filesystem, disk.mount);
            assert!(disk.total.is_none());
            assert!(
                disk.error.is_some(),
                "raw unavailability must remain inspectable"
            );
        }
    }
}

#[test]
fn desktop_mount_filter_keeps_real_disks_fuse_storage_and_similar_paths() {
    for (filesystem, mount) in [
        ("ext4", "/data"),
        ("xfs", "/run/user/1000/doc"),
        ("fuse.sshfs", "/run/user/1000/gvfs"),
        ("fuse.rclone", "/run/user/1000/cloud"),
        ("fuse", "/run/user/1000/encrypted"),
        (
            "fuse.sshfs",
            "/run/user/1000/gnome-remote-desktop/cliprdr-WR3kdo",
        ),
        ("ext4", "/run/user/1000/gnome-remote-desktop/cliprdr-WR3kdo"),
        ("fuse", "/run/user/name/gnome-remote-desktop/cliprdr-WR3kdo"),
        ("fuse", "/run/user//gnome-remote-desktop/cliprdr-WR3kdo"),
        ("fuse", "/run/user/1000/gnome-remote-desktop/cliprdr-"),
        (
            "fuse",
            "/run/user/1000/gnome-remote-desktop/cliprdr-WR3kdo/data",
        ),
        ("fuse", "/data/gnome-remote-desktop/cliprdr-WR3kdo"),
    ] {
        let mounts = format!("{DESKTOP_MOUNTS}\n5 1 0:5 / {mount} rw - {filesystem} storage rw");
        let sample = Processor::default()
            .ingest(&payload(&[("mounts", &mounts), ("df", ROOT_DF)]), 1)
            .expect("sample");
        let disk = sample
            .disks
            .iter()
            .find(|d| d.device == "0:5")
            .expect("storage");
        assert!(!disk.pseudo, "{filesystem}: {mount}");
        assert!(disk.error.is_some());
        assert!(disk.total.is_none());
        assert_eq!(sample.warnings, ["1 个挂载点容量不可用，详见磁盘列表"]);
    }
}

#[test]
fn desktop_mount_filter_does_not_suppress_df_command_failures() {
    let raw = String::from_utf8(payload(&[("mounts", DESKTOP_MOUNTS), ("df", ROOT_DF)]))
        .expect("UTF8")
        .replace("df_code\0\x30\0", "df_code\0\x31\0");
    let sample = Processor::default()
        .ingest(raw.as_bytes(), 1)
        .expect("sample");
    assert_eq!(
        sample.warnings,
        ["df：读取失败，可能是权限不足或命令不可用"]
    );
    assert!(sample.disks[0].error.is_none());
    assert_eq!(sample.disks[0].total, Some(1000 * 1024));
}
