-- รายงานการชำระเงิน (p.12 #6) — succeeded vs failed, per rail, per channel.
select
  case when :group_fmt = 'all' then 'ทั้งช่วง'
       else strftime(:group_fmt, datetime(pay.created_at / 1000, 'unixepoch', '+7 hours'))
  end                                               as period,
  coalesce(pr.name_th, 'ส่วนกลาง')                   as prisonName,
  coalesce(ch.display_name, '-')                    as channelName,
  case pay.rail
    when 'tag30' then 'พร้อมเพย์ (tag 30)'
    when 'tag29' then 'โอนเข้าบัญชี (tag 29)'
    else pay.rail
  end                                               as rail,
  case pay.purpose
    when 'order'          then 'สั่งซื้อสินค้า'
    when 'deposit'        then 'ฝากเงิน'
    when 'letter_package' then 'แพ็กเกจจดหมาย'
    else pay.purpose
  end                                               as purpose,
  count(*)                                          as attemptCount,
  sum(case when pay.status = 'succeeded' then 1 else 0 end) as succeededCount,
  sum(case when pay.status in ('failed','expired') then 1 else 0 end) as failedCount,
  sum(case when pay.status = 'refunded' then 1 else 0 end)  as refundedCount,
  sum(case when pay.status in ('pending','awaiting_verify') then 1 else 0 end) as openCount,
  -- charge_satang is what the payer was actually asked for, salt included.
  sum(case when pay.status = 'succeeded' then pay.charge_satang else 0 end) as succeededSatang,
  sum(case when pay.status = 'refunded'  then pay.charge_satang else 0 end) as refundedSatang
from payments pay
left join prisons pr          on pr.id = pay.prison_id
left join payment_channels ch on ch.id = pay.channel_id
where (:prison_id is null or pay.prison_id = :prison_id)
  and pay.created_at between :from_ms and :to_ms
group by period, pr.name_th, ch.display_name, pay.rail, pay.purpose
order by period, prisonName, channelName, rail
