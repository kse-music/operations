use crate::*;
use serverdeck_core::IpcError;
use std::time::{Duration, Instant};

const RESULT_LIMIT: usize = 1_000;
const ISSUE_LIMIT: usize = 100;
const RESULT_BYTES_LIMIT: usize = 8 * 1024 * 1024;
const SEARCH_TIMEOUT: Duration = Duration::from_secs(120);
pub type SearchSink = Arc<dyn Fn(FileSearchEvent) -> bool + Send + Sync>;

pub(crate) struct SearchJob {
    request_id: String,
    cancel: CancellationToken,
    done: CancellationToken,
}

pub(crate) fn check_cancel(cancel: Option<&CancellationToken>) -> Result<(), Error> {
    if cancel.is_some_and(CancellationToken::is_cancelled) {
        Err(fail("FILE_SEARCH_CANCELLED", "文件搜索已停止"))
    } else {
        Ok(())
    }
}

impl Files {
    pub fn start_search(
        &self,
        id: &str,
        input: FileSearchInput,
        sink: SearchSink,
    ) -> Result<(), Error> {
        input.validate()?;
        self.engine.session_info(id)?;
        let job = Arc::new(SearchJob {
            request_id: input.request_id.clone(),
            cancel: CancellationToken::new(),
            done: CancellationToken::new(),
        });
        {
            let mut searches = locked(&self.searches)?;
            if self.stopping.load(std::sync::atomic::Ordering::Acquire) {
                return Err(Error::ShuttingDown);
            }
            if searches.contains_key(id) || searches.len() >= 4 {
                return Err(Error::Busy);
            }
            searches.insert(id.into(), job.clone());
        }
        let files = self.clone();
        let id = id.to_owned();
        tokio::spawn(async move {
            let mut report = Report::new(input.request_id.clone(), sink, job.cancel.clone());
            let (result, timed_out) = {
                let operation = files.run_search(&id, &input, &job.cancel, &mut report);
                tokio::pin!(operation);
                tokio::select! {
                    result = &mut operation => (result, false),
                    _ = tokio::time::sleep(SEARCH_TIMEOUT) => {
                        job.cancel.cancel();
                        (operation.await, true)
                    }
                }
            };
            let (status, message) = if timed_out {
                (
                    FileSearchStatus::Limited,
                    Some("搜索达到两分钟上限，结果不完整，请缩小目录范围".into()),
                )
            } else {
                match result {
                    Ok(FileSearchStatus::Limited) => (FileSearchStatus::Limited, Some("搜索达到 1000 个结果、100000 个扫描项目、64 层或 8 MiB 结果上限，结果不完整，请缩小目录范围".into())),
                    Ok(status) => (status, None),
                    Err(error) if matches!(&error, Error::Connection { code: "FILE_SEARCH_CANCELLED", .. }) => (FileSearchStatus::Cancelled, None),
                    Err(error) => {
                        tracing::warn!(operation = "files_search", error = %error, "remote file search failed");
                        (FileSearchStatus::Failed, Some(IpcError::from(error).message))
                    }
                }
            };
            report.emit(status, message);
            // Remove only this job, then acknowledge cancellation after its handles have closed.
            if let Ok(mut searches) = files.searches.lock()
                && searches
                    .get(&id)
                    .is_some_and(|current| Arc::ptr_eq(current, &job))
            {
                searches.remove(&id);
            }
            job.done.cancel();
        });
        Ok(())
    }

    pub async fn cancel_search(&self, id: &str, request_id: &str) -> Result<(), Error> {
        let job = locked(&self.searches)?
            .get(id)
            .filter(|job| job.request_id == request_id)
            .cloned();
        if let Some(job) = job {
            job.cancel.cancel();
            job.done.cancelled().await;
        }
        Ok(())
    }

    pub(crate) async fn cancel_session_searches(&self, id: Option<&str>) -> Result<(), Error> {
        let jobs: Vec<_> = locked(&self.searches)?
            .iter()
            .filter(|(session, _)| id.is_none_or(|id| session.as_str() == id))
            .map(|(_, job)| job.clone())
            .collect();
        for job in &jobs {
            job.cancel.cancel();
        }
        for job in jobs {
            job.done.cancelled().await;
        }
        Ok(())
    }

