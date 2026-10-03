import { Avatar } from './avatar.js';

// ---------- Utilidades de almacenamiento (seguras) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const SCENARIOS = {
  free: { es: 'Conversación libre', en: 'Free conversation about the student\'s day, interests and work.' },
  supplier: { es: 'Negociación con proveedor', en: 'Role-play: you are an international raw-material supplier (vitamins, minerals, food ingredients). The student is the buyer negotiating price, MOQ, lead times, Incoterms and payment terms.' },
  meeting: { es: 'Reunión de trabajo', en: 'Role-play: a video call with a foreign colleague. Practice presenting results, giving opinions and agreeing on next steps.' },
  travel: { es: 'Aeropuerto y viaje', en: 'Role-play: airport check-in, immigration questions, hotel check-in and asking for directions.' },
  restaurant: { es: 'Restaurante', en: 'Role-play: you are a waiter at a restaurant in the US. The student orders food, asks questions and pays.' },
  interview: { es: 'Entrevista de trabajo', en: 'Role-play: you are an interviewer for a procurement/supply chain position at a multinational company.' },
  smalltalk: { es: 'Small talk', en: 'Casual small talk: weather, weekend plans, sports, family, food.' },
};

const DEFAULTS = { apiKey: '', model: 'gemini-flash-latest', proxyUrl: '', proxyToken: '', level: 'B1', rate: '0.9', scenario: 'free', voice: '' };
let settings = { ...DEFAULTS, ...store.get('settings', {}) };
let history = [];          // contenido para Gemini
let words = store.get('words', []);   // [{word, meaning_es}]
let stats = store.get('stats', { streak: 0, lastDay: '', messages: 0 });

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const chat = $('chat'), text = $('text'), micBtn = $('mic'), sendBtn = $('send'), statusEl = $('status');
const avatar = new Avatar($('stage'));
window.tutorAvatar = avatar; // útil para depurar

function setStatus(msg, live = false) { statusEl.textContent = msg; statusEl.classList.toggle('live', live); }
function scrollDown() { chat.scrollTop = chat.scrollHeight; }
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function addSys(msg, err = false) { chat.append(el('div', 'sys' + (err ? ' err' : ''), esc(msg))); scrollDown(); }
function addUser(t) { chat.append(el('div', 'msg user', esc(t))); scrollDown(); }
function addTutor(res) {
  const b = el('div', 'msg tutor');
  const replay = el('button', 'replay', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>');
  replay.setAttribute('aria-label', 'Repetir audio');
  replay.onclick = () => speak(res.reply);
  b.append(replay, document.createTextNode(res.reply));
  if (res.correction) {
    const f = el('div', 'fix', `<b>Mejor dicho:</b> ${esc(res.correction)}` + (res.explanation_es ? `<div class="es">${esc(res.explanation_es)}</div>` : ''));
    chat.append(f);
  }
  chat.append(b);
  if (res.new_words?.length) {
    const w = el('div', 'words');
    res.new_words.forEach((x) => w.append(el('span', 'word', `${esc(x.word)} · ${esc(x.meaning_es)}`)));
    chat.append(w);
  }
  scrollDown();
}

function renderStats() {
  $('stats').textContent = `${stats.streak} ${stats.streak === 1 ? 'día' : 'días'} · ${words.length} palabras`;
  $('scenarioChip').textContent = `${SCENARIOS[settings.scenario]?.es || ''} · ${settings.level}`;
}
function bumpStats() {
  const today = new Date().toISOString().slice(0, 10);
  if (stats.lastDay !== today) {
    const y = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    stats.streak = stats.lastDay === y ? stats.streak + 1 : 1;
    stats.lastDay = today;
  }
  stats.messages++;
  store.set('stats', stats);
  renderStats();
}

// ---------- Gemini ----------
function systemPrompt() {
  const sc = SCENARIOS[settings.scenario] || SCENARIOS.free;
  return `You are "Alex", a warm, patient English tutor talking by voice with a Spanish-speaking adult from Colombia who works as a procurement coordinator in the food ingredients industry.
Student CEFR level: ${settings.level}. Scenario: ${sc.en}

Rules:
- "reply": your spoken answer in English. 1 to 3 short sentences, vocabulary and grammar suited to ${settings.level}. Stay in the scenario and ALWAYS end with a question or prompt that keeps the student talking. No emojis, no markdown, no lists (it will be read aloud).
- "correction": if the student's LAST message has grammar, vocabulary or naturalness mistakes, write the natural corrected English version. If the student wrote in Spanish, write how to say it in English. If it is correct, return "".
- "explanation_es": if there is a correction, a very short explanation in Spanish (max 25 words). Otherwise "".
- "new_words": 0 to 2 useful words or phrases from YOUR reply that may be new for a ${settings.level} student, with a short Spanish meaning.
- Speech-to-text may drop punctuation or capital letters: never correct punctuation, capitalization or obvious transcription glitches.
- The message "[START]" means the session begins: greet the student briefly, set up the scenario and ask the first question. Do not correct it.`;
}

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    reply: { type: 'STRING' },
    correction: { type: 'STRING' },
    explanation_es: { type: 'STRING' },
    new_words: { type: 'ARRAY', items: { type: 'OBJECT', properties: { word: { type: 'STRING' }, meaning_es: { type: 'STRING' } }, required: ['word', 'meaning_es'] } },
  },
  required: ['reply', 'correction', 'explanation_es', 'new_words'],
};

