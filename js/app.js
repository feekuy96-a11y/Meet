import { DB } from './db.js';
import { API, validateEndpoint, MAX_AUDIO_BYTES } from './api.js';
import { UI } from './ui.js';
import { AudioEngine } from './audio.js';
import { CloudSync, cloudReady } from './cloud.js';
import { uid, newMeeting, validateMeeting, validateSummary, summaryMarkdown } from './model.js';

const $ = (s) => UI.$(s),
  esc = (s) => UI.escapeHtml(s);
const COLORS = [
  '#6366f1',
  '#ef4444',
  '#10b981',
  '#f59e0b',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
  '#84cc16',
  '#64748b'
];
const TAGS = ['', 'สำคัญ', 'ภารกิจ', 'มติ', 'คำถาม'];
let cfg = { gasUrl: '', useAudio: false, theme: '', cloudSync: false, autoDocs: true };
try {
  const stored = JSON.parse(localStorage.getItem('mn_cfg') || '{}');
  cfg = {
    gasUrl: typeof stored.gasUrl === 'string' ? stored.gasUrl : '',
    useAudio: stored.useAudio === true,
    cloudSync: stored.cloudSync === true,
    autoDocs: stored.autoDocs !== false,
    theme: ['dark', 'light'].includes(stored.theme) ? stored.theme : ''
  };
  // Remove legacy persistent passwords; require re-entry for this tab only.
  localStorage.setItem('mn_cfg', JSON.stringify(cfg));
} catch {
  UI.toast('อ่านการตั้งค่าเดิมไม่ได้ ใช้ค่าเริ่มต้น', 'warn');
}
let gasToken = '';
if (cfg.theme) document.documentElement.dataset.theme = cfg.theme;
let meeting = newMeeting(),
  state = 'loading',
  busy = false,
  base = 0,
  startedAt = 0,
  timer = null,
  lastSave = 0;
let recognition = null,
  recognitionTimer = null,
  speechSpeaker = null,
  speechTime = 0;
let speechFailures = 0,
  speechUnavailable = false;
let recovery = null,
  audioUrls = [],
  audioRenderVersion = 0;
let unsaved = false,
  saveSequence = 0,
  savedSequence = 0,
  editSaveTimer = null;
let cloudTimer = null,
  lastCloudConflicts = [];
const cloud = new CloudSync(
  () => ({ ...cfg, gasToken }),
  (text) => {
    $('#cloudStatus').textContent = text;
  }
);
const engine = new AudioEngine();
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const now = () => base + (state === 'rec' ? (performance.now() - startedAt) / 1000 : 0);
const speakerIndex = (id) => meeting.speakers.findIndex((s) => s.id === id);
const speakerName = (id) => meeting.speakers.find((s) => s.id === id)?.name || 'ไม่ระบุ';
const fail = (error) => {
  console.error(error?.name || 'Error');
  UI.toast(error.message || 'เกิดข้อผิดพลาด', 'err', 10000);
};
const run =
  (fn) =>
  async (...args) => {
    try {
      await fn(...args);
    } catch (error) {
      fail(error);
    }
  };