    async fn run_search(
        &self,
        id: &str,
        input: &FileSearchInput,
        cancel: &CancellationToken,
        report: &mut Report,
    ) -> Result<FileSearchStatus, Error> {
        // A search owns its own channel on the current (possibly switched-user) Files lease.
        let _permit = tokio::select! {
            permit = self.slot() => permit?,
            _ = cancel.cancelled() => return Ok(FileSearchStatus::Cancelled),
        };
        let remote = tokio::select! {
            remote = Remote::connect(&self.engine, id) => remote?,
            _ = cancel.cancelled() => return Ok(FileSearchStatus::Cancelled),
        };
        guard(&remote, async {
            check_cancel(Some(cancel))?;
            let root = remote.canonical(&input.path).await?;
            let pattern = NamePattern::new(&input.query);
            let mut stack = vec![(root, 0)];
            let mut queued = 1usize;
            while let Some((path, depth)) = stack.pop() {
                check_cancel(Some(cancel))?;
                report.current_path = Some(path.clone());
                report.flush();
                let listing = async {
                    if remote::kind(&remote.attrs(&path).await?) != EntryKind::Directory
                        || remote.canonical(&path).await? != path
                    {
                        return Err(fail(
                            "SFTP_PATH_CHANGED",
                            "目录已变化或包含符号链接，已跳过",
                        ));
                    }
                    remote.entries_with_cancel(&path, Some(cancel)).await
                }
                .await;
                let children = match listing {
                    Ok(children) => children,
                    Err(error) if depth > 0 && skippable(&error) => {
                        report.skip(path, error);
                        continue;
                    }
                    Err(error) => return Err(error),
                };
                report.scanned_directories += 1;
                for (name, attrs) in children {
                    check_cancel(Some(cancel))?;
                    report.scanned_entries += 1;
                    if report.scanned_entries.is_multiple_of(64) {
                        tokio::task::yield_now().await;
                        check_cancel(Some(cancel))?;
                    }
                    if report.scanned_entries > TREE_LIMIT {
                        return Ok(FileSearchStatus::Limited);
                    }
                    if !input.include_hidden && name.starts_with('.') {
                        continue;
                    }
                    let child = remote_join(&path, &name)?;
                    let entry = remote::entry(name, child.clone(), &attrs);
                    if pattern.matches(&entry.name) {
                        report.bytes += entry.name.len() + entry.path.len() + path.len();
                        if report.bytes > RESULT_BYTES_LIMIT {
                            return Ok(FileSearchStatus::Limited);
                        }
                        report.entries.push(FileSearchResult {
                            entry: entry.clone(),
                            parent: path.clone(),
                        });
                        report.found += 1;
                        report.flush();
                        if report.found >= RESULT_LIMIT {
                            return Ok(FileSearchStatus::Limited);
                        }
                    }
                    if input.recursive && entry.kind == EntryKind::Directory {
                        if depth >= 64 || queued >= TREE_LIMIT {
                            return Ok(FileSearchStatus::Limited);
                        }
                        queued += 1;
                        stack.push((child, depth + 1));
                    }
                }
                report.flush();
            }
            Ok(FileSearchStatus::Completed)
        })
        .await
    }
}

enum NamePattern {
    Contains(String),
    Wildcard(Vec<char>),
}
impl NamePattern {
    fn new(query: &str) -> Self {
        let query = query.trim().to_lowercase();
        if query.contains(['*', '?']) {
            Self::Wildcard(query.chars().collect())
        } else {
            Self::Contains(query)
        }
    }
    fn matches(&self, name: &str) -> bool {
        let name = name.to_lowercase();
        match self {
            Self::Contains(query) => name.contains(query),
            Self::Wildcard(pattern) => wildcard_matches(pattern, &name.chars().collect::<Vec<_>>()),
        }
    }
}

// Only * and ? are special. Match the whole name without regex or shell expansion.
fn wildcard_matches(pattern: &[char], name: &[char]) -> bool {
    let (mut token, mut character) = (0, 0);
    let (mut star, mut retry) = (None, 0);
    while character < name.len() {
        match pattern.get(token) {
            Some('*') => {
                star = Some(token);
                token += 1;
                retry = character;
            }
            Some('?') => {
                token += 1;
                character += 1;
            }
            Some(value) if *value == name[character] => {
                token += 1;
                character += 1;
            }
            _ => {
                let Some(previous_star) = star else {
                    return false;
                };
                retry += 1;
                character = retry;
                token = previous_star + 1;
            }
        }
    }
    pattern[token..].iter().all(|value| *value == '*')
}

