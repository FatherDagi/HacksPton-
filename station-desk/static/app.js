const state = { officers: [], calls: [], config: {} };
let selectedId = null;
let knownIds = new Set();
let practiceId = null;
let audioWs = null;
let audioContext = null;
let micStream = null;
let captureNode = null;
let captureHolder = null;
let silentGain = null;
let toastTimer = null;
// On Vercel the desk is public under /desk; locally and via bindings it is at /.
const DESK_BASE = (location.pathname === "/desk" || location.pathname.indexOf("/desk/") === 0) ? "/desk" : "";
function deskPath(path) {
  if (!path) return DESK_BASE || "/";
  return DESK_BASE + (path.charAt(0) === "/" ? path : "/" + path);
}

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  Object.entries(attrs || {}).forEach(function (entry) {
    const key = entry[0];
    const value = entry[1];
    if (value == null || value === false) return;
    if (key === "class") node.className = value;
    else node.setAttribute(key, String(value));
  });
  (children || []).forEach(function (child) {
    if (child == null || child === false) return;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  });
  return node;
}

function toast(message) {
  const node = document.getElementById("toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { node.classList.remove("show"); }, 4500);
}

async function api(path, options) {
  const response = await fetch(deskPath(path), Object.assign({
    headers: { "Content-Type": "application/json" },
  }, options || {}));
  const data = await response.json().catch(function () { return {}; });
  if (!response.ok) {
    const detail = data.detail;
    throw new Error(typeof detail === "string" ? detail : "Request failed");
  }
  return data;
}

function clockTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function callLabel(call) {
  if (call.source === "mic") return "Practice call";
  if (call.source === "upload") return call.from_number || "Recording";
  return call.from_number || "Phone call";
}

function callById(id) {
  return state.calls.find(function (call) { return call.id === id; }) || null;
}

function connect() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(protocol + "://" + location.host + deskPath("/ws/console"));
  socket.onmessage = function (event) {
    const message = JSON.parse(event.data);
    if (message.type === "play") playTranslation(message);
    if (message.type === "snapshot") onSnapshot(message);
  };
  socket.onclose = function () {
    setTimeout(connect, 1000);
  };
}

function onSnapshot(message) {
  const calls = message.calls || [];
  const ids = new Set(calls.map(function (call) { return call.id; }));
  const fresh = calls.find(function (call) {
    return call.status === "live" && !knownIds.has(call.id);
  });
  if (fresh) selectedId = fresh.id;
  else if (!selectedId || !ids.has(selectedId)) selectedId = calls.length ? calls[0].id : null;
  knownIds = ids;
  state.officers = message.officers || [];
  state.calls = calls;
  state.config = message.config || {};
  render();
}

function render() {
  renderChips();
  renderCalls();
  renderDetail();
  updatePracticeButton();
  updateTalkButton();
}

function renderChips() {
  const config = state.config || {};
  const gemini = document.getElementById("chip-gemini");
  gemini.textContent = config.gemini_configured ? "Gemini connected" : "Gemini key missing";
  gemini.className = "chip " + (config.gemini_configured ? "ok" : "bad");
  const phone = document.getElementById("chip-phone");
  if (config.desk_number) {
    phone.textContent = "Rings " + config.desk_number;
    phone.className = "chip ok";
  } else if (config.public_base_url) {
    phone.textContent = "Number connected";
    phone.className = "chip ok";
  } else {
    phone.textContent = "Phone line not connected";
    phone.className = "chip";
  }
  const banner = document.getElementById("banner");
  if (!config.gemini_configured) {
    banner.hidden = false;
    banner.textContent = "Add your Gemini API key as GEMINI_API_KEY in the .env file, then restart the desk.";
  } else if (config.desk_number && !config.twilio_checks_signature) {
    banner.hidden = false;
    banner.textContent = "Caller speech is translated into English on this screen and in the transcript. Add TWILIO_AUTH_TOKEN to .env and restart so the caller hears the reply in their own language.";
  } else {
    banner.hidden = true;
  }
}

