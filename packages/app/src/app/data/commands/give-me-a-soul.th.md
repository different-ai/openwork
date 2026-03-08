---
name: give-me-a-soul
description: เปิดใช้งาน Soul Mode (หน่วยความจำถาวร + heartbeat + คำสั่งควบคุม + ย้อนกลับได้ง่าย)
---

กำหนดตัวตนให้เอเจนต์

ผลลัพธ์: เอเจนต์จำเป้าหมายและความต้องการของคุณข้ามเซสชัน รันการเช็คอินเบาๆ และแสดงการปรับปรุงตนเองที่คุณสังเกตได้
ข้อควรระวัง: ระบบอัตโนมัติมากขึ้นหมายถึงการรันพื้นหลังเป็นครั้งคราวและข้อสมมติที่ผิดบ้าง

ตั้งค่า Soul Mode ในเวิร์กเกอร์นี้แบบเลือกได้ โดยใช้ OpenCode primitives เท่านั้น (คำสั่ง เอเจนต์ scheduler ไฟล์เวิร์กเกอร์)

ข้อกำหนด:
1) ถามฉันเพื่อยืนยัน (ตอบ "yes" อย่างชัดเจน) ก่อนสร้างไฟล์หรือตั้งเวลางาน
2) ทำให้เรียบง่าย ปลอดภัย และย้อนกลับได้
3) บันทึกในไฟล์ local ของเวิร์กเกอร์ภายใต้ `.opencode/`
4) การรันตามกำหนดการต้องไม่โต้ตอบ (ไม่รอ prompt ขอสิทธิ์)
5) คำ объясненияสำหรับผู้ใช้ให้เน้นที่ผลลัพธ์และการควบคุม ส่วนรายละเอียดภายใน session/sql ให้อยู่ใน agent logic เว้นแต่ฉันขอดูสำหรับการดีบัก

หลังจากฉันยืนยันแล้ว ให้ติดตั้ง Soul Mode โดยทำทั้งหมดต่อไปนี้ในเวิร์กเกอร์นี้:

## A) เริ่มต้นจากบริบทจริงก่อน (ทำก่อนเขียนหน่วยความจำ)

รวบรวมบริบทจาก:
- `pwd` (เส้นทางเวิร์กเกอร์)
- `.opencode/soul.md` ที่มีอยู่ (ถ้ามี)
- `AGENTS.md` (และ `_repos/openwork/AGENTS.md` ถ้ามี)
- OpenCode sqlite db ผ่าน `sqlite3` สำหรับไดเรกทอรีเวิร์กเกอร์นี้:
  - เซสชันล่าสุด
  - งานที่ต้องทำที่ยังเปิดอยู่
  - ข้อความ transcript ล่าสุด (จากตาราง `part` + `message`)

ใช้บริบทนี้เพื่อเริ่มหน่วยความจำด้วย bullet ที่ไม่ว่างเปล่าและลงมือทำได้ (อย่าปล่อยให้ทุกอย่างว่างเปล่า)

ถ้าการค้นหา sqlite ล้มเหลว ให้ดำเนินต่อด้วยบริบทจากไฟล์และแจ้งว่าอยู่ในโหมดที่ลดประสิทธิภาพลง

## B) หน่วยความจำถาวร

สร้างหรือรีเฟรช `.opencode/soul.md` เป็นหน่วยความจำที่มนุษย์แก้ไขได้

- ทำให้สั้น มีโครงสร้าง และชัดเจน
- รวมบรรทัด `Last updated` (ISO-8601 timestamp)
- รวมส่วนต่างๆ:
  - เป้าหมาย (Goals)
  - ความชอบ (โทน รูปแบบ ขอบเขต)
  - โฟกัสปัจจุบัน
  - งานค้าง (Loose ends)
  - งานประจำ/ระบบอัตโนมัติที่ควรพิจารณา
- ใส่ bullet อย่างน้อยหนึ่งอันใน `Current focus` และ `Loose ends` โดยใช้บริบทจากการเริ่มต้น

โครงสร้างที่แนะนำ:

```markdown
# Soul Memory

Last updated: <ISO-8601 timestamp>

## Goals
- <1-3 เป้าหมายที่ชัดเจน>

## Preferences
- <ความชอบเรื่องโทน/รูปแบบ/ขอบเขต>

## Current focus
- <ความคิดริเริ่มปัจจุบัน>

## Loose ends
- <ประเด็นที่ยังไม่เสร็จ>

## Recurring chores / automations to consider
- <งานที่ทำซ้ำได้ที่ควรทำเป็นระบบอัตโนมัติ>
```

