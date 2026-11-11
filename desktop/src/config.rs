//! Where the app connects. These are public identifiers, not secrets; each can be
//! overridden with an environment variable to point a build at another deployment.

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| default.to_string())
}

pub fn convex_url() -> String {
    env_or("BUDDYSOCIALS_CONVEX_URL", "https://perfect-vole-798.convex.cloud")
}

/// The Clerk instance's Frontend API URL, which is also its OpenID issuer.
pub fn clerk_issuer() -> String {
    env_or("BUDDYSOCIALS_CLERK_ISSUER", "https://above-werewolf-7240.clerk.accounts.dev")
}

/// The public OAuth client registered for this app in Clerk (PKCE, no secret).
pub fn clerk_client_id() -> String {
    env_or("BUDDYSOCIALS_CLERK_CLIENT_ID", "X76MfpRB82VysHKp")
}