function renderCalls() {
  const list = document.getElementById("call-list");
  if (!state.calls.length) {
    list.replaceChildren(el("p", { class: "hint", style: "padding:14px" }, ["No calls yet."]));
    return;
  }
  list.replaceChildren.apply(list, state.calls.map(function (call) {
    const liveText = call.partial && call.partial.text;
    const last = call.transcript && call.transcript.length ? call.transcript[call.transcript.length - 1].text : "";
    const button = el("button", {
      type: "button",
      class: "call" + (call.id === selectedId ? " selected" : ""),
    }, [
      el("div", { class: "top" }, [
        el("span", { class: "who-line" }, [callLabel(call)]),
        el("span", { class: "pri" }, [call.status === "live" ? "Live" : "Ended"]),
      ]),
      el("div", { class: "sub" }, [liveText || last || "Listening"]),
    ]);
    button.addEventListener("click", function () {
      selectedId = call.id;
      render();
    });
    return button;
  }));
}

function renderDetail() {
  const root = document.getElementById("detail");
  const previous = document.getElementById("transcript");
  let stick = true;
  let saved = 0;
  if (previous) {
    stick = previous.scrollHeight - previous.scrollTop - previous.clientHeight < 48;
    saved = previous.scrollTop;
  }
  const call = callById(selectedId);
  if (!call) {
    root.replaceChildren(emptyState());
    return;
  }
  root.replaceChildren(keywordBar(call), transcriptBlock(call));
  const next = document.getElementById("transcript");
  if (next) next.scrollTop = stick ? next.scrollHeight : saved;
}

function emptyState() {
  return el("div", { class: "empty" }, [
    el("h2", {}, ["The transcript fills in while the call is going."]),
    el("p", {}, [
      "Gemini listens the whole time the call is open. Words show up while someone is still talking, then settle into a clean English line.",
    ]),
    el("p", {}, [
      "Take a practice call and speak as the caller. Save text file downloads the transcript.",
    ]),
  ]);
}

function keywordBar(call) {
  const keywords = call.keywords || [];
  const chips = keywords.map(function (word) {
    return el("span", { class: "tag" }, [word]);
  });
  const save = el("button", { type: "button" }, ["Save text file"]);
  save.addEventListener("click", function () { saveTranscript(call.id); });
  const language = call.caller_language && call.caller_language !== "English"
    ? el("p", { class: "muted" }, [
      "Caller is speaking " + call.caller_language + ". You hear English. The caller hears " + call.caller_language + ".",
    ])
    : null;
  return el("div", { class: "keyword-bar" }, [
    el("div", { class: "top" }, [
      el("h3", {}, ["Keywords"]),
      save,
    ]),
    language,
    chips.length
      ? el("div", { class: "suggest" }, chips)
      : el("p", { class: "muted" }, ["Keywords show up here as they are spoken."]),
  ]);
}

