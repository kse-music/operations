use super::*;
use chrono::{Datelike, FixedOffset, NaiveDate, TimeZone};
use std::collections::BTreeSet;
struct Field {
    set: BTreeSet<u32>,
    star: bool,
}
fn field(s: &str, min: u32, max: u32) -> Result<Field, Error> {
    let mut set = BTreeSet::new();
    if s.is_empty() || s.len() > 100 {
        return Err(Error::Validation("Cron 字段为空或过长"));
    }
    for item in s.split(',') {
        let mut slash = item.split('/');
        let base = slash.next().unwrap_or("");
        let step = slash
            .next()
            .map(|v| v.parse::<u32>())
            .transpose()
            .map_err(|_| Error::Validation("Cron 步长无效"))?
            .unwrap_or(1);
        if step == 0 || step > max + 1 || slash.next().is_some() {
            return Err(Error::Validation("Cron 步长无效"));
        }
        let number = |v: &str| {
            v.parse::<u32>()
                .ok()
                .filter(|n| *n >= min && *n <= max)
                .ok_or(Error::Validation("Cron 数值超出字段范围"))
        };
        let (start, end) = if base == "*" {
            (min, max)
        } else if let Some((a, b)) = base.split_once('-') {
            (number(a)?, number(b)?)
        } else {
            let a = number(base)?;
            (a, if item.contains('/') { max } else { a })
        };
        if start > end {
            return Err(Error::Validation("Cron 范围倒置"));
        }
        for v in (start..=end).step_by(step as usize) {
            set.insert(v);
        }
    }
    Ok(Field {
        set,
        star: s.starts_with('*'),
    })
}
pub fn next(timing: &Timing, offset_minutes: i16, after: u64) -> Result<u64, Error> {
    if !(-720..=840).contains(&offset_minutes) {
        return Err(Error::Validation("时区固定偏移须为 UTC−12:00 至 UTC+14:00"));
    }
    let expression = match timing {
        Timing::Daily { hour, minute } => {
            if *hour > 23 || *minute > 59 {
                return Err(Error::Validation("时/分超出范围"));
            }
            format!("{minute} {hour} * * *")
        }
        Timing::Weekly {
            weekday,
            hour,
            minute,
        } => {
            if *weekday > 6 || *hour > 23 || *minute > 59 {
                return Err(Error::Validation("星期或时/分超出范围"));
            }
            format!("{minute} {hour} * * {weekday}")
        }
        Timing::Cron { expression } => expression.clone(),
    };
    if expression.len() > 256 {
        return Err(Error::Validation("Cron 表达式过长"));
    }
    let fields = expression.split_whitespace().collect::<Vec<_>>();
    if fields.len() != 5 {
        return Err(Error::Validation(
            "Cron 使用五字段：分 时 日 月 星期；不支持秒、名称、L/W/#/@",
        ));
    }
    let minute = field(fields[0], 0, 59)?;
    let hour = field(fields[1], 0, 23)?;
    let day = field(fields[2], 1, 31)?;
    let month = field(fields[3], 1, 12)?;
    let mut weekday = field(fields[4], 0, 7)?;
    if weekday.set.remove(&7) {
        weekday.set.insert(0);
    }
    let tz = FixedOffset::east_opt(i32::from(offset_minutes) * 60)
        .ok_or(Error::Validation("时区无效"))?;
    let after_i64 = i64::try_from(after).map_err(|_| Error::Validation("时间超出范围"))?;
    let start = tz
        .timestamp_millis_opt(after_i64)
        .single()
        .ok_or(Error::Validation("时间超出范围"))?
        .date_naive();
    for days in 0..=366 * 5 {
        let date: NaiveDate = start
            .checked_add_days(chrono::Days::new(days))
            .ok_or(Error::Validation("日历溢出"))?;
        if !month.set.contains(&date.month()) {
            continue;
        }
        let dom = day.set.contains(&date.day());
        let dow = weekday.set.contains(&date.weekday().num_days_from_sunday());
        let matches = if day.star || weekday.star {
            dom && dow
        } else {
            dom || dow
        };
        if !matches {
            continue;
        }
        for h in &hour.set {
            for m in &minute.set {
                let candidate = date
                    .and_hms_opt(*h, *m, 0)
                    .ok_or(Error::Validation("日历时间无效"))?;
                let stamp = tz
                    .from_local_datetime(&candidate)
                    .single()
                    .ok_or(Error::Validation("日历时间无效"))?
                    .timestamp_millis();
                if stamp > after_i64 {
                    return Ok(stamp as u64);
                }
            }
        }
    }
    Err(Error::Validation("计划在未来五年没有有效触发时间"))
}
