-- รันไฟล์นี้ใน Supabase SQL Editor ครั้งเดียว (Project > SQL Editor > New query)
--
-- ตาราง pzem_readings: เก็บค่าไฟฟ้าจาก PZEM ทุก reading (ทั้งของจริงจาก ESP และข้อมูลจำลองย้อนหลัง)
-- ใช้ source แยกว่าแถวไหนเป็นของจริง ('live') หรือข้อมูลจำลอง ('simulated')
-- เพื่อให้กราฟเทรนด์ดึงมาต่อกันเป็นเส้นเดียวได้ปกติ แต่ UI ยังรู้และ query แยกได้ว่าช่วงไหนเป็นของจริง/จำลอง
-- (สำคัญ: ห้ามตัดคอลัมน์นี้ทิ้ง ไม่งั้นจะไม่มีทางแยกข้อมูลจำลองออกจากของจริงได้อีกเลยในอนาคต)

create table if not exists pzem_readings (
  id bigint generated always as identity primary key,
  recorded_at timestamptz not null default now(),
  voltage numeric,
  current numeric,
  power numeric,
  energy numeric,          -- ค่าพลังงานสะสม (cumulative) หน่วย Wh เหมือนที่ PZEM จริงรายงาน
  daily_kwh numeric,       -- หน่วยไฟที่ใช้เฉพาะ "วันนั้น" (kWh) สำหรับกราฟรายวันโดยตรง ไม่ต้องมานั่ง diff เอง
  frequency numeric,
  power_factor numeric,
  source text not null default 'live' check (source in ('live', 'simulated'))
);

create index if not exists idx_pzem_readings_recorded_at on pzem_readings (recorded_at);
create index if not exists idx_pzem_readings_source on pzem_readings (source);

comment on table pzem_readings is 'ค่าไฟฟ้าจาก PZEM: source=live คือของจริงจาก ESP, source=simulated คือข้อมูลจำลองที่ backfill จาก Excel ย้อนหลัง (ก.ย.-ต.ค. 2569) ใช้โชว์กราฟเทรนด์ก่อนเริ่มเก็บข้อมูลจริง';
