use serverdeck_core::ops::Request;

#[test]
fn capability_command_uses_posix_line_endings() {
    let command = Request::Capabilities.command().expect("capability command");
    assert!(
        !command.contains('\r'),
        "remote shell commands must not contain Windows carriage returns"
    );
    assert!(command.contains("printf 'SDOPS1\\000'\n"));
}
