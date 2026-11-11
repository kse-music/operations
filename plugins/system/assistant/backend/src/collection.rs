use crate::types::{ChatMessage, ChatRole};
#[derive(Debug, Default, PartialEq)]
pub struct Plan {
    pub metrics: bool,
    pub processes: bool,
    pub docker: bool,
    pub journal: bool,
    pub services: bool,
    pub ports: bool,
    pub logs: bool,
}
impl Plan {
    fn classify_lowercase(q: &str) -> Self {
        let has = |words: &[&str]| words.iter().any(|word| q.contains(word));
        let docker = has(&["docker", "container", "容器", "compose", "swarm"]);
        let processes = has(&["process", "进程", "线程", "pid"])
            || (has(&["cpu", "内存", "memory", "负载", "load"])
                && has(&["高", "排查", "为什么", "原因", "why", "high"]));
        let metrics = has(&[
            "硬件",
            "hardware",
            "cpu",
            "负载",
            "load",
            "内存",
            "memory",
            "磁盘",
            "disk",
            "空间",
            "网络",
            "network",
            "带宽",
            "流量",
            "uptime",
            "运行时间",
            "系统信息",
            "系统版本",
            "操作系统",
            "内核",
            "几核",
        ]);
        let logs = has(&["日志", "journal", "logs", "log "]);
        let services = has(&["systemd", "systemctl", ".service"])
            || (!docker && q.replace("服务器", "").contains("服务"));
        let ports = has(&["端口", "port", "监听"]);
        let health = !docker
            && !processes
            && !metrics
            && !services
            && !ports
            && !logs
            && has(&[
                "健康",
                "性能",
                "卡顿",
                "缓慢",
                "很慢",
                "无响应",
                "故障",
                "排查",
                "diagnos",
                "服务器状态",
                "主机状态",
                "运行状况",
            ]);
        Self {
            metrics: metrics || health,
            processes: processes || health,
            docker,
            journal: logs && (!docker || has(&["系统日志", "systemd", "journal"])),
            services,
            ports,
            logs,
        }
    }
    pub fn for_question(question: &str, history: &[ChatMessage]) -> Self {
        let lower = question.to_lowercase();
        let mut plan = Self::classify_lowercase(&lower);
        // Only an ambiguous follow-up inherits the last user's domain. An explicit
        // new topic must not accumulate all domains seen in the conversation.
        if !plan.metrics
            && !plan.processes
            && !plan.docker
            && !plan.services
            && !plan.ports
            && ((plan.logs
                && !["系统日志", "systemd", "journal"]
                    .iter()
                    .any(|word| lower.contains(word)))
                || [
                    "那",
                    "它",
                    "这些",
                    "继续",
                    "刚才",
                    "其中",
                    "再看",
                    "them",
                    "what about",
                ]
                .iter()
                .any(|word| lower.contains(word)))
            && let Some(previous) = history
                .iter()
                .rev()
                .filter(|message| matches!(message.role, ChatRole::User))
                .map(|message| Self::classify_lowercase(&message.content.to_lowercase()))
                .find(|plan| {
                    plan.metrics || plan.processes || plan.docker || plan.services || plan.ports
                })
        {
            plan.metrics = previous.metrics;
            plan.processes = previous.processes;
            plan.docker = previous.docker;
            plan.services = previous.services;
            plan.ports = previous.ports;
            plan.journal = plan.logs && !plan.docker;
        }
        plan
    }
    pub fn sources(&self) -> Vec<&'static str> {
        [
            (self.metrics, "metrics"),
            (self.processes, "processes"),
            (self.docker, "docker"),
            (self.journal, "selectedLog"),
            (self.services, "services"),
            (self.ports, "ports"),
        ]
        .into_iter()
        .filter_map(|(enabled, name)| enabled.then_some(name))
        .collect()
    }
}
