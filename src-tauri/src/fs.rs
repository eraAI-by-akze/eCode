//! File system commands: tree, read/write, create/rename/trash, quick-open
//! index, project search and the recursive watcher. Mirrors src/main/fs.ts.

use std::collections::{HashSet, VecDeque};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use regex::RegexBuilder;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::util::{err, to_string_lossy, CmdResult};

const HIDDEN: &[&str] = &[".git", ".DS_Store", "Thumbs.db"];
const HEAVY_DIRS: &[&str] = &[
    ".git", "node_modules", ".next", ".nuxt", "dist", "out", "build", ".cache", ".turbo", "coverage",
    "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache", ".idea", "target",
];
const MAX_OPEN_SIZE: u64 = 50 * 1024 * 1024;
const MAX_SEARCH_FILE_SIZE: u64 = 2 * 1024 * 1024;
const MAX_LIST_FILES: usize = 60_000;
const MAX_SEARCH_MATCHES: usize = 5_000;

#[derive(Default)]
pub struct FsState {
    search_generation: Arc<AtomicU64>,
    watcher: Mutex<Option<RecommendedWatcher>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    binary: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    too_large: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatResult {
    is_dir: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    case_sensitive: bool,
    regex: bool,
    whole_word: bool,
    include: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    line: usize,
    column: usize,
    length: usize,
    preview: String,
    preview_start: usize,
}

#[derive(Serialize)]
pub struct SearchFileResult {
    path: String,
    matches: Vec<SearchMatch>,
}

#[derive(Serialize, Default)]
pub struct SearchResult {
    files: Vec<SearchFileResult>,
    total: usize,
    truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn is_binary(buf: &[u8]) -> bool {
    buf.iter().take(8000).any(|&b| b == 0)
}

/// Natural, case-insensitive ordering ("file2" < "file10").
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let (a, b) = (a.to_lowercase(), b.to_lowercase());
    let (mut ai, mut bi) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, _) => return std::cmp::Ordering::Less,
            (_, None) => return std::cmp::Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let mut na = String::new();
                while let Some(c) = ai.peek().copied().filter(char::is_ascii_digit) {
                    na.push(c);
                    ai.next();
                }
                let mut nb = String::new();
                while let Some(c) = bi.peek().copied().filter(char::is_ascii_digit) {
                    nb.push(c);
                    bi.next();
                }
                let (va, vb) = (na.trim_start_matches('0'), nb.trim_start_matches('0'));
                let ord = va.len().cmp(&vb.len()).then_with(|| va.cmp(vb));
                if ord != std::cmp::Ordering::Equal {
                    return ord;
                }
            }
            (Some(x), Some(y)) => {
                if x != y {
                    return x.cmp(&y);
                }
                ai.next();
                bi.next();
            }
        }
    }
}

fn check_name(name: &str) -> CmdResult<()> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err(format!("Недопустимое имя: {name}"));
    }
    Ok(())
}

#[tauri::command]
pub fn read_dir(dir: String) -> CmdResult<Vec<DirEntry>> {
    let mut entries: Vec<DirEntry> = fs::read_dir(&dir)
        .map_err(err)?
        .filter_map(Result::ok)
        .filter_map(|d| {
            let name = d.file_name().to_string_lossy().into_owned();
            if HIDDEN.contains(&name.as_str()) {
                return None;
            }
            // Follow symlinks for the folder check, like the Electron version.
            let is_dir = fs::metadata(d.path()).map(|m| m.is_dir()).unwrap_or(false);
            Some(DirEntry { name, path: to_string_lossy(&d.path()), is_dir })
        })
        .collect();
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| natural_cmp(&a.name, &b.name)));
    Ok(entries)
}

#[tauri::command]
pub fn read_file(path: String) -> ReadFileResult {
    let meta = match fs::metadata(&path) {
        Ok(m) => m,
        Err(e) => return ReadFileResult { error: Some(e.to_string()), ..Default::default() },
    };
    if meta.len() > MAX_OPEN_SIZE {
        return ReadFileResult { too_large: Some(true), ..Default::default() };
    }
    match fs::read(&path) {
        Ok(buf) if is_binary(&buf) => ReadFileResult { binary: Some(true), ..Default::default() },
        Ok(buf) => ReadFileResult { content: Some(String::from_utf8_lossy(&buf).into_owned()), ..Default::default() },
        Err(e) => ReadFileResult { error: Some(e.to_string()), ..Default::default() },
    }
}

