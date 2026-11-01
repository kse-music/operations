use crate::*;
use exec::Outcome;
use std::path::PathBuf;
impl DiagnosticControl {
    fn update(&self, f: impl FnOnce(&mut Diagnostic)) {
        match self.info.lock() {
            Ok(mut i) => {
                f(&mut i);
                i.revision += 1;
            }
            Err(_) => tracing::error!(
                operation = "diagnostic_state",
                "diagnostic state lock poisoned"
            ),
        }
    }
    fn output(&self, s: &str, stderr: bool) {
        if s.is_empty() {
            return;
        }
        self.update(|i| {
            let prefix = if stderr { "[stderr] " } else { "" };
            i.dropped_bytes += append(&mut i.output, &format!("{prefix}{s}"), 256 * 1024);
        });
    }
}
impl Tasks {
    pub fn diagnostic_start(&self, input: DiagnosticInput) -> Result<Diagnostic, Error> {
        input.validate()?;
        if self.stop.is_cancelled() {
            return Err(Error::ShuttingDown);
        }
        tokio::runtime::Handle::try_current()
            .map_err(|_| Error::Validation("诊断必须从异步线程提交"))?;
        if let Origin::Remote {
            host_id,
            session_id,
        } = &input.origin
        {
            self.check_origin(host_id, session_id)?;
        }
        let info = Diagnostic {
            id: uuid::Uuid::new_v4().to_string(),
            input,
            state: "queued".into(),
            output: String::new(),
            dropped_bytes: 0,
            exit_code: None,
            message: None,
            started_at: now(),
            finished_at: None,
            revision: 1,
        };
        let c = Arc::new(DiagnosticControl {
            info: Mutex::new(info.clone()),
            cancel: self.stop.child_token(),
            join: Mutex::new(None),
        });
        {
            let mut ds = lock(&self.diagnostics)?;
            while ds.len() >= 16 {
                if let Some(n) = ds
                    .iter()
                    .position(|d| d.info.lock().is_ok_and(|i| !active(&i.state)))
                {
                    ds.remove(n);
                } else {
                    return Err(Error::Busy);
                }
            }
            ds.push_back(c.clone());
        }
        let service = self.clone();
        let run = c.clone();
        let join = tokio::spawn(async move {
            let permit =
                tokio::select! {p=service.slots.acquire()=>p.ok(),_=run.cancel.cancelled()=>None};
            let result = if permit.is_none() {
                Outcome {
                    state: "cancelled",
                    code: None,
                    message: Some("诊断排队期间取消".into()),
                }
            } else {
                run.update(|i| i.state = "running".into());
                service.diagnose(&run).await
            };
            drop(permit);
            run.update(|i| {
                i.state = result.state.into();
                i.exit_code = result.code;
                i.message = result.message;
                i.finished_at = Some(now());
            });
        });
        *lock(&c.join)? = Some(join);
        Ok(info)
    }
    pub fn diagnostic_list(&self) -> Result<Vec<Diagnostic>, Error> {
        lock(&self.diagnostics)?
            .iter()
            .map(|d| Ok(lock(&d.info)?.clone()))
            .collect()
    }
    pub fn diagnostic_cancel(&self, id: &str) -> Result<(), Error> {
        let c = lock(&self.diagnostics)?
            .iter()
            .find(|d| d.info.lock().is_ok_and(|i| i.id == id))
            .cloned()
            .ok_or(Error::NotFound)?;
        c.cancel.cancel();
        Ok(())
    }
    async fn diagnose(&self, c: &DiagnosticControl) -> Outcome {
        let input = match lock(&c.info) {
            Ok(i) => i.input.clone(),
            Err(_) => return Outcome::failed("诊断状态不可用"),
        };
        let timeout = Duration::from_secs(input.timeout_secs.into());
        let task = async {
            if input.tool == Tool::SshLatency {
                let Origin::Remote { session_id, .. } = &input.origin else {
                    return Outcome::failed("SSH 延迟需要远端来源");
                };
                let total = std::time::Instant::now();
                for n in 0..input.count {
                    let remaining = timeout.saturating_sub(total.elapsed());
                    if remaining.is_zero() {
                        return Outcome::uncertain("SSH 延迟诊断总时限已到");
                    }
                    let start = std::time::Instant::now();
                    let mut marker = String::new();
                    let r = exec::remote(
                        &self.engine,
                        session_id,
                        "printf '__SERVERDECK_LATENCY__'",
                        remaining.as_secs().clamp(1, 300) as u16,
                        &c.cancel,
                        |s, _| {
                            if marker.len() < 128 {
                                marker.push_str(s);
                            }
                        },
                    )
                    .await;
                    if r.state != "completed" {
                        return r;
                    }
                    if marker != "__SERVERDECK_LATENCY__" {
                        return Outcome::failed(
                            "SSH 延迟探针响应不符（可能有非交互 Shell banner）",
                        );
                    }
                    c.output(&format!("sample={} authenticated SSH exec round-trip: {:.3} ms (includes channel + shell scheduling)\n",n+1,start.elapsed().as_secs_f64()*1000.0),false);
                    if n + 1 < input.count {
                        tokio::select! {_=c.cancel.cancelled()=>return Outcome::uncertain("SSH 延迟已取消"),_=tokio::time::sleep(Duration::from_secs(1))=>()}
                    }
                }
                return Outcome::status(Some(0));
            }
            match &input.origin {
                Origin::Remote { session_id, .. } => match remote_command(&input) {
                    Ok(command) => {
                        exec::remote(
                            &self.engine,
                            session_id,
                            &command,
                            input.timeout_secs,
                            &c.cancel,
                            |s, e| c.output(s, e),
                        )
                        .await
                    }
                    Err(e) => Outcome::failed(serverdeck_core::IpcError::from(e).message),
                },
                Origin::Local => {
                    if input.tool == Tool::Dns {
                        return match tokio::net::lookup_host((input.target.as_str(), 0)).await {
                            Ok(addresses) => {
                                let mut unique = std::collections::BTreeSet::new();
                                for a in addresses {
                                    unique.insert(a.ip());
                                }
                                for a in &unique {
                                    c.output(&format!("{a}\n"), false);
                                }
                                if unique.is_empty() {
                                    Outcome::failed("系统解析器未返回地址")
                                } else {
                                    Outcome::status(Some(0))
                                }
                            }
                            Err(e) => Outcome::failed(format!("本地系统 DNS 解析失败：{e}")),
                        };
                    }
                    if input.tool == Tool::Tcp {
                        let mut passed = true;
                        for n in 0..input.count {
                            let start = std::time::Instant::now();
                            let r = tokio::time::timeout(
                                Duration::from_secs(3),
                                tokio::net::TcpStream::connect((input.target.as_str(), input.port)),
                            )
                            .await;
                            let message = match r {
                                Ok(Ok(_)) => "connected".into(),
                                Ok(Err(e)) => {
                                    passed = false;
                                    format!("failed: {e}")
                                }
                                Err(_) => {
                                    passed = false;
                                    "connect timeout".into()
                                }
                            };
                            c.output(
                                &format!(
                                    "sample={} {}:{} {message} {:.3} ms (DNS included)\n",
                                    n + 1,
                                    input.target,
                                    input.port,
                                    start.elapsed().as_secs_f64() * 1000.0
                                ),
                                false,
                            );
                            if n + 1 < input.count {
                                tokio::time::sleep(Duration::from_secs(1)).await;
                            }
                        }
                        return Outcome::status(Some(if passed { 0 } else { 1 }));
                    }
                    match local_command(&input) {
                        Ok((path, args)) => {
                            exec::local(path, args, input.timeout_secs, &c.cancel, |s, e| {
                                c.output(s, e)
                            })
                            .await
                        }
                        Err(e) => Outcome::failed(serverdeck_core::IpcError::from(e).message),
                    }
                }
            }
        };
        tokio::pin!(task);
        // Command runners own their channel/process cleanup. Built-in DNS/TCP are cancellation safe.
        if matches!(input.origin, Origin::Local) && matches!(input.tool, Tool::Dns | Tool::Tcp) {
            tokio::select! {r=tokio::time::timeout(timeout,&mut task)=>r.unwrap_or_else(|_|Outcome{state:"timed_out",code:None,message:Some("本地诊断总时限已到".into())}),_=c.cancel.cancelled()=>Outcome{state:"cancelled",code:None,message:Some("本地诊断已取消".into())}}
        } else {
            task.await
        }
    }
}
pub fn remote_command(i: &DiagnosticInput) -> Result<String, Error> {
    i.validate()?;
    let target = serverdeck_core::ops::quote(&i.target).unwrap_or_else(|_| "''".into());
    let prefix = "export LC_ALL=C; export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; ";
    let command = match i.tool {
        Tool::Ping => format!("exec ping -n -c {} -W 1 -- {target}", i.count),
        Tool::Traceroute => format!(
            "if command -v traceroute >/dev/null 2>&1; then exec traceroute -n -m 16 -w 1 -- {target}; elif command -v tracepath >/dev/null 2>&1; then exec tracepath -n -m 16 {target}; else printf 'traceroute/tracepath not installed\\n' >&2; exit 127; fi"
        ),
        Tool::Mtr => format!(
            "exec mtr --raw --no-dns --report-cycles {} {target}",
            i.count
        ),
        Tool::Dns => format!("exec getent ahosts {target}"),
        Tool::Interfaces => "exec ip -details address show".into(),
        Tool::Connections => "exec ss -tunap".into(),
        Tool::Tcp => {
            let script = format!(
                "import socket,time,sys\nok=True\nfor n in range({}):\n t=time.monotonic()\n try:\n  s=socket.create_connection((sys.argv[1],int(sys.argv[2])),3);s.close();r='connected'\n except OSError as e:\n  r='failed: '+str(e);ok=False\n print('sample='+str(n+1)+' '+r+' '+str(round((time.monotonic()-t)*1000,3))+' ms (DNS included)',flush=True)\n if n+1<{}:time.sleep(1)\nsys.exit(0 if ok else 1)",
                i.count, i.count
            );
            format!(
                "exec python3 -u -c {} {target} {}",
                serverdeck_core::ops::quote(&script)?,
                i.port
            )
        }
        Tool::SshLatency => return Err(Error::Validation("SSH 延迟使用受控 exec 往返探针")),
    };
    Ok(format!("{prefix}{command}"))
}
pub fn local_command(i: &DiagnosticInput) -> Result<(PathBuf, Vec<String>), Error> {
    i.validate()?;
    #[cfg(windows)]
    let (name, args): (&str, Vec<String>) = match i.tool {
        Tool::Ping => (
            "PING.EXE",
            vec![
                "-n".into(),
                i.count.to_string(),
                "-w".into(),
                "1000".into(),
                i.target.clone(),
            ],
        ),
        Tool::Traceroute => (
            "TRACERT.EXE",
            vec![
                "-d".into(),
                "-h".into(),
                "16".into(),
                "-w".into(),
                "1000".into(),
                i.target.clone(),
            ],
        ),
        Tool::Interfaces => ("IPCONFIG.EXE", vec!["/all".into()]),
        Tool::Connections => ("NETSTAT.EXE", vec!["-ano".into()]),
        _ => {
            return Err(Error::Validation(
                "本地 Windows 未提供受管 MTR；请选择远端 MTR。DNS/TCP 使用内置解析/连接器",
            ));
        }
    };
    #[cfg(not(windows))]
    let (name, args): (&str, Vec<String>) = match i.tool {
        Tool::Ping => (
            "ping",
            vec![
                "-n".into(),
                "-c".into(),
                i.count.to_string(),
                i.target.clone(),
            ],
        ),
        Tool::Traceroute => (
            "traceroute",
            vec![
                "-n".into(),
                "-m".into(),
                "16".into(),
                "-w".into(),
                "1".into(),
                i.target.clone(),
            ],
        ),
        Tool::Mtr => (
            "mtr",
            vec![
                "--raw".into(),
                "--no-dns".into(),
                "--report-cycles".into(),
                i.count.to_string(),
                i.target.clone(),
            ],
        ),
        Tool::Interfaces => {
            if cfg!(target_os = "macos") {
                ("ifconfig", vec![])
            } else {
                (
                    "ip",
                    vec!["-details".into(), "address".into(), "show".into()],
                )
            }
        }
        Tool::Connections => {
            if cfg!(target_os = "macos") {
                ("netstat", vec!["-an".into()])
            } else {
                ("ss", vec!["-tunap".into()])
            }
        }
        _ => return Err(Error::Validation("该工具不使用本地子进程")),
    };
    #[cfg(windows)]
    let candidates = vec![
        PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
            .join("System32")
            .join(name),
    ];
    #[cfg(not(windows))]
    let candidates = ["/usr/bin", "/usr/sbin", "/bin", "/sbin", "/usr/local/bin"]
        .iter()
        .map(|p| PathBuf::from(p).join(name))
        .collect::<Vec<_>>();
    let path = candidates
        .into_iter()
        .find(|p| p.is_file())
        .ok_or(Error::Validation(
            "本机未安装此诊断工具；不自动安装或请求管理员权限",
        ))?;
    Ok((path, args))
}
