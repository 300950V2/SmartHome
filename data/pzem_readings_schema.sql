-- รันไฟล์นี้ใน Supabase SQL Editor ครั้งเดียว (Project > SQL Editor > New query)
-- รันซ้ำได้ ไม่พัง (idempotent) ใช้ได้ทั้งตอนสร้างใหม่ และตอนอัปเกรดจากตารางเวอร์ชันเก่า
--
-- แนวคิดใหม่: ตาราง pzem_readings ตารางเดียว เก็บค่า PZEM ทุกแถวเหมือนกันหมด
-- ไม่มีคอลัมน์ source / daily_kwh แล้ว (ข้อมูลจำลองกับของจริงอยู่ปนกันเป็นเนื้อเดียว แยกไม่ออกโดยตั้งใจ)
-- หน่วยไฟรายวันคำนวณจากผลต่างของ energy สะสม (Wh) ผ่านฟังก์ชัน pzem_daily_usage() ด้านล่าง

create table if not exists pzem_readings (
  id bigint generated always as identity primary key,
  recorded_at timestamptz not null default now(),
  voltage numeric,
  current numeric,
  power numeric,
  energy numeric,          -- พลังงานสะสม (cumulative) หน่วย Wh เหมือนที่ PZEM จริงรายงาน
  frequency numeric,
  power_factor numeric
);

create index if not exists idx_pzem_readings_recorded_at on pzem_readings (recorded_at);

-- ---------------------------------------------------------------------------
-- อัปเกรดจากตารางเวอร์ชันเก่า (ที่มีคอลัมน์ source): ลบแถวจำลองชุดเก่าทิ้ง แล้วตัดคอลัมน์ source ออก
-- (ชุดเก่าสร้างด้วยเวลา UTC ทำให้โค้งการใช้ไฟเลื่อนไป 7 ชม. จึงต้องสร้างใหม่ด้วย seed_simulated_pzem.js)
-- แถวที่เป็นของจริง (source = 'live') ไม่ถูกแตะ ถ้าตารางเป็นแบบใหม่อยู่แล้วบล็อกนี้จะไม่ทำอะไร
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'pzem_readings' and column_name = 'source'
  ) then
    execute 'delete from pzem_readings where source = ''simulated''';
    execute 'alter table pzem_readings drop column source';
  end if;
end $$;

alter table pzem_readings drop column if exists daily_kwh;

-- ปิดไม่ให้ anon/authenticated key อ่านตารางตรงๆ (เซิร์ฟเวอร์ใช้ service_role key ซึ่งข้าม RLS อยู่แล้ว)
alter table pzem_readings enable row level security;

-- ---------------------------------------------------------------------------
-- pzem_daily_usage(p_days): หน่วยไฟ (kWh) รายวัน ย้อนหลัง p_days วัน นับวันตามเวลาไทย (Asia/Bangkok)
--   - คำนวณจากผลรวมของ "energy ที่เพิ่มขึ้น" ระหว่างแต่ละ reading กับ reading ก่อนหน้า
--   - ข้ามกรณีที่ energy ลดลง (PZEM ถูกรีเซ็ตตัวนับ)
--   - ข้ามกรณีที่ reading ห่างกันเกิน p_max_gap_minutes นาที (ค่าเริ่มต้น 180 = 3 ชม.) เพราะแปลว่าบอร์ดหลุดนาน
--     หรือเป็นรอยต่อระหว่างช่วงข้อมูลที่ตัวนับคนละชุดกัน — กันไม่ให้ค่ากระโดดมาโผล่เป็นยอดใช้ไฟของวันนั้น
--   - คืนครบทุกวันในช่วง วันไหนไม่มีข้อมูลเลยจะได้ kwh = null (กราฟจะลากเส้นต่อข้ามให้)
--   - วันนี้จะเป็นยอดสะสมถึงตอนนี้ (ยังไม่จบวัน)
-- ใช้ SQL แทนการ select แถวทั้งหมดมาคำนวณฝั่ง Node เพราะ Supabase จำกัด 1,000 แถวต่อคำขอ
-- แต่ข้อมูลรายนาทีมีวันละ 1,440 แถว
-- ---------------------------------------------------------------------------
create or replace function pzem_daily_usage(p_days int default 60, p_max_gap_minutes int default 180)
returns table (usage_date date, kwh numeric)
language sql
stable
as $$
  with bounds as (
    select ((now() at time zone 'Asia/Bangkok')::date - (greatest(p_days, 1) - 1)) as d0,
           (now() at time zone 'Asia/Bangkok')::date as d1
  ),
  base as (
    select r.recorded_at,
           r.energy,
           lag(r.energy) over w as prev_energy,
           lag(r.recorded_at) over w as prev_at
    from pzem_readings r, bounds b
    where r.energy is not null
      and r.recorded_at >= ((b.d0 - 1)::timestamp at time zone 'Asia/Bangkok')  -- ย้อนเผื่อ 1 วัน ให้ reading แรกของช่วงมีตัวเทียบ
    window w as (order by r.recorded_at)
  ),
  daily as (
    select (recorded_at at time zone 'Asia/Bangkok')::date as d,
           sum(energy - prev_energy) / 1000.0 as kwh
    from base
    where prev_energy is not null
      and energy >= prev_energy
      and recorded_at - prev_at <= make_interval(mins => p_max_gap_minutes)
    group by 1
  )
  select g::date as usage_date,
         round(daily.kwh::numeric, 2) as kwh
  from bounds b
  cross join generate_series(b.d0::timestamp, b.d1::timestamp, interval '1 day') as g
  left join daily on daily.d = g::date
  order by 1;
$$;

-- ให้เรียกได้เฉพาะฝั่งเซิร์ฟเวอร์ (service_role) ไม่เปิดให้ anon เรียกผ่าน API ตรงๆ
revoke all on function pzem_daily_usage(int, int) from public;
revoke all on function pzem_daily_usage(int, int) from anon, authenticated;
grant execute on function pzem_daily_usage(int, int) to service_role;

comment on table pzem_readings is 'ค่าไฟฟ้าจาก PZEM ทุก reading (รายนาที) รวมทั้งช่วงที่ backfill ย้อนหลัง — ตารางเดียวไม่แยกที่มา';
