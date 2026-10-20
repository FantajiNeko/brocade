use brocade_core::model::{
    ExternalOutboundSecurity, ModelSettings, RealitySite, DEFAULT_TLS_FINGERPRINT,
};
use serde_json::json;

#[test]
fn online_sources_default_to_enabled_and_preserve_explicit_opt_out() {
    let settings = ModelSettings::default();
    assert!(settings.stats_user_online);
    let mut wire = serde_json::to_value(settings).unwrap();
    wire.as_object_mut().unwrap().remove("stats_user_online");
    let omitted: ModelSettings = serde_json::from_value(wire.clone()).unwrap();
    assert!(omitted.stats_user_online);
    wire["stats_user_online"] = json!(false);
    let disabled: ModelSettings = serde_json::from_value(wire).unwrap();
    assert!(!disabled.stats_user_online);
}

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
