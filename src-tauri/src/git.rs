//! git through the CLI, like src/main/git.ts.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::util::{command, err, to_string_lossy, CmdResult};

struct Output {
    stdout: String,
    stderr: String,
}

fn run(cwd: &Path, args: &[&str], allow_fail: bool) -> CmdResult<Output> {
    let out = command("git")
        .args(args)
        .current_dir(cwd)
        // Never block on a credential prompt nobody can see.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .output()
        .map_err(|e| format!("git не найден: {e}"))?;
    let o = Output {
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    };
    if !out.status.success() && !allow_fail {
        let msg = if o.stderr.trim().is_empty() { format!("git {} failed", args[0]) } else { o.stderr.clone() };
        let tail: Vec<&str> = msg.trim().lines().collect();
        return Err(tail[tail.len().saturating_sub(6)..].join("\n"));
    }
    Ok(o)
}

fn rel(repo: &Path, p: &str) -> String {
    Path::new(p)
        .strip_prefix(repo)
        .map(|r| r.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/"))
        .unwrap_or_else(|_| p.replace('\\', "/"))
}

fn repo_root(cwd: &Path) -> Option<PathBuf> {
    let o = run(cwd, &["rev-parse", "--show-toplevel"], false).ok()?;
    // git prints forward slashes; normalise for Windows.
    Some(PathBuf::from(o.stdout.trim().replace('/', std::path::MAIN_SEPARATOR_STR)))
}

fn has_head(repo: &Path) -> bool {
    run(repo, &["rev-parse", "--verify", "--quiet", "HEAD"], false).is_ok()
}

#[derive(Serialize)]
pub struct GitFile {
    path: String,
    rel: String,
    x: String,
    y: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    repo_root: String,
    branch: Option<String>,
    detached: bool,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    has_head: bool,
    files: Vec<GitFile>,
}

fn parse_branch_line(line: &str, st: &mut GitStatus) {
    if let Some(b) = line.strip_prefix("No commits yet on ") {
        st.branch = Some(b.to_string());
        return;
    }
    if line.starts_with("HEAD (no branch)") {
        st.detached = true;
        return;
    }
    // "main...origin/main [ahead 1, behind 2]"
    let (head, tracking) = match line.find(" [") {
        Some(i) => (&line[..i], Some(line[i + 2..].trim_end_matches(']'))),
        None => (line, None),
    };
    match head.split_once("...") {
        Some((b, up)) => {
            st.branch = Some(b.to_string());
            st.upstream = Some(up.to_string());
        }
        None => st.branch = Some(head.to_string()),
    }
    for part in tracking.unwrap_or("").split(", ") {
        if let Some(n) = part.strip_prefix("ahead ") {
            st.ahead = n.parse().unwrap_or(0);
        }
        if let Some(n) = part.strip_prefix("behind ") {
            st.behind = n.parse().unwrap_or(0);
        }
    }
}

#[tauri::command]
pub async fn git_status(root: String) -> Option<GitStatus> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo = repo_root(Path::new(&root))?;
        let out = run(&repo, &["status", "--porcelain=v1", "-z", "-b", "-uall", "--no-renames"], false).ok()?;
        let mut st = GitStatus {
            repo_root: to_string_lossy(&repo),
            branch: None,
            detached: false,
            upstream: None,
            ahead: 0,
            behind: 0,
            has_head: has_head(&repo),
            files: vec![],
        };
        for entry in out.stdout.split('\0').filter(|e| !e.is_empty()) {
            if let Some(line) = entry.strip_prefix("## ") {
                parse_branch_line(line, &mut st);
                continue;
            }
            if entry.len() < 4 {
                continue;
            }
            let (x, y, r) = (&entry[0..1], &entry[1..2], &entry[3..]);
            st.files.push(GitFile {
                path: to_string_lossy(&repo.join(r.replace('/', std::path::MAIN_SEPARATOR_STR))),
                rel: r.to_string(),
                x: x.to_string(),
                y: y.to_string(),
            });
        }
        if st.detached {
            st.branch = run(&repo, &["rev-parse", "--short", "HEAD"], true).ok().map(|o| o.stdout.trim().to_string());
        }
        Some(st)
    })
    .await
    .ok()
    .flatten()
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> CmdResult<T> + Send + 'static) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(err)?
}

#[tauri::command]
pub async fn git_init(root: String) -> CmdResult<()> {
    blocking(move || run(Path::new(&root), &["init"], false).map(|_| ())).await
}