function highlight(text, keywords) {
  const usable = (keywords || []).filter(Boolean).sort(function (a, b) {
    return b.length - a.length;
  });
  if (!usable.length || !text) return [text || ""];
  const pattern = usable.map(function (word) {
    return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("|");
  return text.split(new RegExp("(" + pattern + ")", "ig")).map(function (part) {
    const hit = usable.some(function (word) {
      return word.toLowerCase() === part.toLowerCase();
    });
    return hit ? el("mark", {}, [part]) : part;
  });
}

function transcriptBlock(call) {
  const keywords = call.keywords || [];
  const lines = (call.transcript || []).map(function (line) {
    const speakerClass = line.speaker === "Call-taker" ? "who taker" : line.speaker === "Caller" ? "who caller" : "who";
    return el("div", { class: "line" }, [
      el("div", { class: speakerClass }, [line.speaker, el("span", { class: "when" }, [clockTime(line.t)])]),
      el("div", { class: "said" }, highlight(line.text, keywords)),
    ]);
  });
  if (call.partial && call.partial.text) {
    lines.push(el("div", { class: "line live" }, [
      el("div", { class: "who caller" }, [call.partial.speaker || "Caller", el("span", { class: "when" }, ["live"])]),
      el("div", { class: "said" }, highlight(call.partial.text, keywords)),
    ]));
  }
  const notes = [];
  if (!lines.length) notes.push(el("p", { class: "muted" }, ["Listening."]));
  if (call.pending > 0 && !(call.partial && call.partial.text)) {
    notes.push(el("p", { class: "status-line busy" }, ["Transcribing…"]));
  }
  if (call.last_error) notes.push(el("p", { class: "status-line error" }, [call.last_error]));
  return el("div", { class: "transcript", id: "transcript" }, notes.concat(lines));
}

async function saveTranscript(callId) {
  const response = await fetch(deskPath("/api/calls/" + callId + "/transcript.txt"));
  if (!response.ok) {
    toast("The text file could not be saved.");
    return;
  }
  const match = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") || "");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(await response.blob());
  link.download = match ? match[1] : "transcript.txt";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

let playCtx = null;
let playAt = 0;
let talking = false;
let replyWs = null;

function playTranslation(message) {
  if (!message || !message.pcm) return;
  if (!playCtx) playCtx = new AudioContext();
  if (playCtx.state === "suspended") playCtx.resume();
  const binary = atob(message.pcm);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const samples = Math.floor(bytes.length / 2);
  if (!samples) return;
  const audio = playCtx.createBuffer(1, samples, message.rate || 24000);
  const channel = audio.getChannelData(0);
  for (let i = 0; i < samples; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
  const source = playCtx.createBufferSource();
  source.buffer = audio;
  source.connect(playCtx.destination);
  const now = playCtx.currentTime;
  if (!playAt || playAt < now) playAt = now + 0.08;
  source.start(playAt);
  playAt += audio.duration;
}

function updateTalkButton() {
  const button = document.getElementById("talk");
  const call = callById(selectedId);
  const phone = call && call.source === "phone" && call.status === "live" && !practiceId && state.config.twilio_checks_signature;
  button.hidden = !phone;
  button.textContent = talking ? "Stop talking" : "Talk to caller";
  button.setAttribute("aria-pressed", talking ? "true" : "false");
}

document.getElementById("talk").addEventListener("click", function () {
  if (talking) stopReply();
  else startReply();
});

async function startReply() {
  const call = callById(selectedId);
  if (!call || call.source !== "phone" || practiceId) return;
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  replyWs = new WebSocket(protocol + "://" + location.host + deskPath("/ws/reply/" + call.id));
  replyWs.binaryType = "arraybuffer";
  try {
    await new Promise(function (resolve, reject) {
      replyWs.onopen = resolve;
      replyWs.onerror = function () { reject(new Error("The reply microphone could not connect.")); };
    });
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    audioContext = new AudioContext();
    if (audioContext.state === "suspended") await audioContext.resume();
    const source = audioContext.createMediaStreamSource(micStream);
    audioWs = replyWs;
    captureNode = await createCapture(audioContext, source);
    talking = true;
    updateTalkButton();
  } catch (error) {
    stopReply();
    toast(error.message || "Microphone permission is required to talk to the caller.");
  }
}

function stopReply() {
  talking = false;
  if (replyWs) {
    const socket = replyWs;
    replyWs = null;
    if (audioWs === socket) audioWs = null;
    socket.onclose = null;
    socket.close();
  }
  if (!practiceId) stopMic();
  updateTalkButton();
}

function updatePracticeButton() {
  const button = document.getElementById("practice");
  button.textContent = practiceId ? "End practice call" : "Take a practice call";
  button.setAttribute("aria-pressed", practiceId ? "true" : "false");
  document.getElementById("meter-wrap").hidden = !practiceId;
}

document.getElementById("practice").addEventListener("click", function () {
  if (practiceId) endPractice();
  else startPractice();
});

document.getElementById("file").addEventListener("change", async function (event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = "";
  if (!file) return;
  const body = new FormData();
  body.append("file", file);
  try {
    const response = await fetch(deskPath("/api/calls/upload"), { method: "POST", body: body });
    const data = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Upload failed");
    selectedId = data.id;
  } catch (error) {
    toast(error.message);
  }
});

async function startPractice() {
  let call;
  try {
    call = await api("/api/calls", { method: "POST", body: JSON.stringify({ source: "mic" }) });
  } catch (error) {
    toast(error.message);
    return;
  }
  practiceId = call.id;
  selectedId = call.id;
  updatePracticeButton();
  try {
    await startMic(call.id);
  } catch (error) {
    practiceId = null;
    updatePracticeButton();
    await fetch(deskPath("/api/calls/" + call.id + "/end"), { method: "POST" }).catch(function () {});
    toast(error.message || "Microphone permission is required for a practice call.");
  }
}

async function endPractice() {
  const id = practiceId;
  if (captureNode) {
    try { captureNode.disconnect(); } catch (error) { /* already stopped */ }
  }
  await new Promise(function (resolve) { setTimeout(resolve, 80); });
  flushCapture(true);
  if (audioWs && audioWs.bufferedAmount) {
    await new Promise(function (resolve) { setTimeout(resolve, 200); });
  }
  stopMic();
  practiceId = null;
  updatePracticeButton();
  if (id) {
    await fetch(deskPath("/api/calls/" + id + "/end"), { method: "POST" }).catch(function () {});
  }
}

async function startMic(callId) {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
  });
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  audioWs = new WebSocket(protocol + "://" + location.host + deskPath("/ws/audio/" + callId));
  audioWs.binaryType = "arraybuffer";
  await new Promise(function (resolve, reject) {
    audioWs.onopen = resolve;
    audioWs.onerror = function () { reject(new Error("The practice call could not connect.")); };
  });
  audioContext = new AudioContext();
  if (audioContext.state === "suspended") await audioContext.resume();
  const source = audioContext.createMediaStreamSource(micStream);
  captureNode = await createCapture(audioContext, source);
}

async function createCapture(context, source) {
  captureHolder = { pending: [], samples: 0 };
  const worklet = [
    "class CaptureProcessor extends AudioWorkletProcessor {",
    "  process(inputs) {",
    "    const channel = inputs[0] && inputs[0][0];",
    "    if (channel) this.port.postMessage(channel.slice(0));",
    "    return true;",
    "  }",
    "}",
    "registerProcessor('capture', CaptureProcessor);",
  ].join("\n");
  const url = URL.createObjectURL(new Blob([worklet], { type: "application/javascript" }));
  try {
    await context.audioWorklet.addModule(url);
    const node = new AudioWorkletNode(context, "capture");
    node.port.onmessage = function (event) {
      pushSamples(captureHolder, event.data, context.sampleRate);
    };
    silentGain = context.createGain();
    silentGain.gain.value = 0;
    source.connect(node);
    node.connect(silentGain);
    silentGain.connect(context.destination);
    return node;
  } catch (error) {
    const processor = context.createScriptProcessor(4096, 1, 1);
    silentGain = context.createGain();
    silentGain.gain.value = 0;
    processor.onaudioprocess = function (event) {
      pushSamples(captureHolder, event.inputBuffer.getChannelData(0).slice(0), context.sampleRate);
    };
    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(context.destination);
    return processor;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function pushSamples(holder, float32, inputRate) {
  const down = downsample(float32, inputRate, 16000);
  let sum = 0;
  for (let i = 0; i < down.length; i++) sum += down[i] * down[i];
  const rms = down.length ? Math.sqrt(sum / down.length) : 0;
  const meter = document.getElementById("meter");
  if (meter) meter.style.width = Math.min(100, Math.round(rms * 400)) + "%";
  if (!down.length) return;
  holder.pending.push(down);
  holder.samples += down.length;
  const frame = 1600;
  while (holder.samples >= frame) sendFrame(holder, frame);
}

function flushCapture() {
  const holder = captureHolder;
  if (!holder || holder.samples < 160) return;
  sendFrame(holder, holder.samples);
}

function sendFrame(holder, count) {
  const audio = concatFloats(holder.pending);
  const frame = audio.subarray(0, count);
  const rest = audio.subarray(count);
  holder.pending = rest.length ? [rest] : [];
  holder.samples = rest.length;
  if (!frame.length || !audioWs || audioWs.readyState !== 1) return;
  audioWs.send(encodePcm(frame));
}

function concatFloats(chunks) {
  let total = 0;
  chunks.forEach(function (chunk) { total += chunk.length; });
  const out = new Float32Array(total);
  let offset = 0;
  chunks.forEach(function (chunk) {
    out.set(chunk, offset);
    offset += chunk.length;
  });
  return out;
}

function downsample(input, inRate, outRate) {
  if (!input.length) return new Float32Array();
  if (inRate === outRate) return input;
  const ratio = inRate / outRate;
  const length = Math.floor(input.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const mix = position - left;
    out[i] = input[left] * (1 - mix) + input[right] * mix;
  }
  return out;
}

function encodePcm(samples) {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return buffer;
}

function stopMic() {
  captureHolder = null;
  if (audioWs) {
    audioWs.onclose = null;
    audioWs.close();
    audioWs = null;
  }
  if (captureNode) {
    try { captureNode.disconnect(); } catch (error) { /* already stopped */ }
    captureNode = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  if (micStream) {
    micStream.getTracks().forEach(function (track) { track.stop(); });
    micStream = null;
  }
  silentGain = null;
}

function tick() {
  document.getElementById("clock").textContent = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

tick();
setInterval(tick, 1000);
connect();