function modelId() { return (settings.model || DEFAULTS.model).trim().replace(/^models\//, ''); }

async function callGemini(payload) {
  let data;
  if (settings.proxyUrl) {
    const r = await fetch(settings.proxyUrl, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'generate', token: settings.proxyToken, model: modelId(), payload }),
    });
    data = await r.json();
  } else {
    if (!settings.apiKey) throw Object.assign(new Error('Falta la clave de API. Ábrela en Ajustes.'), { code: 'nokey' });
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId())}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.apiKey },
      body: JSON.stringify(payload),
    });
    data = await r.json().catch(() => ({ error: { code: r.status, message: r.statusText } }));
  }
  if (data.error) {
    const c = data.error.code;
    let msg = data.error.message || 'Error desconocido';
    if (c === 429) msg = 'Alcanzaste el límite gratuito por minuto o por día. Espera un momento e intenta de nuevo.';
    else if (c === 400 && /API key/i.test(msg)) msg = 'La clave de API no es válida. Revísala en Ajustes.';
    else if (c === 403) msg = 'Acceso denegado: revisa la clave de API o el token del intermediario.';
    else if (c === 404) msg = `El modelo "${modelId()}" no existe. En Ajustes toca "Ver modelos" y elige otro.`;
    else if (c === 401) msg = 'Token del intermediario incorrecto.';
    throw new Error(msg);
  }
  const parts = data.candidates?.[0]?.content?.parts || [];
  const raw = parts.filter((p) => !p.thought).map((p) => p.text || '').join('').trim();
  if (!raw) throw new Error('Gemini no devolvió respuesta. Intenta otra vez.');
  try {
    const j = JSON.parse(raw.replace(/^```(json)?|```$/g, ''));
    return { reply: j.reply || '', correction: j.correction || '', explanation_es: j.explanation_es || '', new_words: Array.isArray(j.new_words) ? j.new_words : [] };
  } catch {
    return { reply: raw, correction: '', explanation_es: '', new_words: [] };
  }
}

