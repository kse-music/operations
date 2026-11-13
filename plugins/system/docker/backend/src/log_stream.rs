use serverdeck_plugin_sdk::{
    ApiError,
    platform::{Command, quote},
};

/// SSH signal requests are optional on servers. EOF is a second, remote-owned lifetime.
pub fn command(command: Command) -> Result<Command, ApiError> {
    let body = format!("exec {}", command.shell()?);
    Ok(Command::script(
        include_str!("log-stream.sh").replace("__SD_LOG_COMMAND__", &quote(&body)?),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires local WSL Python/sh/GNU timeout; no Docker daemon or user hosts"]
    fn eof_stops_idle_term_ignoring_children_and_preserves_status_and_time_limit() {
        use std::{
            io::Write,
            process::{Command as Process, Stdio},
        };
        let idle = command(Command::script(
            "trap '' TERM; echo $$; while :; do sleep 1; done",
        ))
        .unwrap();
        let completed = command(Command::script("printf done; exit 7")).unwrap();
        let capped = command(Command::script("echo $$; exec sleep 30")).unwrap();
        let probe = r#"
import json,subprocess,sys,time,pathlib
scripts=json.load(sys.stdin)
p=subprocess.Popen(['sh','-c',scripts[0]],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
pid=int(p.stdout.readline())
assert pathlib.Path('/proc/%d'%pid).exists(), 'child must be running before EOF'
p.stdin.close();p.stdin=None
out,err=p.communicate(timeout=4)
assert p.returncode != 0, (p.returncode,out,err)
deadline=time.monotonic()+2
while pathlib.Path('/proc/%d/stat'%pid).exists():
    text=pathlib.Path('/proc/%d/stat'%pid).read_text()
    if text[text.rfind(')')+2:].split()[0]=='Z': break
    assert time.monotonic()<deadline, 'owned log child still running after EOF'
    time.sleep(.01)
p=subprocess.Popen(['sh','-c',scripts[1]],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
assert p.wait(timeout=3)==7, 'must preserve actual command failure'
assert p.stdout.read()=='done'
p=subprocess.Popen(['sh','-c',scripts[2]],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
pid=int(p.stdout.readline())
assert p.wait(timeout=3)==124, 'time limit must stop the remote command even with stdin still open'
assert not pathlib.Path('/proc/%d'%pid).exists(), 'timed out log command remains'
"#;
        let mut process = Process::new("wsl")
            .args(["--exec", "python3", "-c", probe])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        // Shorten only the wall clock bound; execute the production guard/process-group logic.
        let capped_script = capped.args[1].replace("10m", "0.1s");
        let scripts = serverdeck_plugin_sdk::serde_json::to_vec(&[
            &idle.args[1],
            &completed.args[1],
            &capped_script,
        ])
        .unwrap();
        process.stdin.take().unwrap().write_all(&scripts).unwrap();
        let output = process.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
