-- รายงานการขาย (p.12 #1) — one row per order.
-- Written as raw SQL on purpose: these are the queries you end up debugging
-- against an auditor, and a query builder's output is not something you can
-- paste into a sqlite shell.
select
  o.ordered_at                                      as orderedAt,
  o.order_no                                        as orderNo,
  pr.name_th                                        as prisonName,
  coalesce(o.zone_name_snapshot, '-')               as zoneName,
  s.name                                            as shopName,
  o.inmate_code_snapshot                            as inmateCode,
  o.inmate_name_snapshot                            as inmateName,
  cu.full_name                                      as customerName,
  cu.phone                                          as customerPhone,
  o.total_satang                                    as totalSatang,
  case o.payment_status
    when 'paid'            then 'ชำระแล้ว'
    when 'awaiting_verify' then 'รอตรวจสอบสลิป'
    when 'unpaid'          then 'ยังไม่ชำระ'
    when 'failed'          then 'ไม่สำเร็จ'
    when 'refunded'        then 'คืนเงินแล้ว'
    when 'expired'         then 'หมดอายุ'
    else o.payment_status
  end                                               as paymentStatus,
  o.paid_at                                         as paidAt,
  case when pay.slip_image_key is not null then 'มี' else '-' end as hasSlip,
  coalesce(pay.trans_ref, '-')                      as transRef
from orders o
join prisons pr    on pr.id = o.prison_id
join shops s       on s.id  = o.shop_id
join customers cu  on cu.id = o.customer_id
-- The settled payment is the one that carries the slip; a failed attempt on the
-- same order must not overwrite it in this column.
left join payments pay
  on pay.purpose = 'order' and pay.purpose_id = o.id and pay.status = 'succeeded'
where (:prison_id is null or o.prison_id = :prison_id)
  and (:zone_id   is null or o.zone_id   = :zone_id)
  and (:shop_id   is null or o.shop_id   = :shop_id)
  and o.ordered_at between :from_ms and :to_ms
order by o.ordered_at, o.order_no
