//! Bounded machine throughput history, projected from measured accounting windows.
//! Retention gaps stay unknown; daily ledger totals cannot reconstruct a traffic waveform.
use brocade_deployment::{site_usage::SiteUsagePeriod, source_traffic::TrafficTimeRange};
use serde::Serialize;
use sqlx::PgPool;

use crate::{AdminContext, Result, UserTrafficHistory, UserTrafficHistoryScope};

#[derive(Debug, Serialize)]
pub struct NodeTrafficHistory {
    pub range_start_unix_secs: i64,
    pub range_end_unix_secs: i64,
    pub bucket_secs: i64,
    /// Bucket end, uplink B/s, downlink B/s. Rates average only observed intervals.
    pub points: Vec<(i64, Option<f64>, Option<f64>)>,
    /// Bytes whose measured intervals overlap this range, excluding unplaced legacy readings.
    pub recorded_bytes: f64,
    pub has_gap: bool,
    pub has_unplaced: bool,
}

pub(crate) async fn query(
    pool: &PgPool,
    actor: &AdminContext,
    node: &str,
    period: SiteUsagePeriod,
    range: Option<TrafficTimeRange>,
) -> Result<NodeTrafficHistory> {
    let bounds = crate::site_usage::range_bounds(pool, period, range).await?;
    let bucket_secs = match range {
        Some(range) => match range.end_unix_secs - range.start_unix_secs {
            ..=3_600 => 30,
            3_601..=86_400 => 300,
            86_401..=604_800 => 900,
            _ => 3_600,
        },
        None => match period {
            SiteUsagePeriod::Day => 300,
            SiteUsagePeriod::Week => 900,
            SiteUsagePeriod::Month => 3_600,
        },
    };
    let history = crate::usage::traffic_history_range(
        pool,
        actor,
        UserTrafficHistoryScope::Node(node),
        bounds.start,
        bounds.now,
        true,
    )
    .await?;
    Ok(summarize(history, bucket_secs))
}

type Interval = (f64, f64);

fn union(mut windows: Vec<Interval>) -> Vec<Interval> {
    windows.retain(|&(start, end)| start < end);
    windows.sort_unstable_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
    let mut merged: Vec<Interval> = Vec::new();
    for (start, end) in windows {
        if let Some(last) = merged.last_mut().filter(|last| start <= last.1) {
            last.1 = last.1.max(end);
        } else {
            merged.push((start, end));
        }
    }
    merged
}

fn without_zeros(start: f64, end: f64, zeros: &[Interval]) -> Vec<Interval> {
    let mut cursor = start;
    let mut active = Vec::new();
    for &(zero_start, zero_end) in zeros {
        if zero_end <= cursor {
            continue;
        }
        if zero_start >= end {
            break;
        }
        if cursor < zero_start {
            active.push((cursor, zero_start.min(end)));
        }
        cursor = cursor.max(zero_end);
    }
    if cursor < end {
        active.push((cursor, end));
    }
    active
}

/// Visit only buckets touched by an interval, so a month of 30-second windows stays linear.
fn overlaps(
    start: f64,
    end: f64,
    range_start: i64,
    step: i64,
    count: usize,
    mut visit: impl FnMut(usize, f64),
) {
    let first = (((start - range_start as f64) / step as f64).floor() as i64).max(0) as usize;
    let last = (((end - range_start as f64) / step as f64).ceil() as i64).max(0) as usize;
    for index in first..last.min(count) {
        let bucket_start = (range_start + index as i64 * step) as f64;
        let duration = end.min(bucket_start + step as f64) - start.max(bucket_start);
        if duration > 0.0 {
            visit(index, duration);
        }
    }
}