function available() {
  if (state !== 'idle' || busy || recovery) {
    UI.toast('โปรดจบการบันทึก/งานปัจจุบัน และกู้เสียงที่ยังไม่บันทึกก่อน', 'warn');
    return false;
  }
  return true;
}
async function save() {
  if (['loading', 'error'].includes(state)) throw new Error('ฐานข้อมูลยังไม่พร้อม');
  if (!meeting.title && !meeting.segs.length && !meeting.part && !meeting.summary && !meeting.dur)
    return;
  if (state !== 'idle' || unsaved || meeting.cloudDirty !== false) meeting.cloudDirty = true;
  meeting.updatedAt = new Date().toISOString();
  meeting.dur = now();
  meeting.recording = ['rec', 'pause', 'starting'].includes(state);
  const sequence = ++saveSequence;
  unsaved = true;
  await DB.saveMeeting(meeting);
  savedSequence = Math.max(savedSequence, sequence);
  unsaved = savedSequence < saveSequence;
  lastSave = performance.now();
  scheduleCloud();
}
function changed() {
  meeting.cloudDirty = true;
  unsaved = true;
  meeting.revision++;
  meeting.sumJ = null;
  meeting.summary = null;
}
function updateControls() {
  const editDisabled = !['idle', 'rec', 'pause'].includes(state) || busy;
  $('#list').inert = editDisabled;
  for (const id of ['title', 'man', 'bMan', 'addSpk', 'bImport'])
    $('#' + id).disabled = editDisabled;
  $('#spks')
    .querySelectorAll('input')
    .forEach((e) => (e.disabled = editDisabled));
  $('#bStart').disabled = state !== 'idle' || busy || !!recovery;
  $('#bPause').disabled = !['rec', 'pause'].includes(state);
  $('#bStop').disabled = !['rec', 'pause'].includes(state);
  $('#bAI').disabled = state !== 'idle' || busy || !!recovery;
  $('#bDocs').disabled = state !== 'idle' || busy || !!recovery;
  $('#bNew').disabled = state !== 'idle' || busy || !!recovery;
  $('#bSync').disabled = state !== 'idle' || busy || !!recovery;
  $('#bConflicts').disabled = state !== 'idle' || busy || !!recovery;
  $('#bPause').textContent = state === 'pause' ? '▶ ทำต่อ' : '⏸ พัก';
  $('#chip').className = 'chip ' + (state === 'rec' ? 'rec' : state === 'pause' ? 'pa' : '');
  $('#chip').textContent = {
    loading: 'กำลังเปิดข้อมูล',
    starting: 'กำลังเปิดไมค์',
    rec: '● กำลังบันทึก',
    pause: 'พักอยู่',
    stopping: 'กำลังบันทึกลงเครื่อง',
    idle: recovery ? 'ต้องกู้ไฟล์เสียง' : 'พร้อม',
    error: 'ฐานข้อมูลใช้ไม่ได้'
  }[state];
  $('#bStart').textContent =
    meeting.part || meeting.dur ? '▶ ต่อการประชุม' : '● เริ่มบันทึกการประชุม';
}
function renderSpeakers() {
  $('#spks').innerHTML = meeting.speakers
    .map(
      (s, i) =>
        `<div class="spk ${i === meeting.cur ? 'cur' : ''}" style="--c:${COLORS[i]}" data-i="${i}"><div class="av">${i + 1}</div><div class="si"><input aria-label="ชื่อผู้พูด ${i + 1}" maxlength="200" value="${esc(s.name)}" data-name="${i}"><small>เลือกผู้พูดด้วยตนเอง</small></div><button class="x" data-delete="${i}" aria-label="ลบผู้พูด ${i + 1}">✕</button></div>`
    )
    .join('');
  const currentFilter = $('#fs').value;
  $('#fs').innerHTML =
    '<option value="">ทุกคน</option>' +
    meeting.speakers.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  $('#fs').value = currentFilter;
}
function renderList() {
  // Do not destroy the active contenteditable while recognition adds a segment.
  if ($('#list').contains(document.activeElement) && document.activeElement.matches('[data-edit]'))
    return;
  const q = $('#q').value.trim(),
    filter = $('#fs').value,
    box = $('#list');
  const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 60;
  box.innerHTML =
    meeting.segs
      .filter((g) => (!q || g.text.includes(q)) && (!filter || g.spk === filter))
      .map(
        (g) =>
          `<div class="seg" style="--c:${COLORS[Math.max(0, speakerIndex(g.spk))]}" data-id="${esc(g.id)}"><div class="av">${speakerIndex(g.spk) + 1}</div><div class="sp"><div class="m"><select data-speaker aria-label="ผู้พูดของข้อความ">${meeting.speakers.map((s) => `<option value="${esc(s.id)}" ${s.id === g.spk ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select><span>${UI.formatTime(g.t)}</span>${g.tag ? `<span class="tag">${esc(g.tag)}</span>` : ''}<button class="x" data-tag aria-label="เปลี่ยนแท็ก">🏷</button><button class="x" data-delete aria-label="ลบข้อความ">🗑</button></div><div class="t" contenteditable="plaintext-only" role="textbox" aria-label="แก้ไขบทสนทนา" data-edit>${esc(g.text)}</div></div></div>`
      )
      .join('') || '<p class="hint">ยังไม่มีข้อความ เริ่มบันทึกหรือพิมพ์บันทึกย่อได้</p>';
  if (stick) box.scrollTop = box.scrollHeight;
}
function markdown(value) {
  let html = '',
    inList = false;
  for (const raw of String(value).split('\n')) {
    const line = esc(raw).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    const bullet = /^\s*[-*•]\s+(.*)/.exec(line),
      heading = /^#{1,4}\s+(.*)/.exec(line);
    if (bullet) {
      if (!inList) html += '<ul>';
      inList = true;
      html += `<li>${bullet[1]}</li>`;
      continue;
    }
    if (inList) {
      html += '</ul>';
      inList = false;
    }
    if (heading) html += `<h4>${heading[1]}</h4>`;
    else if (line.trim()) html += `<p>${line}</p>`;
  }
  return html + (inList ? '</ul>' : '');
}
function renderSummary() {
  $('#sumBox').innerHTML = meeting.summary
    ? markdown(meeting.summary.md)
    : '<p class="hint">ยังไม่มีสรุป สรุป AI ต้องตรวจความถูกต้องก่อนใช้งาน</p>';
  $('#sumBy').textContent = meeting.summary?.by || '';
  $('#sumBy').classList.toggle('hide', !meeting.summary);
}
function render() {
  const docURL = meeting.cloud?.docUrl;
  $('#cloudDoc').classList.toggle('hide', !docURL);
  if (docURL) $('#cloudDoc').href = docURL;
  else $('#cloudDoc').removeAttribute('href');
  $('#title').value = meeting.title;
  renderSpeakers();
  renderList();
  renderSummary();
  $('#timer').textContent = UI.formatTime(now());
  updateControls();
}
function stopRecognition() {
  clearTimeout(recognitionTimer);
  recognitionTimer = null;
  const old = recognition;
  recognition = null;
  if (old) {
    old.onend = null;
    old.onresult = null;
    try {
      old.abort();
    } catch {}
  }
  $('#interim').textContent = '';
  $('#interim').style.display = 'none';
}
function startRecognition() {
  if (
    !SpeechRecognition ||
    !$('#stt').checked ||
    state !== 'rec' ||
    recognition ||
    speechUnavailable
  )
    return;
  const currentMeeting = meeting.id,
    r = new SpeechRecognition();
  recognition = r;
  r.lang = 'th-TH';
  r.continuous = true;
  r.interimResults = true;
  speechSpeaker = null;
  r.onspeechstart = () => {
    speechSpeaker = meeting.speakers[meeting.cur].id;
    speechTime = now();
  };
  r.onstart = () => {
    $('#rstat').textContent = 'กำลังฟังภาษาไทย (อาจส่งเสียงให้บริการของเบราว์เซอร์)';
  };
  r.onresult = (event) => {
    if (state !== 'rec' || meeting.id !== currentMeeting || recognition !== r) return;
    speechFailures = 0;
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i],
        text = result[0].transcript.trim();
      if (result.isFinal && text) {
        const spk = meeting.speakers.some((s) => s.id === speechSpeaker)
          ? speechSpeaker
          : meeting.speakers[meeting.cur].id;
        meeting.segs.push({
          id: uid(),
          spk,
          text: text.slice(0, 10000),
          t: speechSpeaker ? speechTime : now(),
          tag: ''
        });
        changed();
        renderList();
        run(save)();
        speechSpeaker = null;
      } else if (!result.isFinal) interim += text;
    }
    $('#interim').textContent = interim;
    $('#interim').style.display = interim ? 'block' : 'none';
  };
  r.onerror = (event) => {
    if (
      ['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'].includes(
        event.error
      ) ||
      ++speechFailures >= 3
    ) {
      speechUnavailable = true;
      $('#stt').checked = false;
      UI.toast(
        'ถอดเสียงหยุด: ' + event.error + ' แต่ไฟล์เสียงยังบันทึกอยู่ สามารถเปิดถอดเสียงใหม่ได้',
        'warn',
        10000
      );
    }
  };
  r.onend = () => {
    if (recognition !== r) return;
    recognition = null;
    $('#interim').style.display = 'none';
    if (state === 'rec' && $('#stt').checked && !speechUnavailable)
      recognitionTimer = setTimeout(startRecognition, Math.min(5000, 500 * 2 ** speechFailures));
  };
  try {
    r.start();
  } catch {
    recognition = null;
    speechUnavailable = true;
    $('#stt').checked = false;
    UI.toast('เปิดบริการถอดเสียงไม่ได้ บันทึกเสียงยังทำงาน', 'warn');
  }
}
async function start() {
  if (!available()) return;
  state = 'starting';
  updateControls();
  const id = meeting.id,
    part = meeting.part + 1;
  try {
    // Persist the part number BEFORE capturing chunks, enabling crash recovery.
    meeting.part = part;
    await save();
    await engine.start(
      (chunk) =>
        DB.saveAudio(`${id}:chunk:${part}:${String(chunk.seq).padStart(10, '0')}`, chunk.blob),
      (error) => {
        fail(new Error('บันทึกเสียงมีปัญหา: ' + error.message));
        setTimeout(() => run(() => stop(false))(), 0);
      },
      () => {
        UI.toast('ไมโครโฟนถูกตัดการเชื่อมต่อ', 'warn');
        run(() => stop(false))();
      }
    );
    base = meeting.dur;
    startedAt = performance.now();
    state = 'rec';
    speechFailures = 0;
    speechUnavailable = false;
    startRecognition();
    lastSave = performance.now();
    timer = setInterval(() => {
      $('#timer').textContent = UI.formatTime(now());
      if (engine.an && state === 'rec') {
        const data = new Float32Array(engine.an.fftSize);
        engine.an.getFloatTimeDomainData(data);
        const rms = Math.sqrt(data.reduce((sum, x) => sum + x * x, 0) / data.length);
        $('#lv').style.width = Math.min(100, Math.sqrt(rms) * 230) + '%';
      }
      if (performance.now() - lastSave > 5000) {
        lastSave = performance.now();
        save().catch((error) => {
          fail(error);
          run(() => stop(false))();
        });
      }
    }, 250);
    await save();
    render();
    UI.toast('เริ่มบันทึกแล้ว โปรดเปิดหน้าจอไว้และอย่าปิดแท็บ', 'ok');
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  } catch (error) {
    clearInterval(timer);
    stopRecognition();
    // A post-start metadata failure still needs to flush final audio chunks.
    const failed = await engine.stop();
    if (failed.length) recovery = { id: meeting.id, part: meeting.part, chunks: failed };
    state = 'idle';
    meeting.recording = false;
    try {
      if (!failed.length && !(await DB.audioEntries(`${id}:chunk:${part}:`)).length)
        meeting.part = part - 1;
    } catch {}
    try {
      await save();
    } catch {}
    render();
    await renderAudio();
    throw error;
  }
}
async function pause() {
  if (state === 'rec') {
    engine.pause();
    base = now();
    state = 'pause';
    $('#lv').style.width = '0';
    stopRecognition();
    $('#rstat').textContent = 'พักการบันทึก';
  } else if (state === 'pause') {
    engine.resume();
    startedAt = performance.now();
    state = 'rec';
    startRecognition();
  }
  render();
  await save();
}
async function stop(confirm = true) {
  if (!['rec', 'pause'].includes(state)) return;
  if (
    confirm &&
    !(await UI.ask(
      'จบการประชุม?',
      'บันทึกเสียงและข้อความลงเครื่องก่อนทำรายงาน',
      'จบการประชุม',
      'rd'
    ))
  )
    return;
  if (!['rec', 'pause'].includes(state)) return;
  base = now();
  state = 'stopping';
  updateControls();
  stopRecognition();
  clearInterval(timer);
  try {
    const failed = await engine.stop();
    if (failed.length) recovery = { id: meeting.id, part: meeting.part, chunks: failed };
  } finally {
    state = 'idle';
    meeting.recording = false;
    $('#lv').style.width = '0';
    $('#rstat').textContent = '';
    render();
  }
  let metadataSaved = false;
  try {
    await save();
    metadataSaved = true;
  } catch (error) {
    fail(new Error('บันทึกข้อมูลประชุมไม่ได้ โปรดสำรอง JSON ก่อนปิดแท็บ: ' + error.message));
  }
  await renderAudio();
  if (recovery) {
    await UI.modal(
      'ต้องกู้ไฟล์เสียงก่อนปิดแท็บ',
      '<p>ฐานข้อมูลบันทึกเสียงบางช่วงไม่ได้ กดดาวน์โหลดเสียงกู้คืน หรือเพิ่มพื้นที่ว่างแล้วลองบันทึกอีกครั้ง อย่าปิดแท็บก่อนกู้ข้อมูล</p>',
      [
        { t: 'ปิดหน้าต่าง', v: 0 },
        { t: 'ดาวน์โหลดเสียงกู้คืน', fn: downloadRecovery },
        { t: 'ลองบันทึกอีกครั้ง', fn: retryRecovery }
      ]
    );
  } else if (metadataSaved) UI.toast('บันทึกลงเครื่องแล้ว โปรดสำรองข้อความและไฟล์เสียง', 'ok');
}
async function retryRecovery() {
  if (!recovery) return;
  for (const chunk of recovery.chunks)
    await DB.saveAudio(
      `${recovery.id}:chunk:${recovery.part}:${String(chunk.seq).padStart(10, '0')}`,
      chunk.blob
    );
  recovery = null;
  updateControls();
  UI.toast('บันทึกเสียงที่กู้คืนสำเร็จ', 'ok');
}
async function downloadRecovery() {
  if (!recovery) return;
  const blob = await DB.getPart(recovery.id, recovery.part, recovery.chunks);
  download(blob, filename() + '-recovered.' + audioExtension(blob.type));
  // Download initiation is not proof the user retained the file.
  if (
    await UI.ask(
      'ตรวจสอบไฟล์ที่ดาวน์โหลด',
      'เปิดฟังไฟล์ที่ดาวน์โหลดแล้วครบหรือไม่? ยืนยันเฉพาะเมื่อเก็บไฟล์สำรองสำเร็จ',
      'เก็บสำรองแล้ว'
    )
  ) {
    recovery = null;
    updateControls();
  }
}
function audioExtension(type) {
  return type.includes('mp4')
    ? 'm4a'
    : type.includes('ogg')
      ? 'ogg'
      : type.includes('wav')
        ? 'wav'
        : type.includes('mpeg')
          ? 'mp3'
          : 'webm';
}
function filename() {
  return (meeting.title || 'meeting').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100);
}
function download(blob, name) {
  const url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function clearAudio() {
  audioRenderVersion++;
  audioUrls.forEach((url) => URL.revokeObjectURL(url));
  audioUrls = [];
  $('#fullA').replaceChildren();
}
async function renderAudio() {
  clearAudio();
  const version = audioRenderVersion,
    id = meeting.id;
  const entries = await DB.audioEntries(id + ':');
  if (version !== audioRenderVersion) return;
  const parts = [
    ...new Set([
      ...entries.map((e) => {
        const match = /:(?:full(\d+)|chunk:(\d+):)/.exec(e.key);
        return Number(match?.[1] || match?.[2] || 0);
      }),
      ...(meeting.cloud?.audio || []).map((p) => p.part)
    ])
  ]
    .filter(Boolean)
    .sort((a, b) => a - b);
  $('#full').classList.toggle('hide', !parts.length && !recovery);
  for (const part of parts) {
    const row = document.createElement('div'),
      play = document.createElement('button'),
      dl = document.createElement('button');
    play.className = dl.className = 'btn';
    play.textContent = `ฟังเสียงช่วง ${part}`;
    dl.textContent = `ดาวน์โหลดช่วง ${part}`;
    play.onclick = run(async () => {
      play.disabled = true;
      try {
        const blob = await audioPartFor(id, part);
        if (version !== audioRenderVersion || !blob) return;
        const player = document.createElement('audio');
        player.controls = true;
        const url = URL.createObjectURL(blob);
        audioUrls.push(url);
        player.src = url;
        row.append(player);
        play.remove();
      } finally {
        play.disabled = false;
      }
    });
    dl.onclick = run(async () => {
      const blob = await audioPartFor(id, part);
      if (blob) download(blob, filename() + `-part-${part}.` + audioExtension(blob.type));
    });
    row.append(play, dl);
    $('#fullA').append(row);
  }
  if (recovery) {
    const b = document.createElement('button');
    b.className = 'btn rd';
    b.textContent = 'ดาวน์โหลดเสียงกู้คืน';
    b.onclick = run(downloadRecovery);
    $('#fullA').append(b);
  }
}
async function collectAudio(target) {
  // Check total stored bytes BEFORE constructing entire recordings in memory.
  const entries = await DB.audioEntries(target.id + ':');
  if (
    Math.max(
      entries.reduce((size, e) => size + e.blob.size, 0),
      (target.cloud?.audio || []).reduce((n, p) => n + p.size, 0)
    ) > MAX_AUDIO_BYTES
  )
    throw new Error('เสียงเกิน 8 MB โปรดปิดส่งเสียงในตั้งค่า ใช้ข้อความแทน และดาวน์โหลดเสียงแยก');
  const result = [];
  for (let part = 1; part <= target.part; part++) {
    const blob = await cloud.audioPart(target, part);
    if (blob?.size)
      result.push({ mime: blob.type.split(';')[0], data: await API.blobToBase64(blob) });
  }
  if (result.length > 20) throw new Error('เสียงมีมากกว่า 20 ช่วง โปรดใช้ข้อความแทน');
  return result;
}
async function summarize() {
  if (!available()) return;
  const target = structuredClone(meeting),
    revision = meeting.revision;
  busy = true;
  updateControls();
  $('#sumBox').textContent = 'กำลังสร้างสรุป…';
  try {
    const audio = cfg.useAudio ? await collectAudio(target) : [];
    if (!target.segs.length && !audio.length) throw new Error('ยังไม่มีข้อความหรือเสียงให้สรุป');
    if (
      !(await UI.ask(
        'ส่งข้อมูลให้ Gemini?',
        `จะส่งข้อความ${audio.length ? 'และเสียง' : ''}ไป Google เพื่อสร้างสรุป ตรวจความยินยอมของผู้เข้าร่วมก่อนส่ง`,
        'ส่งข้อมูล'
      ))
    ) {
      renderSummary();
      return;
    }
    const result = await API.callGAS(
      { ...cfg, gasToken },
      {
        action: 'summarize',
        title: target.title || 'ไม่มีชื่อ',
        date: target.date,
        transcript: target.segs
          .map(
            (g) =>
              `[${UI.formatTime(g.t)}] ${target.speakers.find((s) => s.id === g.spk)?.name || 'ไม่ระบุ'}: ${g.text}`
          )
          .join('\n'),
        audio
      }
    );
    const summary = validateSummary(result.data);
    if (meeting.id !== target.id || meeting.revision !== revision)
      throw new Error('ข้อความเปลี่ยนระหว่างสรุป โปรดสรุปใหม่');
    meeting.cloudDirty = true;
    meeting.sumJ = summary;
    meeting.summary = {
      md: summaryMarkdown(summary),
      by: result.usedAudio ? 'Gemini (เสียงและข้อความ)' : 'Gemini (ข้อความ)'
    };
    await save();
    renderSummary();
    UI.toast('สร้างสรุปแล้ว โปรดตรวจมติ ผู้รับผิดชอบ และกำหนดเวลา', 'ok');
  } catch (error) {
    renderSummary();
    throw error;
  } finally {
    busy = false;
    updateControls();
  }
}
async function exportDocs() {
  if (!available()) return;
  const target = structuredClone(meeting),
    mode = $('#docMode').value;
  if (mode !== 'full' && !target.sumJ) throw new Error('โปรดสร้างสรุปก่อนส่งออกฉบับสรุป');
  if (!target.segs.length && !target.sumJ && !target.part) throw new Error('ยังไม่มีข้อมูล');
  busy = true;
  updateControls();
  try {
    const audio = mode !== 'summary' && cfg.useAudio ? await collectAudio(target) : [];
    if (
      !(await UI.ask(
        'สร้างเอกสารใน Google Drive?',
        `ส่ง${audio.length ? 'ข้อความและเสียง' : 'ข้อความ'}เข้า Drive ของเจ้าของ Apps Script สิทธิ์แชร์จะขึ้นกับโฟลเดอร์ที่ผู้ดูแลตั้งไว้`,
        'สร้างเอกสาร'
      ))
    )
      return;
    const payload = {
      action: 'createDoc',
      mode,
      title: target.title || 'รายงานการประชุม',
      date: target.date,
      duration: UI.formatTime(target.dur),
      summary: target.sumJ,
      audio,
      segments: target.segs.map((g) => ({
        t: UI.formatTime(g.t),
        speaker: target.speakers.find((s) => s.id === g.spk)?.name || 'ไม่ระบุ',
        text: g.text
      }))
    };
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(payload))
    );
    const fingerprint = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    if (meeting.docRequest?.fingerprint !== fingerprint)
      meeting.docRequest = { fingerprint, id: uid() };
    await save(); // Persist the request identity before a potentially ambiguous timeout.
    const result = await API.callGAS(
      { ...cfg, gasToken },
      { ...payload, requestId: meeting.docRequest.id }
    );
    const urls = result.urls || [result.url];
    if (
      !Array.isArray(urls) ||
      !urls.length ||
      urls.length > 2 ||
      urls.some(
        (url) => !/^https:\/\/docs\.google\.com\/document\/d\/[A-Za-z0-9_-]+\/edit$/.test(url)
      )
    )
      throw new Error('URL เอกสารจากเซิร์ฟเวอร์ไม่ถูกต้อง');
    await UI.modal(
      'สร้างเอกสารแล้ว',
      urls
        .map(
          (url, i) =>
            `<p><a target="_blank" rel="noopener noreferrer" href="${esc(url)}">เปิดเอกสาร ${i + 1}</a></p>`
        )
        .join(''),
      [{ t: 'ปิด', v: 0 }]
    );
  } finally {
    busy = false;
    updateControls();
  }
}
function fullText() {
  return meeting.segs
    .map((g) => `[${UI.formatTime(g.t)}] ${speakerName(g.spk)}: ${g.text}`)
    .join('\n');
}
function exportLocal() {
  if (state !== 'idle') throw new Error('โปรดจบการบันทึกก่อนส่งออก');
  const fmt = $('#fmt').value,
    text = `# ${meeting.title || 'รายงานการประชุม'}\n${new Date(meeting.date).toLocaleString('th-TH')}\n\n${meeting.summary?.md || ''}\n\n## บทสนทนา\n${fullText()}`;
  if (fmt === 'pdf') {
    $('#printReport').innerHTML = markdown(text);
    window.print();
    return;
  }
  if (fmt === 'json') {
    download(
      new Blob([JSON.stringify({ format: 'meetnote-text-v2', meeting }, null, 2)], {
        type: 'application/json'
      }),
      filename() + '.json'
    );
    UI.toast('JSON สำรองเฉพาะข้อความ โปรดดาวน์โหลดเสียงแต่ละช่วงแยกด้วย', 'warn', 10000);
    return;
  }
  if (fmt === 'docx') {
    download(
      new Blob(
        [
          `<!doctype html><html lang="th"><meta charset="utf-8"><title>${esc(meeting.title)}</title><body>${markdown(text)}</body></html>`
        ],
        { type: 'application/msword' }
      ),
      filename() + '.doc'
    );
    return;
  }
  download(new Blob([text], { type: 'text/markdown;charset=utf-8' }), filename() + '.md');
}
async function history() {
  const all = await DB.getAllMeetings(),
    query = $('#hq').value.trim();
  $('#hl').innerHTML =
    all
      .filter((m) => !query || String(m.title || '').includes(query))
      .map(
        (m) =>
          `<div class="hist" data-id="${esc(m.id)}"><div class="sp"><b>${esc(m.title || '(ไม่มีชื่อ)')}</b><br><small>${esc(new Date(m.date).toLocaleString('th-TH'))} · ${UI.formatTime(m.dur)}${m.recording ? ' · ถูกขัดจังหวะ' : ''}</small></div><button class="btn go" data-open>เปิด</button><button class="btn" data-backup>สำรอง JSON</button><button class="btn" data-summary>สรุป</button><button class="x" data-delete aria-label="ลบประชุม">🗑</button></div>`
      )
      .join('') || '<p class="hint">ไม่มีประวัติ</p>';
}
async function tab(name) {
  document
    .querySelectorAll('.tabs button')
    .forEach((b) => b.classList.toggle('a', b.dataset.t === name));
  for (const id of ['rec', 'sum', 'his']) $('#' + id).classList.toggle('hide', id !== name);
  if (name === 'his') await history();
  if (name === 'sum') renderSummary();
}
async function newSession() {
  if (!available()) return;
  await save();
  meeting = newMeeting();
  base = 0;
  clearAudio();
  $('#full').classList.add('hide');
  render();
  await tab('rec');
}
async function manual() {
  const text = $('#man').value.trim();
  if (!text) return;
  if (!['idle', 'rec', 'pause'].includes(state)) throw new Error('ยังไม่พร้อมบันทึก');
  meeting.segs.push({
    id: uid(),
    spk: meeting.speakers[meeting.cur].id,
    text: text.slice(0, 10000),
    t: now(),
    tag: ''
  });
  changed();
  await save();
  $('#man').value = '';
  renderList();
}
$('#bStart').onclick = run(start);
$('#bPause').onclick = run(pause);
$('#bStop').onclick = run(() => stop(true));
$('#bAI').onclick = run(summarize);
$('#bDocs').onclick = run(exportDocs);
$('#bDl').onclick = run(exportLocal);
$('#bNew').onclick = run(newSession);
$('#bMan').onclick = run(manual);
$('#man').onkeydown = run((event) => {
  if (event.key === 'Enter') return manual();
});
$('#bSumCopy').onclick = run(async () => {
  if (!meeting.summary) throw new Error('ยังไม่มีสรุป');
  await navigator.clipboard.writeText(meeting.summary.md);
  UI.toast('คัดลอกแล้ว', 'ok');
});
$('#title').oninput = run(async (e) => {
  meeting.title = e.target.value.slice(0, 200);
  meeting.cloudDirty = true;
  await save();
});
$('#q').oninput = renderList;
$('#fs').onchange = renderList;
$('#hq').oninput = run(history);
$('#stt').onchange = () => {
  speechUnavailable = false;
  speechFailures = 0;
  if ($('#stt').checked) startRecognition();
  else stopRecognition();
};
$('#spks').onclick = run(async (event) => {
  const item = event.target.closest('[data-i]');
  if (!item) return;
  const index = Number(item.dataset.i);
  if (event.target.matches('[data-delete]')) {
    if (state !== 'idle' || busy) throw new Error('จบการบันทึกก่อนลบผู้พูด');
    if (meeting.speakers.length === 1) throw new Error('ต้องมีผู้พูดอย่างน้อยหนึ่งคน');
    const speaker = meeting.speakers[index];
    if (
      !(await UI.ask(
        'ลบผู้พูด?',
        `ข้อความของ ${speaker.name} จะโอนไปผู้พูดที่เหลือคนแรก`,
        'ลบ',
        'rd'
      ))
    )
      return;
    meeting.speakers.splice(index, 1);
    const replacement = meeting.speakers[0].id;
    meeting.segs.forEach((g) => {
      if (g.spk === speaker.id) g.spk = replacement;
    });
    meeting.cur = 0;
    changed();
    render();
    await save();
  } else if (!event.target.matches('input')) {
    meeting.cur = index;
    renderSpeakers();
    meeting.cloudDirty = true;
    await save();
  }
});
$('#spks').onchange = run(async (event) => {
  if (event.target.dataset.name !== undefined) {
    meeting.speakers[Number(event.target.dataset.name)].name =
      event.target.value.trim().slice(0, 200) || 'ไม่ระบุ';
    changed();
    render();
    await save();
  }
});
$('#addSpk').onclick = run(async () => {
  if (meeting.speakers.length >= 9) throw new Error('เพิ่มได้สูงสุด 9 คน');
  meeting.speakers.push({ id: uid(), name: 'ผู้พูด ' + (meeting.speakers.length + 1) });
  changed();
  renderSpeakers();
  await save();
});
$('#list').onchange = run(async (event) => {
  const row = event.target.closest('[data-id]');
  const seg = meeting.segs.find((g) => g.id === row?.dataset.id);
  if (seg && event.target.matches('[data-speaker]')) {
    seg.spk = event.target.value;
    changed();
    await save();
    renderList();
  }
});
$('#list').addEventListener('input', (event) => {
  if (!event.target.matches('[data-edit]')) return;
  const seg = meeting.segs.find((g) => g.id === event.target.closest('[data-id]').dataset.id);
  const text = event.target.textContent.slice(0, 10000);
  if (seg && seg.text !== text) {
    seg.text = text;
    changed();
    unsaved = true;
    clearTimeout(editSaveTimer);
    editSaveTimer = setTimeout(() => run(save)(), 750);
  }
});
$('#list').addEventListener(
  'focusout',
  run(async (event) => {
    if (!event.target.matches('[data-edit]')) return;
    clearTimeout(editSaveTimer);
    const seg = meeting.segs.find((g) => g.id === event.target.closest('[data-id]').dataset.id);
    if (seg) {
      const text = event.target.textContent.slice(0, 10000);
      if (seg.text !== text) {
        seg.text = text;
        changed();
        unsaved = true;
      }
      if (unsaved) await save();
      renderList();
    }
  })
);
$('#list').onclick = run(async (event) => {
  const row = event.target.closest('[data-id]'),
    seg = meeting.segs.find((g) => g.id === row?.dataset.id);
  if (!seg) return;
  if (event.target.matches('[data-tag]')) seg.tag = TAGS[(TAGS.indexOf(seg.tag) + 1) % TAGS.length];
  else if (event.target.matches('[data-delete]')) {
    if (!(await UI.ask('ลบข้อความ?', 'ลบข้อความนี้ถาวร?', 'ลบ', 'rd'))) return;
    meeting.segs = meeting.segs.filter((g) => g.id !== seg.id);
  } else return;
  changed();
  await save();
  renderList();
});
$('#hl').onclick = run(async (event) => {
  const row = event.target.closest('[data-id]');
  if (!row || !available()) return;
  if (event.target.matches('[data-backup]')) {
    const value = await DB.getMeeting(row.dataset.id);
    if (!value) throw new Error('ไม่พบการประชุม');
    download(
      new Blob([JSON.stringify({ format: 'meetnote-text-v2', meeting: value }, null, 2)], {
        type: 'application/json'
      }),
      'meeting-backup.json'
    );
    UI.toast('สำรองข้อความแล้ว ต้องดาวน์โหลดเสียงแยก', 'warn');
  } else if (event.target.matches('[data-delete]')) {
    const target = await DB.getMeeting(row.dataset.id);
    const mode = await UI.modal(
      'ลบการประชุม?',
      '<p>ลบเฉพาะเครื่องจะเก็บข้อมูลบน Drive ไว้ และซิงก์ครั้งหน้าจะโหลดกลับมา ลบทุกเครื่องจะซ่อนรายการจากคลาวด์ด้วย ไฟล์ Google Docs และไฟล์ข้อมูลบน Drive ไม่ถูกลบถาวร</p>',
      [
        { t: 'ยกเลิก', v: null },
        { t: 'ลบเฉพาะเครื่อง', v: 'local' },
        { t: 'ลบจากทุกเครื่อง', v: 'cloud', c: 'rd' }
      ]
    );
    if (!mode) return;
    if (mode === 'cloud') {
      if (!cloudReady({ ...cfg, gasToken })) throw new Error('เชื่อมต่อ Drive ก่อนลบจากทุกเครื่อง');
      busy = true;
      updateControls();
      try {
        await cloud.deleteEverywhere(validateMeeting(target));
      } finally {
        busy = false;
        updateControls();
      }
    }
    await DB.deleteMeeting(row.dataset.id);
    if (row.dataset.id === meeting.id) {
      meeting = newMeeting();
      base = 0;
      clearAudio();
      render();
    }
    await history();
  } else if (event.target.matches('[data-open],[data-summary]')) {
    await save();
    const value = await DB.getMeeting(row.dataset.id);
    if (!value) throw new Error('ไม่พบการประชุม');
    meeting = validateMeeting(value);
    meeting.recording = false;
    base = meeting.dur;
    await save();
    render();
    await renderAudio();
    await tab(event.target.matches('[data-summary]') ? 'sum' : 'rec');
  }
});
for (const button of document.querySelectorAll('.tabs button'))
  button.onclick = run(() => tab(button.dataset.t));
$('#theme').onclick = () => {
  cfg.theme =
    document.documentElement.dataset.theme === 'dark' ||
    (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches)
      ? 'light'
      : 'dark';
  document.documentElement.dataset.theme = cfg.theme;
  try {
    localStorage.setItem('mn_cfg', JSON.stringify(cfg));
  } catch (error) {
    fail(error);
  }
};
$('#bSet').onclick = () =>
  UI.modal(
    'ตั้งค่าระบบ',
    `<p>รหัสผ่านอยู่ในหน่วยความจำแท็บเท่านั้น ปิดหรือรีโหลดต้องใส่ใหม่</p><label class="f" for="cGas">Web App URL</label><input id="cGas" value="${esc(cfg.gasUrl)}" placeholder="https://script.google.com/macros/s/…/exec"><label class="f" for="cGasTok">รหัสผ่านเชื่อมต่อ</label><input id="cGasTok" type="password" autocomplete="off" value="${esc(gasToken)}"><label class="sw"><input id="cUse" type="checkbox" ${cfg.useAudio ? 'checked' : ''}><span></span>ส่งเสียงให้ Gemini และ Drive (ถ้าเกิน 8 MB ให้ใช้ข้อความ)</label><label class="sw"><input id="cCloud" type="checkbox" ${cfg.cloudSync ? 'checked' : ''}><span></span>ซิงก์ข้อมูลและเสียงทั้งหมดกับ Google Drive ข้ามเครื่อง</label><label class="sw"><input id="cAutoDocs" type="checkbox" ${cfg.autoDocs ? 'checked' : ''}><span></span>สร้าง/อัปเดตรายงาน Google Docs อัตโนมัติหลังซิงก์</label><p>เมื่อเปิดซิงก์และกดซิงก์ จะส่งชื่อ ผู้พูด ข้อความ สรุป และเสียงทั้งหมดไป Drive ตามสิทธิ์โฟลเดอร์ การส่งเสียงเพื่อสรุป AI เป็นอีกตัวเลือกหนึ่ง</p><p>โมเดลกำหนดฝั่ง Apps Script ไม่ต้องใส่ API key ในเว็บ</p>`,
    [
      { t: 'ปิด', v: 0 },
      {
        t: 'บันทึก',
        c: 'go',
        fn: () => {
          const value = $('#cGas').value.trim();
          if (value) validateEndpoint(value);
          const next = {
            ...cfg,
            gasUrl: value,
            useAudio: $('#cUse').checked,
            cloudSync: $('#cCloud').checked,
            autoDocs: $('#cAutoDocs').checked
          };
          localStorage.setItem('mn_cfg', JSON.stringify(next));
          cfg = next;
          gasToken = $('#cGasTok').value;
          UI.toast('บันทึกการตั้งค่าแล้ว', 'ok');
          setTimeout(() => scheduleCloud(), 0);
        }
      }
    ]
  );
$('#bImport').onclick = () => $('#importFile').click();
$('#importFile').onchange = run(async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file || !available()) return;
  if (file.size > 10 * 1024 * 1024) throw new Error('ไฟล์ JSON เกิน 10 MB');
  const raw = JSON.parse(await file.text()),
    imported = validateMeeting(raw.meeting || raw, true);
  await save();
  await DB.saveMeeting(imported);
  meeting = imported;
  base = meeting.dur;
  clearAudio();
  $('#full').classList.add('hide');
  render();
  await tab('rec');
  scheduleCloud();
  UI.toast('นำเข้าข้อความแล้ว JSON ไม่รวมไฟล์เสียง', 'ok');
});
document.addEventListener(
  'keydown',
  run(async (event) => {
    if (
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.target.closest('input,textarea,select,[contenteditable],#mb')
    )
      return;
    const n = Number(event.key) - 1;
    if (n >= 0 && n < meeting.speakers.length) {
      meeting.cur = n;
      renderSpeakers();
      await save();
    }
  })
);
window.addEventListener('beforeunload', (event) => {
  if (state !== 'idle' || busy || recovery || unsaved || cloud.running) {
    event.preventDefault();
    event.returnValue = '';
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && ['rec', 'pause'].includes(state)) {
    run(save)();
    UI.toast('เปิดหน้าจอไว้ การบันทึกอาจหยุดเมื่อพักเครื่องหรือปิดจอ', 'warn', 10000);
  }
});
function networkStatus() {
  const online = navigator.onLine !== false;
  $('#net').textContent = online ? '🟢 มีเครือข่าย' : '🔴 ออฟไลน์';
  $('#net').title = 'สถานะเครือข่ายไม่ได้ยืนยันว่า Gemini หรือ Apps Script ใช้งานได้';
}
window.addEventListener('online', () => {
  networkStatus();
  scheduleCloud();
});
window.addEventListener('offline', networkStatus);
networkStatus();
$('#net').onclick = () =>
  UI.toast(
    'ข้อมูลอยู่ในเบราว์เซอร์นี้ ถอดเสียงและ AI อาจต้องอินเทอร์เน็ต สำรอง JSON และเสียงก่อนล้างข้อมูลเว็บ'
  );

