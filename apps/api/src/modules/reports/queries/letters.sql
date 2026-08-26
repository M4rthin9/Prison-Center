-- รายงานจดหมายอิเล็กทรอนิกส์ (p.12 #5) — outbound and inbound, per แดน.
select
  case when :group_fmt = 'all' then 'ทั้งช่วง'
       else strftime(:group_fmt, datetime(l.created_at / 1000, 'unixepoch', '+7 hours'))
  end                                               as period,
  pr.name_th                                        as prisonName,
  coalesce(l.zone_name_snapshot, '-')               as zoneName,
  case l.direction
    when 'to_prison' then 'ญาติ → ผู้ต้องขัง'
    when 'to_home'   then 'ผู้ต้องขัง → ญาติ'
    else l.direction
  end                                               as direction,
  count(*)                                          as letterCount,
  sum(case when l.status in ('queued','pending_print') then 1 else 0 end) as awaitingPrintCount,
  sum(case when l.status = 'printed'    then 1 else 0 end) as printedCount,
  sum(case when l.status = 'dispatched' then 1 else 0 end) as dispatchedCount,
  sum(case when l.status = 'delivered'  then 1 else 0 end) as deliveredCount,
  sum(case when l.status = 'rejected'   then 1 else 0 end) as rejectedCount,
  sum(l.attachment_count)                           as attachmentCount
from letters l
join prisons pr on pr.id = l.prison_id
where (:prison_id is null or l.prison_id = :prison_id)
  and (:zone_id   is null or l.zone_id   = :zone_id)
  -- A draft is not correspondence until it is submitted.
  and l.status <> 'draft'
  and l.created_at between :from_ms and :to_ms
group by period, pr.name_th, l.zone_name_snapshot, l.direction
order by period, pr.name_th, l.zone_name_snapshot, l.direction