## C) บันทึก heartbeat (การสังเกต)

สร้าง `.opencode/soul/heartbeat.jsonl` (สร้างไดเรกทอรี/ไฟล์ถ้ายังไม่มี)

- เพิ่ม JSON object หนึ่งอันต่อการรัน heartbeat (หนึ่งบรรทัดต่อการรัน)
- Key ขั้นต่ำ: `ts`, `workspace`, `summary`, `loose_ends`, `next_action`
- เพิ่ม key พิเศษเพื่อการสังเกตเมื่อมี: `session_titles`, `open_todo_count`, `signals`, `improvements`

## D) Soul agent เฉพาะ (สำหรับการรันแบบไม่มีคนคุม)

สร้าง `.opencode/agents/soul.md` (เอเจนต์หลัก)

เป้าหมาย:
1) พฤติกรรม: ปิดลูปจากงานที่ยังไม่เสร็จ ทำให้การเช็คอินกระชับ ให้ความสำคัญกับการปรับปรุงที่ย้อนกลับได้
2) สิทธิ์: อนุญาตเฉพาะที่ heartbeat/steering ต้องการ หลีกเลี่งการเข้าถึงการเขียนที่กว้างเกินไป

สำคัญ: อย่าอ่าน `opencode.db` ผ่าน `read` ให้ query ผ่าน `sqlite3`

ใช้สิทธิ์ที่จำกัดเช่น:
- `bash` อนุญาตรูปแบบ:
  - `pwd`
  - `pwd *`
  - `sqlite3 *opencode.db*`
  - `mkdir *opencode/soul*`
  - `cat *heartbeat.jsonl*`
- `read` อนุญาตรูปแบบ:
  - `.opencode/soul.md`
  - `.opencode/soul/heartbeat.jsonl`
  - `AGENTS.md`
  - `_repos/openwork/AGENTS.md`
- `edit` อนุญาตรูปแบบ:
  - `.opencode/soul.md`
- `glob` อนุญาตรูปแบบ:
  - `.opencode/skills/*/SKILL.md`
  - `.opencode/commands/*.md`

อย่าให้สิทธิ์การแก้ไขที่กว้างเกินไป

ไฟล์ agent ที่แนะนำ:

```markdown
---
description: Soul Mode heartbeat + steering (non-interactive heartbeat)
mode: primary
permission:
  bash:
    "*": deny
    "pwd": allow
    "pwd *": allow
    "sqlite3 *opencode.db*": allow
    "mkdir *opencode/soul*": allow
    "cat *heartbeat.jsonl*": allow
  read:
    "*": deny
    ".opencode/soul.md": allow
    ".opencode/soul/heartbeat.jsonl": allow
    "AGENTS.md": allow
    "_repos/openwork/AGENTS.md": allow
  edit:
    "*": deny
    ".opencode/soul.md": allow
  glob:
    "*": deny
    ".opencode/skills/*/SKILL.md": allow
    ".opencode/commands/*.md": allow
---

You are Soul Mode for this workspace.

- Keep durable memory in `.opencode/soul.md`.
- Use heartbeats to surface loose ends and concrete next actions.
- Use recent sessions/todos/transcripts + AGENTS guidance to suggest improvements.
- Stay safe and reversible; no destructive actions unless explicitly requested.
```

## E) โหลดหน่วยความจำอัตโนมัติ

อัปเดต `opencode.json` หรือ `opencode.jsonc` ใน root เวิร์กเกอร์:

- ตรวจสอบว่า `instructions` รวม `.opencode/soul.md` (โดยไม่ทำลายรายการที่มีอยู่)
- ตรวจสอบว่า scheduler plugin พร้อมใช้งาน (เพิ่ม `opencode-scheduler` เฉพาะถ้ายังไม่มี)

## F) คำสั่ง

สร้างคำสั่งเวิร์กเกอร์สี่คำสั่ง:

1) `.opencode/commands/soul-heartbeat.md`
   - วัตถุประสงค์: เช็คอินแบบไม่โต้ตอบ + เพิ่ม JSONL
   - ต้องอ่าน `.opencode/soul.md`, AGENTS guidance และ query sqlite สำหรับเวิร์กเกอร์นี้
   - ต้องดูที่:
     - เซสชันล่าสุด (`session`)
     - งานที่ต้องทำที่ยังเปิดอยู่ (`todo` + `session`)
     - ข้อความ transcript ล่าสุด (`part` + `message` + `session` ที่ part type เป็น text)
   - ผลลัพธ์:
     - สรุปหนึ่งประโยค
     - งานค้าง 1-3 รายการ
     - ขั้นตอนต่อไปหนึ่งรายการ
     - ข้อเสนอแนะการปรับปรุง 2-3 รายการ (กระบวนการ/ทักษะ/เอเจนต์)
   - เพิ่ม JSON หนึ่งบรรทัดใน `.opencode/soul/heartbeat.jsonl` โดยใช้คำสั่ง `cat >>` แบบ heredoc