function scheduleCloud() {
  clearTimeout(cloudTimer);
  if (
    cloudReady({ ...cfg, gasToken }) &&
    state === 'idle' &&
    !busy &&
    !recovery &&
    navigator.onLine !== false
  ) {
    $('#cloudStatus').textContent = 'มีข้อมูลรอซิงก์';
    cloudTimer = setTimeout(() => run(() => syncCloud(false))(), 3000);
  } else if (!cloudReady({ ...cfg, gasToken }))
    $('#cloudStatus').textContent = 'ซิงก์ยังไม่เชื่อมต่อ';
}
async function audioPartFor(id, part) {
  const target = id === meeting.id ? meeting : await DB.getMeeting(id);
  if (!target) throw new Error('ไม่พบประชุม');
  const local = await DB.getPart(id, part);
  if (local) return local;
  if (!cloudReady({ ...cfg, gasToken }))
    throw new Error('เสียงอยู่บน Drive ต้องใส่รหัสเชื่อมต่อและเปิดซิงก์ก่อนโหลด');
  return cloud.audioPart(target, part);
}
async function syncCloud(manual = true) {
  if (!available()) return;
  if (!cloudReady({ ...cfg, gasToken }))
    throw new Error('เปิดตั้งค่า ใส่ URL/รหัสเชื่อมต่อ และเปิดซิงก์ Drive ก่อน');
  clearTimeout(cloudTimer);
  clearTimeout(editSaveTimer);
  if (unsaved) await save();
  busy = true;
  updateControls();
  const currentId = meeting.id;
  try {
    // Saves already mark cloudDirty; do not manufacture a new edit merely by syncing.
    clearTimeout(cloudTimer);
    const result = await cloud.sync();
    lastCloudConflicts = result.conflicts;
    const current =
      (await DB.getMeeting(currentId)) || (await DB.getAllMeetings()).find((m) => !m.recording);
    if (current) {
      meeting = validateMeeting(current);
      base = meeting.dur;
    } else {
      meeting = newMeeting();
      base = 0;
    }
    render();
    await renderAudio();
    await history();
    $('#bConflicts').classList.toggle('hide', !result.conflicts.length);
    $('#cloudStatus').textContent = result.conflicts.length
      ? `มี ${result.conflicts.length} รายการต้องเลือกรุ่น`
      : 'ซิงก์ข้อความและเสียงแล้ว';
    if (result.documentWarnings?.length) {
      $('#cloudStatus').textContent = 'ข้อมูลซิงก์แล้ว แต่ Docs ยังไม่อัปเดต';
      UI.toast(result.documentWarnings[0].error, 'warn', 12000);
    }
    if (manual)
      UI.toast(
        result.conflicts.length
          ? 'พบข้อมูลต่างรุ่น ไม่ได้เขียนทับ โปรดกดจัดการข้อมูลต่างรุ่น'
          : 'ซิงก์แล้ว เครื่องอื่นกดซิงก์เพื่อโหลดข้อมูลล่าสุด',
        result.conflicts.length ? 'warn' : 'ok'
      );
  } catch (error) {
    $('#cloudStatus').textContent = 'ซิงก์ไม่สำเร็จ ข้อมูลยังอยู่ในเครื่อง';
    throw error;
  } finally {
    busy = false;
    updateControls();
  }
}
async function resolveConflicts() {
  if (!available() || !lastCloudConflicts.length) return;
  const item = lastCloudConflicts[0],
    local = await DB.getMeeting(item.id);
  if (item.reason === 'recording')
    throw new Error(
      'ประชุมนี้ถูกขัดจังหวะ ให้เปิดจากคลังประวัติเพื่อตรวจข้อมูลที่กู้คืน แล้วซิงก์อีกครั้ง'
    );
  if (!local) return;
  const action = await UI.modal(
    'ข้อมูลต่างรุ่น: ' + (item.title || 'ไม่มีชื่อ'),
    '<p>ไม่ได้เขียนทับข้อมูล คุณสามารถสำรอง JSON ก่อน แล้วเลือกใช้รุ่นบนคลาวด์ (ทิ้งการแก้ในเครื่องนี้) หรือสร้างสำเนาใหม่ของข้อมูลในเครื่อง รวมเสียงที่มีในเครื่อง เพื่อรักษาทั้งสองรุ่น</p>',
    [
      { t: 'ยกเลิก', v: null },
      {
        t: 'สำรอง JSON',
        fn: () => {
          download(
            new Blob([JSON.stringify({ format: 'meetnote-text-v2', meeting: local }, null, 2)], {
              type: 'application/json'
            }),
            'conflict-backup.json'
          );
          return false;
        }
      },
      { t: 'ใช้รุ่นคลาวด์', v: 'remote' },
      { t: 'เก็บในเครื่องเป็นสำเนาใหม่', v: 'copy' }
    ]
  );
  if (!action) return;
  busy = true;
  updateControls();
  try {
    if (action === 'remote') {
      if (
        !(await UI.ask(
          'ยืนยันใช้รุ่นคลาวด์?',
          'การแก้ในเครื่องที่ยังไม่ซิงก์จะถูกแทนที่ รวมเสียงในเครื่อง โปรดสำรองก่อน',
          'ใช้รุ่นคลาวด์'
        ))
      )
        return;
      const remote = await cloud.get(item.id);
      if (remote.deleted) await DB.deleteMeeting(item.id);
      else await DB.replaceFromCloud(remote.meeting);
    } else {
      const copy = validateMeeting(local);
      copy.id = uid();
      copy.title = (copy.title + ' (สำเนา)').slice(0, 200);
      copy.cloud = null;
      copy.cloudDirty = true;
      copy.cloudMutation = null;
      copy.cloudDeleteOperation = null;
      copy.docRequest = null;
      // Resolve outstanding remote-only audio before making an independent copy.
      for (let part = 1; part <= copy.part; part++) {
        await cloud.audioPart(local, part);
      }
      await DB.cloneMeetingWithAudio(local.id, copy);
      const remote = await cloud.get(item.id);
      if (remote.deleted) await DB.deleteMeeting(item.id);
      else await DB.replaceFromCloud(remote.meeting);
    }
    if (meeting.id === item.id) {
      const current = await DB.getMeeting(item.id);
      meeting = current ? validateMeeting(current) : newMeeting();
      base = meeting.dur;
      render();
      await renderAudio();
    }
    lastCloudConflicts = lastCloudConflicts.filter((c) => c.id !== item.id);
    $('#bConflicts').classList.toggle('hide', !lastCloudConflicts.length);
    await history();
  } finally {
    busy = false;
    updateControls();
  }
  await syncCloud();
}
$('#bSync').onclick = run(() => syncCloud());
$('#bConflicts').onclick = run(resolveConflicts);
setInterval(() => {
  if (
    document.visibilityState === 'visible' &&
    state === 'idle' &&
    !busy &&
    !recovery &&
    !lastCloudConflicts.length &&
    cloudReady({ ...cfg, gasToken }) &&
    navigator.onLine !== false
  )
    run(() => syncCloud(false))();
}, 60000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) scheduleCloud();
});