fn skippable(error: &Error) -> bool {
    matches!(
        error,
        Error::Connection {
            code: "SFTP_PERMISSION" | "SFTP_NOT_FOUND" | "SFTP_PATH_CHANGED" | "SFTP_LIMIT",
            ..
        }
    )
}

struct Report {
    request_id: String,
    sink: SearchSink,
    cancel: CancellationToken,
    entries: Vec<FileSearchResult>,
    issues: Vec<FileSearchIssue>,
    found: usize,
    bytes: usize,
    scanned_directories: usize,
    scanned_entries: usize,
    skipped_directories: usize,
    current_path: Option<String>,
    last_emit: Instant,
}
impl Report {
    fn new(request_id: String, sink: SearchSink, cancel: CancellationToken) -> Self {
        Self {
            request_id,
            sink,
            cancel,
            entries: Vec::new(),
            issues: Vec::new(),
            found: 0,
            bytes: 0,
            scanned_directories: 0,
            scanned_entries: 0,
            skipped_directories: 0,
            current_path: None,
            last_emit: Instant::now() - Duration::from_secs(1),
        }
    }
    fn emit(&mut self, status: FileSearchStatus, message: Option<String>) {
        let delivered = (self.sink)(FileSearchEvent {
            request_id: self.request_id.clone(),
            status,
            entries: std::mem::take(&mut self.entries),
            issues: std::mem::take(&mut self.issues),
            scanned_directories: self.scanned_directories,
            scanned_entries: self.scanned_entries,
            skipped_directories: self.skipped_directories,
            current_path: self.current_path.clone(),
            message,
        });
        self.last_emit = Instant::now();
        if !delivered {
            self.cancel.cancel();
        }
    }
    fn flush(&mut self) {
        if self.entries.len() >= 64 || self.last_emit.elapsed() >= Duration::from_millis(200) {
            self.emit(FileSearchStatus::Running, None);
        }
    }
    fn skip(&mut self, path: String, error: Error) {
        tracing::debug!(operation = "files_search_skip", error = %error, "search directory skipped");
        self.skipped_directories += 1;
        if self.skipped_directories <= ISSUE_LIMIT {
            self.issues.push(FileSearchIssue {
                path,
                message: IpcError::from(error).message,
            });
        }
        self.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::NamePattern;

    #[test]
    fn name_patterns_keep_contains_search_and_match_wildcards_against_whole_names() {
        for (query, name, expected) in [
            ("sh", "backup.sh.bak", true),
            (" *.SH ", "run.sh", true),
            ("*.sh", "BUILD.SH", true),
            ("*.sh", ".sh", true),
            ("*.sh", "run.sh.bak", false),
            ("*.sh", "runXsh", false),
            ("*.sh", "run.sh\n", false),
            ("service?.sh", "service1.sh", true),
            ("service?.sh", "service12.sh", false),
            ("service?.sh", "service.sh", false),
            ("service?.sh", "service中.sh", true),
            ("?.sh", "🙂.sh", true),
            ("??.sh", "中文.sh", true),
            ("??.sh", "🙂.sh", false),
            ("Ä?.SH", "ä中.sh", true),
            ("*", "", true),
            ("*?", "", false),
            ("a*b*c", "axbyc", true),
            ("a*b*c", "abc", true),
            ("a*b*c", "abx", false),
            ("a**b?c*", "ab中c-tail", true),
            ("**.sh", "script.sh", true),
            ("*a**", "a", true),
            ("*[ab].sh", "file[ab].sh", true),
            ("*[ab].sh", "filea.sh", false),
            ("*a+b.(sh)", "file-a+b.(sh)", true),
            ("*$(id)*.sh", "file-$(id).sh", true),
            ("*\\*.sh", "a\\b.sh", true),
            ("[ab]", "file[ab].sh", true),
            ("[ab]", "filea.sh", false),
        ] {
            assert_eq!(
                NamePattern::new(query).matches(name),
                expected,
                "{query:?} against {name:?}"
            );
        }
        assert!(
            !NamePattern::new(&format!("*{}b", "a".repeat(128)))
                .matches(&format!("{}c", "a".repeat(1024)))
        );
    }
}