fn summarize(history: UserTrafficHistory, step: i64) -> NodeTrafficHistory {
    let start = history.range_start_unix_secs;
    let end = history.range_end_unix_secs;
    let count = ((end - start).max(0) + step - 1) / step;
    let count = count as usize;
    let mut rates = vec![(0.0, 0.0); count];
    let mut known = vec![true; count];
    let mut has_gap = false;
    let mut has_unplaced = false;
    let mut recorded_bytes = 0.0;
    let mut sources = 0;
    for forwarding in [false, true] {
        let zeros = if forwarding {
            Vec::new()
        } else {
            union(
                history
                    .nodes
                    .iter()
                    .flat_map(|node| {
                        node.zero_windows
                            .iter()
                            .map(|&(a, b)| (a as f64 / 1000.0, b as f64 / 1000.0))
                    })
                    .collect(),
            )
        };
        let coverage = union(
            history
                .nodes
                .iter()
                .flat_map(|node| {
                    if forwarding {
                        &node.forwarding_windows
                    } else {
                        &node.windows
                    }
                })
                .map(|&(a, b)| (a as f64, b as f64))
                .chain(
                    history
                        .series
                        .iter()
                        .filter(|series| series.forwarding == forwarding)
                        .flat_map(|series| {
                            series
                                .windows
                                .iter()
                                .map(|&(a, b, _, _)| (a as f64, b as f64))
                        }),
                )
                .chain(zeros.iter().copied())
                .collect(),
        );
        let entries = history
            .series
            .iter()
            .filter(|series| series.forwarding == forwarding);
        let mut up = vec![0.0; count];
        let mut down = vec![0.0; count];
        let mut observed = vec![0.0; count];
        let mut source_unplaced = false;
        for (a, b) in &coverage {
            overlaps(
                a.max(start as f64),
                b.min(end as f64),
                start,
                step,
                count,
                |i, secs| observed[i] += secs,
            );
        }
        for entry in entries {
            source_unplaced |= entry.unplaced_uplink_bytes > 0 || entry.unplaced_downlink_bytes > 0;
            for &(a, b, u, d) in &entry.windows {
                let active = without_zeros(a as f64, b as f64, &zeros);
                let duration: f64 = active.iter().map(|(a, b)| b - a).sum();
                if duration <= 0.0 {
                    continue;
                }
                for (a, b) in active {
                    overlaps(
                        a.max(start as f64),
                        b.min(end as f64),
                        start,
                        step,
                        count,
                        |i, secs| {
                            up[i] += u as f64 * secs / duration;
                            down[i] += d as f64 * secs / duration;
                        },
                    );
                }
            }
        }
        recorded_bytes += up.iter().sum::<f64>() + down.iter().sum::<f64>();
        has_unplaced |= source_unplaced;
        if coverage.is_empty() && !source_unplaced {
            continue;
        }
        sources += 1;
        for i in 0..count {
            let bucket_end = end.min(start + (i as i64 + 1) * step);
            let duration = (bucket_end - (start + i as i64 * step)) as f64;
            if observed[i] <= 0.0 {
                known[i] = false;
            } else {
                rates[i].0 += up[i] / observed[i];
                rates[i].1 += down[i] / observed[i];
            }
            has_gap |= observed[i] + 0.001 < duration;
        }
    }
    NodeTrafficHistory {
        range_start_unix_secs: start,
        range_end_unix_secs: end,
        bucket_secs: step,
        points: rates
            .into_iter()
            .enumerate()
            .map(|(i, (up, down))| {
                let known = sources > 0 && known[i];
                (
                    end.min(start + (i as i64 + 1) * step),
                    known.then_some(up),
                    known.then_some(down),
                )
            })
            .collect(),
        recorded_bytes,
        has_gap: has_gap || sources == 0,
        has_unplaced,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{UserTrafficHistoryNode, UserTrafficHistorySeries};

    fn history(end: i64) -> UserTrafficHistory {
        UserTrafficHistory {
            range_start_unix_secs: 0,
            range_end_unix_secs: end,
            nodes: vec![UserTrafficHistoryNode {
                node_id: "n1".into(),
                window_ends_unix_secs: vec![],
                windows: vec![],
                zero_windows: vec![],
                forwarding_windows: vec![],
            }],
            series: vec![],
        }
    }
    fn series(forwarding: bool, windows: Vec<(i64, i64, u64, u64)>) -> UserTrafficHistorySeries {
        UserTrafficHistorySeries {
            node_id: "n1".into(),
            tenant_id: String::new(),
            user_id: String::new(),
            points: vec![],
            windows,
            forwarding,
            unplaced_uplink_bytes: 0,
            unplaced_downlink_bytes: 0,
        }
    }
    #[test]
    fn missing_idle_and_partial_windows_are_distinct() {
        let mut input = history(120);
        input.nodes[0].windows = vec![(30, 60), (90, 105)];
        input.series.push(series(false, vec![(90, 105, 150, 300)]));
        let output = summarize(input, 30);
        assert_eq!(
            output.points,
            vec![
                (30, None, None),
                (60, Some(0.0), Some(0.0)),
                (90, None, None),
                (120, Some(10.0), Some(20.0))
            ]
        );
        assert_eq!(output.recorded_bytes, 450.0);
        assert!(output.has_gap);
    }
    #[test]
    fn restart_zeros_do_not_dilute_the_active_window() {
        let mut input = history(90);
        input.nodes[0].windows = vec![(0, 90)];
        input.nodes[0].zero_windows = vec![(30_000, 60_000)];
        input.series.push(series(false, vec![(0, 90, 600, 1200)]));
        let output = summarize(input, 30);
        assert_eq!(
            output.points,
            vec![
                (30, Some(10.0), Some(20.0)),
                (60, Some(0.0), Some(0.0)),
                (90, Some(10.0), Some(20.0))
            ]
        );
        assert_eq!(output.recorded_bytes, 1800.0);
        assert!(!output.has_gap);
    }
    #[test]
    fn sums_sources_without_treating_missing_forwarding_as_zero() {
        let mut input = history(90);
        input.nodes[0].windows = vec![(0, 90)];
        input.nodes[0].forwarding_windows = vec![(0, 30), (60, 90)];
        input.series.push(series(false, vec![(0, 90, 900, 1800)]));
        let mut forwarded = series(true, vec![(0, 30, 300, 600)]);
        forwarded.unplaced_downlink_bytes = 999;
        input.series.push(forwarded);
        let output = summarize(input, 30);
        assert_eq!(
            output.points,
            vec![
                (30, Some(20.0), Some(40.0)),
                (60, None, None),
                (90, Some(10.0), Some(20.0))
            ]
        );
        assert_eq!(output.recorded_bytes, 3600.0);
        assert!(output.has_gap && output.has_unplaced);
    }
    #[test]
    fn different_measurement_bounds_keep_their_own_byte_distribution() {
        let mut input = history(600);
        input
            .series
            .push(series(false, vec![(0, 600, 600, 0), (300, 600, 600, 0)]));
        let output = summarize(input, 300);
        assert_eq!(
            output.points,
            vec![(300, Some(1.0), Some(0.0)), (600, Some(3.0), Some(0.0))]
        );
        assert_eq!(output.recorded_bytes, 1200.0);
    }
    #[test]
    fn month_is_bounded_and_clips_partial_edges() {
        let mut input = history(31 * 86_400);
        input.range_start_unix_secs = 15;
        input.series.push(series(false, vec![(0, 30, 300, 600)]));
        let output = summarize(input, 3600);
        assert_eq!(output.points.len(), 744);
        assert_eq!(output.recorded_bytes, 450.0);
        assert_eq!(output.points[0], (3615, Some(10.0), Some(20.0)));
        assert_eq!(output.points.last().unwrap().0, 31 * 86_400);
        assert_eq!(output.points[1].1, None);
    }
}