// Keep one writer per origin; a second tab must not overwrite a live meeting.
function acquireStorageLock() {
  if (!navigator.locks)
    throw new Error(
      'เบราว์เซอร์ไม่รองรับ Web Locks โปรดอัปเดต Chrome/Edge และใช้ HTTPS หรือ localhost'
    );
  return new Promise((resolve, reject) => {
    navigator.locks
      .request('meetnote-local-editor', { ifAvailable: true }, (lock) => {
        if (!lock) {
          reject(new Error('มีแท็บ MeetNote เปิดอยู่แล้ว โปรดใช้แท็บเดิมหรือปิดแท็บเดิมก่อน'));
          return;
        }
        resolve();
        return new Promise(() => {}); // Released automatically when this page closes.
      })
      .catch(reject);
  });
}
updateControls();
(async () => {
  try {
    await acquireStorageLock();
    await DB.init();
    const stored = await DB.getAllMeetings();
    let invalid = 0;
    for (const value of stored) {
      try {
        meeting = validateMeeting(value);
        break;
      } catch {
        invalid++;
      }
    }
    if (invalid)
      UI.toast(
        'พบข้อมูลที่รูปแบบไม่ถูกต้อง ' +
          invalid +
          ' รายการ ไม่ได้ลบข้อมูลเดิม สามารถสำรอง JSON จากคลังประวัติเพื่อให้ผู้ดูแลตรวจได้',
        'warn',
        15000
      );
    base = meeting.dur;
    if (meeting.recording)
      UI.toast(
        'พบการบันทึกที่ถูกขัดจังหวะ กู้ช่วงเสียงที่บันทึกไว้แล้ว โปรดตรวจช่วงท้าย',
        'warn',
        12000
      );
    if (meeting.recording) {
      meeting.recording = false;
      meeting.cloudDirty = true;
      await DB.saveMeeting(meeting);
    }
    state = 'idle';
    render();
    await renderAudio();
    if (!SpeechRecognition) {
      $('#stt').checked = false;
      $('#stt').disabled = true;
      $('#rstat').textContent =
        'เบราว์เซอร์นี้ไม่รองรับถอดเสียงสด แต่บันทึกเสียงและพิมพ์ข้อความได้';
    }
    if ('serviceWorker' in navigator && window.isSecureContext)
      navigator.serviceWorker
        .register('./sw.js')
        .catch(() => UI.toast('เปิดใช้ออฟไลน์ไม่ได้ ใช้งานออนไลน์ได้', 'warn'));
  } catch (error) {
    state = 'error';
    updateControls();
    fail(
      new Error(
        'เปิดฐานข้อมูลไม่ได้: ' + error.message + ' โปรดใช้โหมดปกติและอนุญาตการเก็บข้อมูลเว็บ'
      )
    );
  }
})();
