/** Convert a bounded mono PCM16 WAV into the existing 24 kHz playback format. */
export function speechWavePcm(wave) {
    if (!Buffer.isBuffer(wave) || wave.length < 44 || wave.length > 32 * 1024 * 1024 || wave.toString('ascii', 0, 4) !== 'RIFF' || wave.toString('ascii', 8, 12) !== 'WAVE')
        throw Error('Invalid speech audio.');
    let rate;
    for (let offset = 12; offset + 8 <= wave.length;) {
        const size = wave.readUInt32LE(offset + 4), start = offset + 8;
        if (start + size > wave.length)
            throw Error('Truncated speech audio.');
        const kind = wave.toString('ascii', offset, offset + 4);
        if (kind === 'fmt ') {
            if (size < 16 || wave.readUInt16LE(start) !== 1 || wave.readUInt16LE(start + 2) !== 1 || wave.readUInt16LE(start + 14) !== 16)
                throw Error('Speech must be mono PCM16.');
            rate = wave.readUInt32LE(start + 4);
            if (rate < 8000 || rate > 96000)
                throw Error('Unsupported speech sample rate.');
        }
        if (kind === 'data') {
            if (!rate || size % 2)
                throw Error('Invalid speech PCM data.');
            const pcm = wave.subarray(start, start + size);
            if (rate === 24000)
                return pcm;
            const samples = size / 2, result = Buffer.alloc(Math.floor(samples * 24000 / rate) * 2);
            for (let i = 0; i < result.length / 2; i++) {
                const position = i * rate / 24000, index = Math.min(Math.floor(position), samples - 1), next = Math.min(index + 1, samples - 1), fraction = position - index;
                result.writeInt16LE(Math.round(pcm.readInt16LE(index * 2) * (1 - fraction) + pcm.readInt16LE(next * 2) * fraction), i * 2);
            }
            return result;
        }
        offset = start + size + (size % 2);
    }
    throw Error('Speech audio has no PCM data.');
}
