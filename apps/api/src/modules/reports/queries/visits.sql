-- รายงานการเยี่ยม (p.12 #4) — per prison, per แดน, per รอบ, per period.
-- Grouped on the visit date, not the booking date: the facility counts the day
-- the visitor stood at the gate. `visit_date` is already a Bangkok `YYYY-MM-DD`
-- string, so no timezone shift is applied here.
select
  case when :group_fmt = 'all' then 'ทั้งช่วง'
       else strftime(:group_fmt, vb.visit_date)
  end                                               as period,
  pr.name_th                                        as prisonName,
  coalesce(vb.zone_name_snapshot, '-')              as zoneName,
  vb.round_label_snapshot                           as roundLabel,
  count(*)                                          as bookingCount,
  sum(case when vb.status in ('pending','confirmed','checked_in','no_show') then 1 else 0 end) as bookedCount,
  sum(case when vb.status = 'checked_in' then 1 else 0 end) as checkedInCount,
  sum(case when vb.status = 'cancelled'  then 1 else 0 end) as cancelledCount,
  sum(case when vb.status = 'no_show'    then 1 else 0 end) as noShowCount,
  sum(case when vb.status in ('pending','confirmed','checked_in','no_show')
           then vb.visitor_count else 0 end)        as visitorCount
from visit_bookings vb
join prisons pr on pr.id = vb.prison_id
where (:prison_id is null or vb.prison_id = :prison_id)
  and (:zone_id   is null or vb.zone_id   = :zone_id)
  and vb.visit_date between :from_date and :to_date
group by period, pr.name_th, vb.zone_name_snapshot, vb.round_label_snapshot
order by period, pr.name_th, vb.zone_name_snapshot, vb.round_label_snapshot
