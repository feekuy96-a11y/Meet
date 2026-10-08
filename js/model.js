export const uid = () => crypto.randomUUID();
export const newMeeting = () => ({
  id: uid(),
  title: '',
  date: new Date().toISOString(),
  speakers: [
    { id: uid(), name: 'ผู้พูด 1' },
    { id: uid(), name: 'ผู้พูด 2' }
  ],
  segs: [],
  cur: 0,
  dur: 0,
  part: 0,
  sumJ: null,
  summary: null,
  revision: 0
});
function text(value, max = 10000) {
  if (typeof value !== 'string' || value.length > max)
    throw new Error('ข้อความไม่ถูกต้องหรือยาวเกินกำหนด');
  return value;
}
function list(value, mapper) {
  if (!Array.isArray(value) || value.length > 200) throw new Error('รูปแบบรายการสรุปไม่ถูกต้อง');
  return value.map(mapper);
}
export function validateSummary(value) {
  if (!value || typeof value !== 'object') throw new Error('AI ไม่ส่งสรุปที่ถูกต้อง');
  return {
    overview: text(value.overview),
    exec: list(value.exec, (x) => text(x)),
    topics: list(value.topics, (x) => ({ title: text(x?.title, 500), detail: text(x?.detail) })),
    decisions: list(value.decisions, (x) => text(x)),
    actions: list(value.actions, (x) => ({
      owner: text(x?.owner, 500),
      task: text(x?.task),
      due: text(x?.due, 500)
    })),
    followups: list(value.followups, (x) => text(x)),
    speakers: list(value.speakers, (x) => ({
      name: text(x?.name, 500),
      points: list(x?.points, (p) => text(p))
    }))
  };
}
export function validateMeeting(value, freshId = false) {
  if (!value || typeof value !== 'object') throw new Error('ไฟล์ไม่ใช่ข้อมูลการประชุม');
  if (!Array.isArray(value.speakers) || value.speakers.length < 1 || value.speakers.length > 9)
    throw new Error('ผู้พูดต้องมี 1–9 คน');
  const speakers = value.speakers.map((s) => ({ id: text(s.id, 100), name: text(s.name, 200) }));
  if (new Set(speakers.map((s) => s.id)).size !== speakers.length) throw new Error('รหัสผู้พูดซ้ำ');
  if (!Array.isArray(value.segs) || value.segs.length > 20000)
    throw new Error('ข้อมูลบทสนทนาไม่ถูกต้อง');
  const segs = value.segs.map((g) => {
    if (!speakers.some((s) => s.id === g.spk) || !Number.isFinite(g.t) || g.t < 0)
      throw new Error('ผู้พูดหรือเวลาในบทสนทนาไม่ถูกต้อง');
    return {
      id: text(g.id, 100),
      spk: g.spk,
      text: text(g.text),
      t: g.t,
      tag: ['', 'สำคัญ', 'ภารกิจ', 'มติ', 'คำถาม'].includes(g.tag) ? g.tag : ''
    };
  });
  if (new Set(segs.map((g) => g.id)).size !== segs.length) throw new Error('รหัสข้อความซ้ำ');
  if (!Number.isFinite(Date.parse(value.date))) throw new Error('วันที่ไม่ถูกต้อง');
  if (!Number.isFinite(value.dur) || value.dur < 0 || value.dur > 31536000)
    throw new Error('ระยะเวลาไม่ถูกต้อง');
  const part = freshId ? 0 : (value.part ?? 0);
  if (!Number.isSafeInteger(part) || part < 0 || part > 10000)
    throw new Error('จำนวนช่วงเสียงไม่ถูกต้อง');
  const docRequest =
    !freshId &&
    value.docRequest &&
    /^[a-f0-9]{64}$/.test(value.docRequest.fingerprint) &&
    /^[A-Za-z0-9_-]{16,100}$/.test(value.docRequest.id)
      ? { fingerprint: value.docRequest.fingerprint, id: value.docRequest.id }
      : null;
  return {
    updatedAt:
      !freshId &&
      typeof value.updatedAt === 'string' &&
      Number.isFinite(Date.parse(value.updatedAt))
        ? value.updatedAt
        : new Date().toISOString(),
    docRequest,
    id: freshId ? uid() : text(value.id, 100),
    title: text(value.title || '', 200),
    date: value.date,
    speakers,
    segs,
    cur: Math.min(speakers.length - 1, Math.max(0, Number.isInteger(value.cur) ? value.cur : 0)),
    dur: value.dur,
    part,
    sumJ: value.sumJ ? validateSummary(value.sumJ) : null,
    summary: value.summary
      ? { md: text(value.summary.md, 100000), by: text(value.summary.by, 200) }
      : null,
    revision: 0,
    recording: !freshId && value.recording === true
  };
}
export function summaryMarkdown(j) {
  const lines = (a) => a.map((x) => `- ${x}`).join('\n') || '- ไม่มี';
  return `## สรุปสำหรับผู้บริหาร\n${lines(j.exec)}\n\n## ภาพรวม\n${j.overview}\n\n## ประเด็นสำคัญ\n${j.topics.map((t) => `- **${t.title}**: ${t.detail}`).join('\n') || '- ไม่มี'}\n\n## มติและข้อตกลง\n${lines(j.decisions)}\n\n## สิ่งที่ต้องดำเนินการ\n${j.actions.map((a) => `- **${a.owner}**: ${a.task} (กำหนด: ${a.due})`).join('\n') || '- ไม่มี'}\n\n## ประเด็นที่ต้องติดตาม\n${lines(j.followups)}\n\n## สรุปรายบุคคล\n${j.speakers.map((s) => `### ${s.name}\n${lines(s.points)}`).join('\n\n') || '- ไม่มี'}`;
}