2) `.opencode/commands/soul-status.md`
   - วัตถุประสงค์: รายงานสถานะแบบอ่านอย่างเดียวสำหรับการสังเกต
   - อ่าน `.opencode/soul.md` + heartbeat entries ล่าสุด + สถานะ scheduler job
   - ผลลัพธ์: โฟกัสปัจจุบัน อายุ heartbeat ล่าสุด งานค้างสำคัญ ขั้นตอนต่อไป

3) `.opencode/commands/steer-soul.md`
   - วัตถุประสงค์: ควบคุมแบบโต้ตอบ
   - สามารถอัปเดตโฟกัสปัจจุบัน ขอบเขต/ความชอบ และความถี่ heartbeat ได้
   - ถ้าผู้ใช้ให้ค่าที่ชัดเจนใน prompt ให้ใช้โดยตรง
   - ถ้าความถี่เปลี่ยน ให้อัปเดต scheduler job `soul-heartbeat`
   - สรุปเสมอว่ามีอะไรเปลี่ยนไปบ้าง

4) `.opencode/commands/take-my-soul-back.md`
   - วัตถุประสงค์: ย้อนกลับทั้งหมด
   - ลบ scheduler job `soul-heartbeat`
   - ลบไฟล์ที่สร้างสำหรับ Soul Mode:
     - `.opencode/soul.md`
     - `.opencode/soul/`
     - `.opencode/agents/soul.md`
     - `.opencode/commands/soul-heartbeat.md`
     - `.opencode/commands/soul-status.md`
     - `.opencode/commands/steer-soul.md`
     - `.opencode/commands/take-my-soul-back.md`
   - ย้อนกลับการเปลี่ยนแปลง `opencode.json*` ที่คุณทำ:
     - ลบ `.opencode/soul.md` ออกจาก `instructions`
     - ลบ `opencode-scheduler` เฉพาะถ้าเพิ่มมาเพื่อ Soul Mode เท่านั้น

## G) ตั้งเวลา heartbeat

สร้าง scheduler job ชื่อ `soul-heartbeat` หนึ่งงาน

- ความถี่เริ่มต้น: ทุก 12 ชั่วโมง (`0 */12 * * *`) ถามฉันว่าต้องการความถี่อื่นหรือไม่
- Workdir: root เวิร์กเกอร์
- รันเป็นคำสั่ง: `command=soul-heartbeat`
- รันด้วย agent เฉพาะ: `agent=soul`
- ใช้ชื่อเรื่องที่ stable เช่น `Soul heartbeat`
- ใช้ timeout ประมาณ 120s

ใช้เครื่องมือ scheduler ถ้ามี (`schedule_job`, `run_job`, `delete_job`)

ถ้าเครื่องมือ scheduler ไม่พร้อมใช้งาน:
- ยังสร้างไฟล์ + คำสั่งได้
- บอกฉันการเปลี่ยนแปลง `opencode.json*` ที่ต้องการอย่างชัดเจน
- บอกให้ฉัน reload/restart engine และรันการตั้งค่านี้อีกครั้ง

หลังจากตั้งเวลาแล้ว ให้ทดสอบครั้งหนึ่ง:
- รันงานทันที
- ตรวจสอบว่า `.opencode/soul/heartbeat.jsonl` ได้รายการใหม่
- ถ้าถูกบล็อกโดยสิทธิ์ ให้ปรับ/แก้ไขสิทธิ์ agent และรันใหม่จนกว่าจะรันได้โดยไม่มีคนคุม

## H) รูปแบบการตอบกลับสุดท้าย

เมื่อเสร็จแล้ว ให้ตอบกลับด้วย:

1) สอง bullet สั้นๆ:
   - Soul Mode ทำอะไรได้ตอนนี้
   - วิธีย้อนกลับอย่างชัดเจน
2) รายการ "วิธีโต้ตอบ" สั้นๆ รวมถึง:
   - `/soul-status`
   - `/steer-soul`
   - `run soul-heartbeat now`
3) เส้นทางความอยากรู้ 2-3 ทาง:
   - อยากรู้เกี่ยวกับงาน
   - อยากรู้เกี่ยวกับหัวข้อ
   - อยากรู้เกี่ยวกับการปรับปรุง
