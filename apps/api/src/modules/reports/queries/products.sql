-- รายงานสินค้าที่มีการขาย (p.12 #3) — product × แดน × กองงาน.
-- Paid orders only: a basket nobody paid for is not a sale.
-- แดน comes from the order's snapshot (a transfer must not rewrite last
-- month's report, §4.1); กองงาน has no snapshot, so it is the inmate's current
-- work division and is labelled as such in the sheet header.
select
  case when :group_fmt = 'all' then 'ทั้งช่วง'
       else strftime(:group_fmt, datetime(o.ordered_at / 1000, 'unixepoch', '+7 hours'))
  end                                               as period,
  pr.name_th                                        as prisonName,
  oi.sku_snapshot                                   as sku,
  oi.name_snapshot                                  as productName,
  coalesce(o.zone_name_snapshot, '-')               as zoneName,
  coalesce(wd.name, '-')                            as workDivision,
  count(distinct o.id)                              as orderCount,
  sum(oi.qty)                                       as qty,
  sum(oi.line_total_satang)                         as totalSatang
from order_items oi
join orders o        on o.id  = oi.order_id
join prisons pr      on pr.id = o.prison_id
left join inmates im on im.id = o.inmate_id
left join work_divisions wd on wd.id = im.work_division_id
where (:prison_id is null or o.prison_id = :prison_id)
  and (:zone_id   is null or o.zone_id   = :zone_id)
  and (:shop_id   is null or o.shop_id   = :shop_id)
  and o.payment_status = 'paid'
  and o.ordered_at between :from_ms and :to_ms
group by period, pr.name_th, oi.sku_snapshot, oi.name_snapshot, o.zone_name_snapshot, wd.name
order by period, pr.name_th, sum(oi.line_total_satang) desc, oi.sku_snapshot