#[tauri::command]
pub async fn git_stage(repo: String, paths: Vec<String>) -> CmdResult<()> {
    blocking(move || {
        let r = Path::new(&repo);
        let rels: Vec<String> = paths.iter().map(|p| rel(r, p)).collect();
        let mut args = vec!["add", "-A", "--"];
        args.extend(rels.iter().map(String::as_str));
        run(r, &args, false).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_unstage(repo: String, paths: Vec<String>) -> CmdResult<()> {
    blocking(move || {
        let r = Path::new(&repo);
        let rels: Vec<String> = paths.iter().map(|p| rel(r, p)).collect();
        let mut args: Vec<&str> = if has_head(r) { vec!["reset", "-q", "HEAD", "--"] } else { vec!["rm", "--cached", "-r", "-q", "--"] };
        args.extend(rels.iter().map(String::as_str));
        run(r, &args, false).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_discard(repo: String, tracked: Vec<String>, untracked: Vec<String>) -> CmdResult<()> {
    blocking(move || {
        let r = Path::new(&repo);
        if !tracked.is_empty() {
            let rels: Vec<String> = tracked.iter().map(|p| rel(r, p)).collect();
            let mut args = vec!["checkout", "--"];
            args.extend(rels.iter().map(String::as_str));
            run(r, &args, false)?;
        }
        for p in untracked {
            if trash::delete(&p).is_err() {
                let path = Path::new(&p);
                let _ = if path.is_dir() { std::fs::remove_dir_all(path) } else { std::fs::remove_file(path) };
            }
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn git_commit(repo: String, message: String, all: bool) -> CmdResult<()> {
    blocking(move || {
        let r = Path::new(&repo);
        if all {
            run(r, &["add", "-A"], false)?;
        }
        run(r, &["commit", "-m", &message], false).map(|_| ())
    })
    .await
}

#[derive(Serialize)]
pub struct DiffContents {
    original: String,
    modified: String,
}

fn show(repo: &Path, spec: &str) -> String {
    run(repo, &["show", spec], false).map(|o| o.stdout).unwrap_or_default()
}

#[tauri::command]
pub async fn git_diff_contents(repo: String, path: String, staged: bool) -> CmdResult<DiffContents> {
    blocking(move || {
        let r = Path::new(&repo);
        let rp = rel(r, &path);
        Ok(if staged {
            DiffContents { original: show(r, &format!("HEAD:{rp}")), modified: show(r, &format!(":{rp}")) }
        } else {
            DiffContents { original: show(r, &format!(":{rp}")), modified: std::fs::read_to_string(&path).unwrap_or_default() }
        })
    })
    .await
}

#[derive(Serialize)]
pub struct GitBranches {
    current: Option<String>,
    local: Vec<String>,
    remote: Vec<String>,
}

fn lines(s: &str) -> Vec<String> {
    s.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect()
}

#[tauri::command]
pub async fn git_branches(repo: String) -> CmdResult<GitBranches> {
    blocking(move || {
        let r = Path::new(&repo);
        let local = run(r, &["for-each-ref", "--format=%(refname:short)", "refs/heads"], true)?.stdout;
        let remote = run(r, &["for-each-ref", "--format=%(refname:short)", "refs/remotes"], true)?.stdout;
        let current = run(r, &["branch", "--show-current"], true)?.stdout.trim().to_string();
        Ok(GitBranches {
            current: if current.is_empty() { None } else { Some(current) },
            local: lines(&local),
            remote: lines(&remote).into_iter().filter(|b| !b.ends_with("/HEAD")).collect(),
        })
    })
    .await
}

#[tauri::command]
pub async fn git_checkout(repo: String, r#ref: String, create: bool) -> CmdResult<()> {
    blocking(move || {
        let r = Path::new(&repo);
        if create {
            return run(r, &["checkout", "-b", &r#ref], false).map(|_| ());
        }
        // "origin/feature" → local tracking branch "feature".
        let is_remote = !run(r, &["for-each-ref", "--format=%(refname:short)", &format!("refs/remotes/{}", r#ref)], true)?
            .stdout
            .trim()
            .is_empty();
        if is_remote {
            let local = r#ref.split_once('/').map(|(_, b)| b).unwrap_or(&r#ref).to_string();
            let exists = !run(r, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{local}")], true)?.stdout.trim().is_empty();
            let args: Vec<&str> = if exists { vec!["checkout", &local] } else { vec!["checkout", "--track", &r#ref] };
            return run(r, &args, false).map(|_| ());
        }
        run(r, &["checkout", &r#ref], false).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_sync(repo: String, op: String) -> CmdResult<String> {
    blocking(move || {
        let r = Path::new(&repo);
        match op.as_str() {
            "fetch" => Ok(run(r, &["fetch", "--prune"], false)?.stderr),
            "pull" => Ok(run(r, &["pull", "--no-rebase"], false)?.stdout),
            _ => {
                let up = run(r, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], true)?.stdout;
                if up.trim().is_empty() {
                    let remotes = run(r, &["remote"], true)?.stdout;
                    let remote = lines(&remotes)
                        .into_iter()
                        .next()
                        .ok_or("У репозитория нет remote. Добавьте его: git remote add origin <url>")?;
                    return Ok(run(r, &["push", "-u", &remote, "HEAD"], false)?.stderr);
                }
                Ok(run(r, &["push"], false)?.stderr)
            }
        }
    })
    .await
}