let busy = false;
async function send(userText, { hidden = false } = {}) {
  userText = userText.trim();
  if (!userText || busy) return;
  busy = true; sendBtn.disabled = true;
  stopSpeaking();
  chat.querySelector('.sys .btn')?.parentElement.remove();
  if (!hidden) { addUser(userText); bumpStats(); }
  history.push({ role: 'user', parts: [{ text: userText }] });
  avatar.setMode('thinking'); setStatus('Alex está pensando…');
  try {
    const res = await callGemini({
      systemInstruction: { parts: [{ text: systemPrompt() }] },
      contents: history.slice(-20),
      generationConfig: { temperature: 0.8, responseMimeType: 'application/json', responseSchema: SCHEMA },
    });
    history.push({ role: 'model', parts: [{ text: res.reply }] });
    addTutor(res);
    saveWords(res.new_words);
    speak(res.reply);
  } catch (e) {
    history.pop();
    avatar.setMode('idle'); setStatus('Toca el micrófono para hablar');
    addSys(e.message, true);
    if (e.code === 'nokey') openSettings();
  } finally {
    busy = false; sendBtn.disabled = false;
  }
}

function saveWords(list) {
  let changed = false;
  for (const w of list || []) {
    if (w?.word && !words.some((x) => x.word.toLowerCase() === w.word.toLowerCase())) { words.unshift(w); changed = true; }
  }
  if (changed) { words = words.slice(0, 500); store.set('words', words); renderStats(); }
}

// ---------- Voz del avatar (TTS) ----------
const synth = window.speechSynthesis;
let voices = [];
function loadVoices() {
  if (!synth) return;
  voices = synth.getVoices().filter((v) => /^en[-_]/i.test(v.lang));
  const sel = $('voice');
  sel.innerHTML = '';
  if (!voices.length) { sel.append(new Option('Voz predeterminada del sistema', '')); return; }
  const sorted = [...voices].sort((a, b) => (b.lang === 'en-US') - (a.lang === 'en-US') || a.name.localeCompare(b.name));
  sorted.forEach((v) => sel.append(new Option(`${v.name} (${v.lang})`, v.voiceURI)));
  sel.value = settings.voice && voices.some((v) => v.voiceURI === settings.voice) ? settings.voice : sorted[0].voiceURI;
}
if (synth) { loadVoices(); synth.onvoiceschanged = loadVoices; }

function speak(t) {
  if (!synth || !t) { avatar.setMode('idle'); setStatus('Toca el micrófono para responder'); return; }
  synth.cancel();
  const u = new SpeechSynthesisUtterance(t);
  const v = voices.find((x) => x.voiceURI === settings.voice) || voices.find((x) => x.lang === 'en-US') || voices[0];
  if (v) u.voice = v;
  u.lang = v?.lang || 'en-US';
  u.rate = parseFloat(settings.rate) || 0.9;
  u.onstart = () => { avatar.setSpeaking(true); setStatus('Alex está hablando…'); };
  u.onboundary = (e) => {
    if (e.name && e.name !== 'word') return;
    const word = t.slice(e.charIndex).split(/\s+/)[0];
    avatar.speakWord(word, u.rate);
  };
  const done = () => { avatar.setSpeaking(false); setStatus('Toca el micrófono para responder'); };
  u.onend = done; u.onerror = done;
  synth.speak(u);
}
function stopSpeaking() { if (synth?.speaking) synth.cancel(); avatar.setSpeaking(false); }

// ---------- Micrófono (reconocimiento de voz) ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, listening = false, finalText = '';
if (!SR) {
  micBtn.disabled = true;
  micBtn.title = 'Este navegador no soporta reconocimiento de voz. Usa Chrome en Android.';
}
function startListening() {
  if (!SR || busy) return;
  stopSpeaking();
  rec = new SR();
  rec.lang = 'en-US';
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  finalText = '';
  rec.onstart = () => { listening = true; micBtn.classList.add('on'); avatar.setMode('listening'); setStatus('Escuchando… habla en inglés', true); };
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
    }
    text.value = (finalText + ' ' + interim).trim();
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') addSys('Permite el uso del micrófono para esta app en los ajustes del navegador.', true);
    else if (e.error === 'no-speech') setStatus('No te escuché. Toca el micrófono e intenta de nuevo.');
    else if (e.error !== 'aborted') addSys('Error del micrófono: ' + e.error, true);
  };
  rec.onend = () => {
    listening = false; micBtn.classList.remove('on');
    if (avatar.mode === 'listening') avatar.setMode('idle');
    const said = (finalText || text.value).trim();
    if (said) { text.value = ''; send(said); }
    else if (!busy) setStatus('Toca el micrófono para hablar');
  };
  try { rec.start(); } catch {}
}
micBtn.onclick = () => (listening ? rec?.stop() : startListening());

