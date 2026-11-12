#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    serverdeck_application::run_terminal_helper();
    serverdeck_desktop_lib::run();
}
