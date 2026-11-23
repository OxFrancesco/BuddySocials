//! Where the app connects. These are public identifiers, not secrets; each can be
//! overridden with an environment variable to point a build at another deployment.

/// Run-time override first, then the value baked in at build time (`release.sh --prod` bakes the
/// production deployment), then the dev deployment.
macro_rules! baked {
    ($name:literal, $dev:literal) => {
        match option_env!($name) {
            Some(value) if !value.is_empty() => value,
            _ => $dev,
        }
    };
}

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| default.to_string())
}

pub fn convex_url() -> String {
    env_or("BUDDYSOCIALS_CONVEX_URL", baked!("BUDDYSOCIALS_BUILD_CONVEX_URL", "https://perfect-vole-798.convex.cloud"))
}

/// Where the deployment answers plain HTTP requests, such as the check for a newer build.
pub fn site_url() -> String {
    env_or("BUDDYSOCIALS_SITE_URL", &convex_url().replace(".convex.cloud", ".convex.site"))
}

/// The Clerk instance's Frontend API URL, which is also its OpenID issuer.
pub fn clerk_issuer() -> String {
    env_or("BUDDYSOCIALS_CLERK_ISSUER", baked!("BUDDYSOCIALS_BUILD_CLERK_ISSUER", "https://above-werewolf-7240.clerk.accounts.dev"))
}

/// The public OAuth client registered for this app in Clerk (PKCE, no secret).
pub fn clerk_client_id() -> String {
    env_or("BUDDYSOCIALS_CLERK_CLIENT_ID", baked!("BUDDYSOCIALS_BUILD_CLERK_CLIENT_ID", "X76MfpRB82VysHKp"))
}

/// The folder for files the app can rebuild: `~/Library/Caches` on macOS, `$XDG_CACHE_HOME` or `~/.cache` elsewhere.
pub fn cache_dir() -> Option<std::path::PathBuf> {
    user_dir("Library/Caches", "XDG_CACHE_HOME", ".cache")
}

/// The folder for files the app keeps: `~/Library/Application Support` on macOS, `$XDG_DATA_HOME` or `~/.local/share` elsewhere.
pub fn data_dir() -> Option<std::path::PathBuf> {
    user_dir("Library/Application Support", "XDG_DATA_HOME", ".local/share")
}

fn user_dir(mac: &str, xdg: &str, fallback: &str) -> Option<std::path::PathBuf> {
    let home = std::path::PathBuf::from(std::env::var_os("HOME")?);
    let base = if cfg!(target_os = "macos") {
        home.join(mac)
    } else {
        std::env::var_os(xdg).map(std::path::PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| home.join(fallback))
    };
    Some(base.join("BuddySocials"))
}
