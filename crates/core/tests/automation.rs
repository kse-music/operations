use chrono::{TimeZone, Utc};
use serverdeck_core::automation::*;
fn at(y: i32, m: u32, d: u32, h: u32, n: u32) -> u64 {
    Utc.with_ymd_and_hms(y, m, d, h, n, 0)
        .single()
        .unwrap()
        .timestamp_millis() as u64
}
#[test]
fn daily_weekly_and_fixed_offset_are_deterministic() {
    assert_eq!(
        calendar::next(
            &Timing::Daily {
                hour: 8,
                minute: 30
            },
            480,
            at(2026, 11, 1, 0, 31)
        )
        .unwrap(),
        at(2026, 11, 2, 0, 30)
    );
    assert_eq!(
        calendar::next(
            &Timing::Weekly {
                weekday: 1,
                hour: 9,
                minute: 0
            },
            0,
            at(2026, 11, 1, 10, 0)
        )
        .unwrap(),
        at(2026, 11, 2, 9, 0)
    );
    assert_eq!(
        calendar::next(
            &Timing::Daily { hour: 0, minute: 0 },
            -300,
            at(2026, 11, 1, 0, 0)
        )
        .unwrap(),
        at(2026, 11, 1, 5, 0)
    );
}
#[test]
fn cron_ranges_lists_steps_sunday_or_and_leap_year() {
    for (expr, start, want) in [
        ("*/5 * * * *", at(2026, 11, 1, 0, 1), at(2026, 11, 1, 0, 5)),
        ("0 9 * * 1-5", at(2026, 11, 1, 10, 0), at(2026, 11, 2, 9, 0)),
        ("0 9 1 * 1", at(2026, 11, 2, 9, 0), at(2026, 11, 9, 9, 0)),
        ("0 0 * * 7", at(2026, 11, 1, 0, 0), at(2026, 11, 8, 0, 0)),
        (
            "15,45 8-10/2 * * *",
            at(2026, 11, 1, 8, 46),
            at(2026, 11, 1, 10, 15),
        ),
        ("0 0 29 2 *", at(2024, 3, 1, 0, 0), at(2028, 2, 29, 0, 0)),
    ] {
        assert_eq!(
            calendar::next(
                &Timing::Cron {
                    expression: expr.into()
                },
                0,
                start
            )
            .unwrap(),
            want,
            "{expr}"
        );
    }
}
#[test]
fn cron_invalid_and_impossible_dates_reject() {
    for expr in [
        "* * * * * *",
        "*/0 * * * *",
        "0 24 * * *",
        "0 0 31 2 *",
        "0 0 * JAN *",
        "@daily",
        "0 0 * * 9",
        "1--3 * * * *",
    ] {
        assert!(
            calendar::next(
                &Timing::Cron {
                    expression: expr.into()
                },
                0,
                at(2026, 11, 1, 0, 0)
            )
            .is_err(),
            "{expr}"
        );
    }
    assert!(calendar::next(&Timing::Daily { hour: 0, minute: 0 }, 900, 0).is_err());
}
#[test]
fn parameter_definitions_and_secret_defaults_are_validated() {
    let mut e = templates().pop().unwrap();
    e.parameters[0].secret = true;
    e.parameters[0].default = Some("no plaintext default".into());
    assert!(e.validate().is_err());
    e.parameters[0].default = None;
    assert!(e.validate().is_ok());
    e.parameters[1].name = e.parameters[0].name.clone();
    assert!(e.validate().is_err());
    e = templates()[0].clone();
    e.body.push('\0');
    assert!(e.validate().is_err());
    for t in templates() {
        t.validate().unwrap();
    }
}
#[test]
fn parameter_values_are_ordered_not_interpolated_and_secrets_not_public() {
    let mut e = templates().pop().unwrap();
    e.parameters[0].kind = ParameterKind::Text;
    e.parameters[0].secret = true;
    e.parameters[0].default = None;
    let literal = "中文 space; $(touch /data/never) ' \"\n";
    let input = [
        ("host".to_string(), zeroize::Zeroizing::new(literal.into())),
        ("port".into(), zeroize::Zeroizing::new("22".into())),
    ]
    .into_iter()
    .collect();
    let (args, public, secrets) = values(&e, &input).unwrap();
    assert_eq!(args[0].as_str(), literal);
    assert_eq!(args[1].as_str(), "22");
    assert!(secrets);
    assert!(!public.contains_key("host"));
    assert_eq!(public["port"], "22");
    assert!(!e.body.contains(literal));
}
#[test]
fn unknown_cannot_be_aggregated_as_success() {
    let t = Target {
        host_id: uuid::Uuid::new_v4().to_string(),
        name: "test".into(),
        hostname: "localhost".into(),
        port: 22,
        username: "test".into(),
        route_signature: "metadata".into(),
    };
    let e = Entry {
        id: uuid::Uuid::new_v4().to_string(),
        revision: 1,
        input: templates()[0].clone(),
        updated_at: 0,
    };
    let mut r = Run::new(
        RunSpec {
            entry: e,
            targets: vec![t.clone(), t],
            parameters: Default::default(),
            has_secrets: false,
            concurrency: 1,
            timeout_secs: 3,
        },
        0,
    );
    r.rows[0].state = State::Success;
    r.rows[1].state = State::Unknown;
    assert_eq!(aggregate(&r.rows), State::Unknown);
    r.rows[1].state = State::Cancelled;
    assert_eq!(aggregate(&r.rows), State::Cancelled);
}