#[tauri::command]
pub fn write_file(path: String, content: String) -> CmdResult<()> {
    fs::write(path, content).map_err(err)
}

#[tauri::command]
pub fn stat(path: String) -> Option<StatResult> {
    fs::metadata(path).ok().map(|m| StatResult { is_dir: m.is_dir() })
}

#[tauri::command]
pub fn create_file(dir: String, name: String) -> CmdResult<String> {
    check_name(&name)?;
    let p = Path::new(&dir).join(&name);
    fs::OpenOptions::new().write(true).create_new(true).open(&p).map_err(err)?;
    Ok(to_string_lossy(&p))
}

#[tauri::command]
pub fn create_dir(dir: String, name: String) -> CmdResult<String> {
    check_name(&name)?;
    let p = Path::new(&dir).join(&name);
    fs::create_dir(&p).map_err(err)?;
    Ok(to_string_lossy(&p))
}

#[tauri::command]
pub fn rename(path: String, new_name: String) -> CmdResult<String> {
    check_name(&new_name)?;
    let from = PathBuf::from(&path);
    let target = from.parent().map(|p| p.join(&new_name)).ok_or("Нет родительской папки")?;
    if target != from {
        // A case-only rename ("a.ts" → "A.ts") is fine on case-insensitive disks.
        if target.exists() && to_string_lossy(&target).to_lowercase() != path.to_lowercase() {
            return Err(format!("«{new_name}» уже существует"));
        }
        fs::rename(&from, &target).map_err(err)?;
    }
    Ok(to_string_lossy(&target))
}

#[tauri::command]
pub fn remove(path: String) -> CmdResult<()> {
    if trash::delete(&path).is_ok() {
        return Ok(());
    }
    let p = Path::new(&path);
    if p.is_dir() {
        fs::remove_dir_all(p).map_err(err)
    } else {
        fs::remove_file(p).map_err(err)
    }
}

/// Breadth-first walk that skips heavy folders and does not follow symlinked dirs.
fn walk(root: &Path, mut visit: impl FnMut(&Path) -> bool) {
    let mut queue = VecDeque::from([root.to_path_buf()]);
    while let Some(dir) = queue.pop_front() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for entry in rd.filter_map(Result::ok) {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if HIDDEN.contains(&name.as_ref()) {
                continue;
            }
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() {
                if !HEAVY_DIRS.contains(&name.as_ref()) {
                    queue.push_back(entry.path());
                }
            } else if ft.is_file() && !visit(&entry.path()) {
                return;
            }
        }
    }
}

#[tauri::command]
pub async fn list_files(root: String) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        walk(Path::new(&root), |p| {
            out.push(to_string_lossy(p));
            out.len() < MAX_LIST_FILES
        });
        out
    })
    .await
    .unwrap_or_default()
}

