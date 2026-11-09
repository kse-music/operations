use std::{
    fs::{File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

use serverdeck_core::LogLevel;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{
    EnvFilter, Registry, layer::SubscriberExt, reload, util::SubscriberInitExt,
};

struct RotatingWriter {
    directory: PathBuf,
    file: Option<File>,
    length: u64,
    limit: u64,
}

impl RotatingWriter {
    fn open(directory: &Path, limit: u64) -> io::Result<Self> {
        std::fs::create_dir_all(directory)?;
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(directory.join("serverdeck.log"))?;
        let length = file.metadata()?.len();
        Ok(Self {
            directory: directory.to_owned(),
            file: Some(file),
            length,
            limit,
        })
    }

    fn rotate(&mut self) -> io::Result<()> {
        self.file.take();
        match std::fs::remove_file(self.directory.join("serverdeck.3.log")) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
        for (source, target) in [
            ("serverdeck.2.log", "serverdeck.3.log"),
            ("serverdeck.1.log", "serverdeck.2.log"),
            ("serverdeck.log", "serverdeck.1.log"),
        ] {
            match std::fs::rename(self.directory.join(source), self.directory.join(target)) {
                Ok(()) => (),
                Err(error) if error.kind() == io::ErrorKind::NotFound => (),
                Err(error) => return Err(error),
            }
        }
        self.file = Some(
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.directory.join("serverdeck.log"))?,
        );
        self.length = 0;
        Ok(())
    }
}

impl Write for RotatingWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        if buffer.len() as u64 > self.limit {
            return Ok(buffer.len());
        }
        if self.file.is_none() || self.length + buffer.len() as u64 > self.limit {
            self.rotate()?;
        }
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| io::Error::other("log writer unavailable"))?;
        file.write_all(buffer)?;
        self.length += buffer.len() as u64;
        Ok(buffer.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        if let Some(file) = self.file.as_mut() {
            file.flush()?;
        }
        Ok(())
    }
}

pub struct Logger {
    guard: Mutex<Option<WorkerGuard>>,
    filter: reload::Handle<EnvFilter, Registry>,
}

impl Logger {
    pub fn flush(&self) {
        if let Ok(mut guard) = self.guard.lock() {
            guard.take();
        }
    }
    pub fn set_level(&self, level: LogLevel) -> Result<(), Box<dyn std::error::Error>> {
        self.filter.reload(filter(level)?)?;
        Ok(())
    }
}

fn filter(level: LogLevel) -> Result<EnvFilter, Box<dyn std::error::Error>> {
    Ok(EnvFilter::try_new(format!(
        "off,serverdeck_application={},serverdeck_storage={},serverdeck_desktop={},serverdeck_security={},serverdeck_ssh={}",
        level.as_str(),
        level.as_str(),
        level.as_str(),
        level.as_str(),
        level.as_str()
    ))?)
}

pub fn initialize(directory: &Path, level: LogLevel) -> Result<Logger, Box<dyn std::error::Error>> {
    // Four files of at most 1 MiB each, plus a bounded lossy queue.
    let writer = RotatingWriter::open(directory, 1024 * 1024)?;
    let (writer, guard) = tracing_appender::non_blocking::NonBlockingBuilder::default()
        .buffered_lines_limit(512)
        .lossy(true)
        .finish(writer);
    // Dependency debug output is excluded, even if application debug is enabled.
    let (filter, handle) = reload::Layer::new(filter(level)?);
    tracing_subscriber::registry()
        .with(filter)
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(writer),
        )
        .try_init()?;
    Ok(Logger {
        guard: Mutex::new(Some(guard)),
        filter: handle,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_rotation_bounds_disk_usage_and_reopens_on_windows() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut writer = RotatingWriter::open(directory.path(), 64).expect("writer");
        for _ in 0..50 {
            writer.write_all(&[b'x'; 40]).expect("write");
        }
        writer
            .write_all(&[b'y'; 100])
            .expect("oversized record dropped");
        writer.flush().expect("flush");
        let files: Vec<_> = std::fs::read_dir(directory.path()).expect("list").collect();
        assert_eq!(files.len(), 4);
        for file in files {
            assert!(file.expect("entry").metadata().expect("metadata").len() <= 64);
        }
    }
}
