//! Keeps an installed app current. The server names the newest build for this platform and the
//! checksum of its program; an app whose own program differs downloads that build, checks it,
//! swaps itself for it and starts again. `release.sh` publishes builds.
//!
//! On Linux the download is the program and replaces the running file. On macOS it is a .tar.gz
//! of `BuddySocials.app` and replaces the whole bundle, so its signature stays intact.

use std::path::{Path, PathBuf};

use anyhow::{Context, bail};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::config;

/// The newest build on the server.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Latest {
    pub version: String,
    pub url: String,
    pub file_sha256: String,
    pub program_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Default)]
pub enum State {
    /// Up to date, or not checked yet.
    #[default]
    Current,
    Available(Latest),
    Installing(Latest),
    /// The new build is in place; start this to run it.
    Ready(Relaunch),
}

/// How to start the app again after an update.
#[derive(Clone, Debug, PartialEq)]
pub enum Relaunch {
    Program(PathBuf),
    /// A macOS bundle, started through `open` so it launches like a click in Finder.
    Bundle(PathBuf),
}

impl Relaunch {
    pub fn start(&self) -> std::io::Result<()> {
        match self {
            Relaunch::Program(path) => std::process::Command::new(path).spawn().map(drop),
            Relaunch::Bundle(path) => std::process::Command::new("open").arg("-n").arg(path).spawn().map(drop),
        }
    }
}

/// The build this machine runs, as the server names it: "linux-aarch64", "macos-aarch64".
pub fn platform() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

/// What gets replaced by an update: the program on Linux, the bundle around it on macOS.
/// None when this copy shouldn't update itself, such as a development build.
fn installed() -> Option<(PathBuf, Relaunch)> {
    if cfg!(debug_assertions) && std::env::var_os("BUDDYSOCIALS_UPDATE_DEBUG").is_none() {
        return None;
    }
    let program = std::env::current_exe().ok()?.canonicalize().ok()?;
    if cfg!(target_os = "macos") {
        // BuddySocials.app/Contents/MacOS/BuddySocials
        let bundle = program.parent()?.parent()?.parent()?.to_path_buf();
        if bundle.extension()? != "app" {
            return None;
        }
        Some((program, Relaunch::Bundle(bundle)))
    } else {
        Some((program.clone(), Relaunch::Program(program)))
    }
}

fn sha256_of(path: &Path) -> anyhow::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    Ok(hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect())
}

/// The newest build when it differs from the one running, or None when this copy is current
/// (or isn't one that updates itself).
pub async fn check() -> anyhow::Result<Option<Latest>> {
    let Some((program, _)) = installed() else { return Ok(None) };
    let response = reqwest::Client::new().get(format!("{}/desktop/latest", config::site_url())).query(&[("platform", platform())]).send().await?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let latest: Latest = response.error_for_status()?.json().await?;
    let own = tokio::task::spawn_blocking(move || sha256_of(&program)).await??;
    Ok((own != latest.program_sha256).then_some(latest))
}

async fn download(url: &str, to: &Path) -> anyhow::Result<()> {
    use tokio::io::AsyncWriteExt;
    let mut response = reqwest::get(url).await?.error_for_status()?;
    let mut file = tokio::fs::File::create(to).await?;
    while let Some(chunk) = response.chunk().await? {
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    Ok(())
}

/// Downloads the build, checks it against the server's checksums and puts it where this copy is.
/// The running app keeps working until it is started again.
pub async fn install(latest: &Latest) -> anyhow::Result<Relaunch> {
    let (program, relaunch) = installed().context("This copy of BuddySocials doesn't update itself.")?;
    match &relaunch {
        Relaunch::Program(_) => {
            // Next to the program, so the swap is one rename on the same disk.
            let staged = program.with_extension("update");
            let result = install_program(latest, &program, &staged).await;
            if result.is_err() {
                let _ = std::fs::remove_file(&staged);
            }
            result?;
        }
        Relaunch::Bundle(bundle) => {
            let staging = bundle.with_extension("update");
            let _ = std::fs::remove_dir_all(&staging);
            let result = install_bundle(latest, bundle, &staging).await;
            let _ = std::fs::remove_dir_all(&staging);
            result?;
        }
    }
    Ok(relaunch)
}

async fn install_program(latest: &Latest, program: &Path, staged: &Path) -> anyhow::Result<()> {
    std::fs::File::create(staged).context("The app could not be replaced. Check that its folder can be written to.")?;
    download(&latest.url, staged).await.context("The update could not be downloaded.")?;
    let sum = {
        let staged = staged.to_path_buf();
        tokio::task::spawn_blocking(move || sha256_of(&staged)).await??
    };
    if sum != latest.file_sha256 || sum != latest.program_sha256 {
        bail!("The downloaded update is damaged. Try again.");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(staged, std::fs::Permissions::from_mode(0o755))?;
    }
    // Replacing the file leaves the running program untouched; it keeps the old one open.
    std::fs::rename(staged, program).context("The app could not be replaced. Check that its folder can be written to.")?;
    Ok(())
}

async fn install_bundle(latest: &Latest, bundle: &Path, staging: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(staging).context("The app could not be replaced. Check that its folder can be written to.")?;
    let archive = staging.join("update.tar.gz");
    download(&latest.url, &archive).await.context("The update could not be downloaded.")?;
    let sum = {
        let archive = archive.clone();
        tokio::task::spawn_blocking(move || sha256_of(&archive)).await??
    };
    if sum != latest.file_sha256 {
        bail!("The downloaded update is damaged. Try again.");
    }
    let unpacked = {
        let (archive, staging) = (archive.clone(), staging.to_path_buf());
        tokio::task::spawn_blocking(move || std::process::Command::new("/usr/bin/tar").arg("-xzf").arg(archive).arg("-C").arg(staging).status()).await??
    };
    let name = bundle.file_name().context("no bundle name")?;
    // The archive holds BuddySocials.app whatever the installed copy was renamed to.
    let fresh = staging.join("BuddySocials.app");
    let inner = fresh.join("Contents/MacOS/BuddySocials");
    if !unpacked.success() || sha256_of(&inner).ok().as_deref() != Some(latest.program_sha256.as_str()) {
        bail!("The downloaded update is damaged. Try again.");
    }
    let previous = staging.join("previous.app");
    std::fs::rename(bundle, &previous).context("The app could not be replaced. Check that its folder can be written to.")?;
    if let Err(error) = std::fs::rename(&fresh, bundle.with_file_name(name)) {
        // Put the old app back rather than leave nothing installed.
        let _ = std::fs::rename(&previous, bundle);
        return Err(error).context("The app could not be replaced.");
    }
    Ok(())
}

/// `--update`: checks and installs without a window. Prints what happened.
pub fn run_from_terminal() -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|error| error.to_string())?;
    runtime.block_on(async {
        if installed().is_none() {
            return Err("This copy doesn't update itself (a development build, or not inside BuddySocials.app).".to_string());
        }
        match check().await.map_err(|error| format!("{error:#}"))? {
            None => println!("BuddySocials is up to date ({}).", platform()),
            Some(latest) => {
                println!("Updating to {}…", latest.version);
                install(&latest).await.map_err(|error| format!("{error:#}"))?;
                println!("Updated to {}. Open BuddySocials again to use it.", latest.version);
            }
        }
        Ok(())
    })
}
