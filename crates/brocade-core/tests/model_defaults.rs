use brocade_core::model::{ExternalOutboundSecurity, RealitySite, DEFAULT_TLS_FINGERPRINT};
use serde_json::json;

#[test]
fn new_tls_defaults_use_safari_without_overwriting_explicit_fingerprints() {
    assert_eq!(DEFAULT_TLS_FINGERPRINT, "safari");
    assert_eq!(
        RealitySite::default().fingerprint.as_deref(),
        Some("safari")
    );
    for mut wire in [
        json!({"t":"tls","v":{"server_name":"tls.example"}}),
        json!({"t":"reality","v":{"server_name":"reality.example","public_key":"test","short_id":"00"}}),
    ] {
        let parsed: ExternalOutboundSecurity = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(
            serde_json::to_value(parsed).unwrap()["v"]["fingerprint"],
            "safari"
        );
        for explicit in ["chrome", "firefox", "safari", "none"] {
            wire["v"]["fingerprint"] = json!(explicit);
            let parsed: ExternalOutboundSecurity = serde_json::from_value(wire.clone()).unwrap();
            assert_eq!(
                serde_json::to_value(parsed).unwrap()["v"]["fingerprint"],
                explicit
            );
        }
    }
}
