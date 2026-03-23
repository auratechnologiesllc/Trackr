use std::env;

fn main() {
    println!("cargo:rerun-if-env-changed=TRACKR_PAYWALL_PUBLIC_KEY_DER_BASE64");

    if env::var("PROFILE").as_deref() == Ok("release") {
        let key = env::var("TRACKR_PAYWALL_PUBLIC_KEY_DER_BASE64")
            .ok()
            .map(|value| value.trim().to_string())
            .unwrap_or_default();

        assert!(
            !key.is_empty(),
            "TRACKR_PAYWALL_PUBLIC_KEY_DER_BASE64 must be set for release builds."
        );
    }

    tauri_build::build()
}
