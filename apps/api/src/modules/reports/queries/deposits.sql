-- รายงานสรุปยอดการฝากเงิน (p.12 #7) — per prison, per แดน, per period.
select
  case when :group_fmt = 'all' then 'ทั้งช่วง'
       else strftime(:group_fmt, datetime(d.created_at / 1000, 'unixepoch', '+7 hours'))
  end                                               as period,
  pr.name_th                                        as prisonName,
  coalesce(d.zone_name_snapshot, '-')               as zoneName,
  count(*)                                          as depositCount,
  sum(case when d.status = 'pending'   then 1 else 0 end) as pendingCount,
  sum(case when d.status = 'reviewing' then 1 else 0 end) as reviewingCount,
  sum(case when d.status = 'completed' then 1 else 0 end) as completedCount,
  sum(case when d.status in ('rejected','cancelled') then 1 else 0 end) as rejectedCount,
  -- Received = slip verified, credited to the inmate's account or not yet.
  sum(case when d.status in ('reviewing','completed') then d.amount_satang else 0 end) as receivedSatang,
  sum(case when d.status = 'completed' then d.amount_satang else 0 end) as completedSatang
from deposits d
join prisons pr on pr.id = d.prison_id
where (:prison_id is null or d.prison_id = :prison_id)
  and (:zone_id   is null or d.zone_id   = :zone_id)
  and d.created_at between :from_ms and :to_ms
group by period, pr.name_th, d.zone_name_snapshot
order by period, pr.name_th, d.zone_name_snapshot