fn rel_slash(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .map(|r| r.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/"))
        .unwrap_or_else(|_| to_string_lossy(p))
}

type Matcher = Box<dyn Fn(&str) -> bool + Send>;

/// "*.ts, src/**" → matcher over the root-relative, slash-separated path.
fn include_filter(include: &str) -> Option<Vec<Matcher>> {
    let parts: Vec<&str> = include.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
    if parts.is_empty() {
        return None;
    }
    let mut out: Vec<Matcher> = Vec::new();
    for p in parts {
        let pat = p.to_string();
        if !pat.contains('*') && !pat.contains('?') {
            out.push(Box::new(move |rel: &str| rel.contains(&pat)));
            continue;
        }
        let has_slash = pat.contains('/');
        let src = pat
            .split("**")
            .map(|chunk| {
                chunk
                    .split('*')
                    .map(|c| regex::escape(c).replace(r"\?", "."))
                    .collect::<Vec<_>>()
                    .join("[^/]*")
            })
            .collect::<Vec<_>>()
            .join(".*");
        if let Ok(re) = regex::Regex::new(&format!("^{src}$")) {
            out.push(Box::new(move |rel: &str| {
                let target = if has_slash { rel } else { rel.rsplit('/').next().unwrap_or(rel) };
                re.is_match(target)
            }));
        }
    }
    Some(out)
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

#[tauri::command]
pub async fn search(state: State<'_, FsState>, root: String, query: String, opts: SearchOptions) -> CmdResult<SearchResult> {
    let generation = state.search_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let gen_ref = Arc::clone(&state.search_generation);
    if query.is_empty() {
        return Ok(SearchResult::default());
    }
    let mut src = if opts.regex { query.clone() } else { regex::escape(&query) };
    if opts.whole_word {
        src = format!(r"\b(?:{src})\b");
    }
    let re = match RegexBuilder::new(&src).case_insensitive(!opts.case_sensitive).build() {
        Ok(r) => r,
        Err(e) => return Ok(SearchResult { error: Some(e.to_string()), ..Default::default() }),
    };
    let include = include_filter(&opts.include);

    tauri::async_runtime::spawn_blocking(move || {
        let root_path = PathBuf::from(&root);
        let mut result = SearchResult::default();
        walk(&root_path, |file| {
            if gen_ref.load(Ordering::SeqCst) != generation {
                return false; // superseded by a newer query
            }
            if let Some(inc) = &include {
                let rel = rel_slash(&root_path, file);
                if !inc.iter().any(|m| m(&rel)) {
                    return true;
                }
            }
            let Ok(meta) = fs::metadata(file) else { return true };
            if meta.len() > MAX_SEARCH_FILE_SIZE {
                return true;
            }
            let mut buf = Vec::with_capacity(meta.len() as usize);
            if fs::File::open(file).and_then(|mut f| f.read_to_end(&mut buf)).is_err() || is_binary(&buf) {
                return true;
            }
            let text = String::from_utf8_lossy(&buf);
            let mut matches = Vec::new();
            for (i, line) in text.split('\n').enumerate() {
                let line = line.strip_suffix('\r').unwrap_or(line);
                for m in re.find_iter(line) {
                    if m.as_str().is_empty() {
                        continue;
                    }
                    // Columns are UTF-16 based, like the JS editor expects.
                    let col = utf16_len(&line[..m.start()]);
                    let units: Vec<u16> = line.encode_utf16().collect();
                    let preview_start = col.saturating_sub(40);
                    let end = (preview_start + 220).min(units.len());
                    matches.push(SearchMatch {
                        line: i + 1,
                        column: col + 1,
                        length: utf16_len(m.as_str()),
                        preview: String::from_utf16_lossy(&units[preview_start..end]),
                        preview_start,
                    });
                    result.total += 1;
                    if result.total >= MAX_SEARCH_MATCHES {
                        result.truncated = true;
                        break;
                    }
                }
                if result.truncated {
                    break;
                }
            }
            if !matches.is_empty() {
                result.files.push(SearchFileResult { path: to_string_lossy(file), matches });
            }
            !result.truncated
        });
        result
    })
    .await
    .map_err(err)
}

#[tauri::command]
pub fn watch(app: AppHandle, state: State<'_, FsState>, root: Option<String>) -> CmdResult<()> {
    let mut slot = state.watcher.lock().map_err(err)?;
    *slot = None; // drops (stops) the previous watcher
    let Some(root) = root else { return Ok(()) };
    let root_path = PathBuf::from(&root);
    let (tx, rx) = mpsc::channel::<PathBuf>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            for p in ev.paths {
                let _ = tx.send(p);
            }
        }
    })
    .map_err(err)?;
    watcher.watch(&root_path, RecursiveMode::Recursive).map_err(err)?;
    *slot = Some(watcher);

    // Debounce bursts (git checkout, npm install) into one event every 150 ms.
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut batch = HashSet::from([first]);
            while let Ok(p) = rx.recv_timeout(Duration::from_millis(150)) {
                batch.insert(p);
            }
            let paths: Vec<String> = batch
                .into_iter()
                .filter(|p| {
                    let first = p.strip_prefix(&root_path).ok().and_then(|r| r.components().next());
                    let name = first.map(|c| c.as_os_str().to_string_lossy().into_owned()).unwrap_or_default();
                    !HEAVY_DIRS.contains(&name.as_str())
                })
                .map(|p| to_string_lossy(&p))
                .collect();
            if !paths.is_empty() && app.emit("fs:changed", paths).is_err() {
                break;
            }
        }
    });
    Ok(())
}
