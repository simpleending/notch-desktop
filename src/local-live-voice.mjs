import { randomUUID } from 'node:crypto';

/** Local VAD → Whisper → the existing task/permission pipeline → local speech. */
export function createLocalLiveVoice(voice, { voiceSessionId, chatSessionId, speechRate }, emit) {
  const session = new AbortController(); let response = new AbortController();
  let chunks = [], bytes = 0, voiced = 0, silence = 0, busy = false, microphone = true, playback = true, playing = false, playbackEpoch = 0, turnId, callId, playbackTimer;
  const state = (phase, caption, interruptPlayback = false) => emit({ type: 'state', voiceSessionId, chatSessionId, mode: 'live', phase, caption, interruptPlayback });
  const transcript = (role, text, sourceTurnId) => emit({ type: 'transcript', voiceSessionId, mode: 'live', entry: {
    id: randomUUID(), role, text, final: true, createdAt: Date.now(), turnId, ...(sourceTurnId ? {sourceTurnId} : {}),
  } });
  const reset = () => { chunks = []; bytes = 0; voiced = 0; silence = 0; };
  const fail = error => {
    if (session.signal.aborted || response.signal.aborted || error.name === 'AbortError') return;
    busy = false; reset(); state('listening', `Voice: ${error.message}`);
  };
  async function speak(text, sourceTurnId) {
    if (session.signal.aborted || response.signal.aborted) return;
    transcript('assistant', text, sourceTurnId);
    if (!playback) { busy = false; state('listening', text); return; }
    const current = response, epoch = playbackEpoch, signal = AbortSignal.any([session.signal, current.signal]);
    const pcm = await voice.synthesize(text, { signal, rate: speechRate });
    signal.throwIfAborted();
    if (!playback || epoch !== playbackEpoch) { busy = false; reset(); state('listening', text); return; }
    playing = true; state('speaking', text);
    // The renderer's existing playback bridge accepts PCM16 mono at 24 kHz.
    for (let offset = 0; offset < pcm.length; offset += 24000) emit({ type: 'audio', voiceSessionId, audio: pcm.subarray(offset, offset + 24000).toString('base64') });
    clearTimeout(playbackTimer);
    playbackTimer = setTimeout(() => { if (!session.signal.aborted && current === response) { playing = false; busy = false; reset(); state('listening', text); } }, pcm.length / 48 + 300);
  }
  async function finishUtterance() {
    if (busy || !voiced) return;
    const pcm = Buffer.concat(chunks); reset(); busy = true;
    response.abort(); response = new AbortController();
    const current = response, signal = AbortSignal.any([session.signal, current.signal]);
    try {
      state('thinking');
      const text = (await voice.transcribe(pcm, { signal })).trim(); signal.throwIfAborted();
      if (!text) { busy = false; state('listening'); return; }
      turnId = `live-voice:${voiceSessionId}:${randomUUID()}`; callId = randomUUID();
      transcript('user', text);
      emit({ type: 'toolCall', voiceSessionId, chatSessionId, turnId, callId, name: 'SpawnBackendAgent', arguments: JSON.stringify({ request: text }) });
    } catch (error) { if (!current.signal.aborted) fail(error); }
  }
  return {
    sendAudio(audio) {
      if (session.signal.aborted || busy || !microphone || !(audio instanceof Uint8Array) || audio.byteLength > 64000 || audio.byteLength % 2) return false;
      const pcm = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength); if (!pcm.length) return false;
      let sum = 0; for (let offset = 0; offset < pcm.length; offset += 2) sum += (pcm.readInt16LE(offset) / 32768) ** 2;
      const duration = pcm.length / 32, speech = Math.sqrt(sum / (pcm.length / 2)) >= 0.008;
      if (!voiced && !speech) return true;
      chunks.push(Buffer.from(pcm)); bytes += pcm.length;
      if (speech) { voiced += duration; silence = 0; } else silence += duration;
      if ((voiced >= 300 && silence >= 900) || bytes >= 16000 * 2 * 20) void finishUtterance();
      else if (silence >= 900) reset();
      return true;
    },
    completeToolCall(request) {
      if (request.callId !== callId || session.signal.aborted) return false;
      let result; try { result = JSON.parse(request.output); } catch { return false; }
      if (!result.accepted) { busy = false; state('listening', result.message || 'Request was not accepted.'); }
      return true;
    },
    sendContext(request) {
      if (session.signal.aborted || typeof request.text !== 'string' || request.text.length > 200000) return false;
      if (request.text.startsWith('[COMPLETE]')) {
        const json = request.text.slice(request.text.indexOf('\n{') + 1);
        let result; try { result = JSON.parse(json); } catch { return false; }
        if (result.handoffId !== callId) return false;
        const text = typeof result.result === 'string' && result.result.trim() ? result.result.trim() : `Task ${result.status || 'finished'}.`;
        void speak(text, request.sourceTurnId).catch(fail); return true;
      }
      // Permission notices and queue announcements are shown in the existing task UI.
      return true;
    },
    cancelResponse() { response.abort(); clearTimeout(playbackTimer); reset(); playing = false; busy = false; state('listening', undefined, true); return true; },
    setMicrophoneEnabled(enabled) { microphone = enabled; reset(); return true; },
    setPlaybackEnabled(enabled) { playback = enabled; playbackEpoch++; if (!enabled && playing) { clearTimeout(playbackTimer); playing = false; busy = false; state('listening', undefined, true); } return true; },
    stop() { session.abort(); response.abort(); clearTimeout(playbackTimer); reset(); state('idle'); },
  };
}