// ---------- Texto ----------
sendBtn.onclick = () => { const t = text.value; text.value = ''; autosize(); send(t); };
text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBtn.click(); } });
function autosize() { text.style.height = 'auto'; text.style.height = Math.min(text.scrollHeight, 110) + 'px'; }
text.addEventListener('input', autosize);

// ---------- Ajustes ----------
const dlg = $('settings');
Object.entries(SCENARIOS).forEach(([k, v]) => $('scenario').append(new Option(v.es, k)));
function openSettings() {
  for (const k of ['apiKey', 'model', 'proxyUrl', 'proxyToken', 'level', 'rate', 'scenario']) $(k).value = settings[k] ?? '';
  loadVoices();
  const wl = $('wordList');
  wl.innerHTML = words.length ? '' : '<span class="sys">Aún no hay palabras. Aparecerán mientras conversas.</span>';
  words.slice(0, 120).forEach((w) => wl.append(el('span', 'word', `${esc(w.word)} <span>· ${esc(w.meaning_es)}</span>`)));
  dlg.showModal();
}
function readForm() {
  const prevScenario = settings.scenario, prevLevel = settings.level;
  for (const k of ['apiKey', 'model', 'proxyUrl', 'proxyToken', 'level', 'rate', 'scenario', 'voice']) settings[k] = $(k).value.trim();
  store.set('settings', settings);
  renderStats();
  return prevScenario !== settings.scenario || prevLevel !== settings.level;
}
$('settingsBtn').onclick = openSettings;
$('settingsForm').addEventListener('submit', () => {
  const changed = readForm();
  if ((settings.apiKey || settings.proxyUrl) && (changed || history.length === 0)) newSession();
});
$('testVoice').onclick = () => { readForm(); speak("Hi! I'm Alex, your English tutor. Let's practice together."); };
$('loadModels').onclick = async () => {
  readForm();
  const btn = $('loadModels'); btn.textContent = 'Cargando…';
  try {
    let data;
    if (settings.proxyUrl) {
      data = await (await fetch(settings.proxyUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'models', token: settings.proxyToken }) })).json();
    } else {
      data = await (await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': settings.apiKey } })).json();
    }
    if (data.error) throw new Error(data.error.message);
    const list = (data.models || [])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent') && /gemini/i.test(m.name) && !/embedding|tts|image|live|audio/i.test(m.name))
      .map((m) => m.name.replace(/^models\//, ''));
    const dl = $('modelList'); dl.innerHTML = '';
    list.forEach((n) => dl.append(new Option(n, n)));
    btn.textContent = `${list.length} modelos`;
    $('model').focus();
  } catch (e) {
    btn.textContent = 'Ver modelos';
    alert('No se pudo cargar la lista: ' + e.message);
  }
};

function newSession() {
  stopSpeaking();
  history = [];
  chat.innerHTML = '';
  addSys(`Escenario: ${SCENARIOS[settings.scenario].es} · Nivel ${settings.level}`);
  send('[START]', { hidden: true });
}
$('newBtn').onclick = () => { if (!busy) newSession(); };

// ---------- Inicio ----------
function showStart() {
  const wrap = el('div', 'sys');
  wrap.append(document.createTextNode('Toca "Empezar clase" para que Alex te salude, o háblale directamente. '));
  const b = el('button', 'btn primary', 'Empezar clase');
  b.style.marginTop = '8px';
  b.onclick = () => { wrap.remove(); newSession(); };
  wrap.append(el('br'), b);
  chat.append(wrap);
}
renderStats();
if (!settings.apiKey && !settings.proxyUrl) {
  addSys('Bienvenido. Primero configura tu clave de Gemini en Ajustes (icono de engranaje).');
  setTimeout(openSettings, 400);
} else {
  showStart();
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
