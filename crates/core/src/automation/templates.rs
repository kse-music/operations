use super::*;
pub fn templates() -> Vec<EntryInput> {
    let parameter = |name: &str, label: &str, kind: ParameterKind, default: &str| Parameter {
        name: name.into(),
        label: label.into(),
        kind,
        required: true,
        secret: false,
        default: Some(default.into()),
    };
    let mut entries = Vec::new();
    for (name,body,parameters) in [
  ("查看系统信息","hostname; uname -a; test ! -r /etc/os-release || cat /etc/os-release; uptime".into(),vec![]),
  ("查看磁盘使用率","df -h -P".into(),vec![]),
  ("查看端口","ss -lntup".into(),vec![]),
  ("查看进程","ps -eo pid,user,pcpu,pmem,comm --sort=-pcpu | head -n 51".into(),vec![]),
  ("查看 Docker 状态",format!("{}d version; d ps --all",crate::ops::PRELUDE),vec![]),
  ("查看服务状态","systemctl --no-pager --no-ask-password status -- \"$1\"".into(),vec![parameter("unit","服务单元（$1）",ParameterKind::Text,"ssh.service")]),
  ("查看日志","tail -n \"$2\" -- \"$1\"".into(),vec![parameter("path","绝对日志路径（$1）",ParameterKind::Path,"/var/log/syslog"),parameter("lines","最近行数（$2）",ParameterKind::Integer,"100")]),
  ("检查服务连通性","python3 -c 'import socket,sys; s=socket.create_connection((sys.argv[1],int(sys.argv[2])),3); print(\"connected\"); s.close()' \"$1\" \"$2\"".into(),vec![parameter("host","目标地址（$1）",ParameterKind::Host,"127.0.0.1"),parameter("port","端口（$2）",ParameterKind::Port,"22")]),
 ] {entries.push(EntryInput{kind:if parameters.is_empty(){EntryKind::Command}else{EntryKind::Script},name:name.into(),body,description:"只读检查模板。请查看完整正文和远端权限，不会自动安装工具或提权。".into(),group_id:None,favorite:false,risk:Risk::Normal,parameters,timeout_secs:30,concurrency:3,retain_output:false});}
    entries
}
