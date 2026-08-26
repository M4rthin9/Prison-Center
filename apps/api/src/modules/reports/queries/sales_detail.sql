-- สรุปการขาย (p.12 #2) — one row per order line.
select
  o.ordered_at                                      as orderedAt,
  o.order_no                                        as orderNo,
  pr.name_th                                        as prisonName,
  oi.sku_snapshot                                   as sku,
  oi.name_snapshot                                  as productName,
  coalesce(oi.category_name_snapshot, '-')          as categoryName,
  oi.qty                                            as qty,
  coalesce(oi.unit_snapshot, '-')                   as unit,
  oi.unit_price_satang                              as unitPriceSatang,
  oi.line_total_satang                              as lineTotalSatang,
  cu.full_name                                      as senderName,
  cu.phone                                          as senderPhone,
  o.inmate_name_snapshot                            as inmateName,
  coalesce(o.zone_name_snapshot, '-')               as zoneName,
  o.inmate_code_snapshot                            as inmateCode,
  coalesce(o.note, '-')                             as note
from order_items oi
join orders o     on o.id  = oi.order_id
join prisons pr   on pr.id = o.prison_id
join customers cu on cu.id = o.customer_id
where (:prison_id is null or o.prison_id = :prison_id)
  and (:zone_id   is null or o.zone_id   = :zone_id)
  and (:shop_id   is null or o.shop_id   = :shop_id)
  and o.ordered_at between :from_ms and :to_ms
order by o.ordered_at, o.order_no, oi.created_at
