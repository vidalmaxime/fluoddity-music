// Counting sort of particle slots by tile key → permutation (new slot → old slot).
onmessage = ({ data }) => {
    const { keys, count, texW, texH, rowStride, nkeys, gen } = data;
    const counts = new Int32Array(nkeys + 1);
    const k = new Int32Array(count);
    for (let s = 0; s < count; s++) {
        const y = (s / texW) | 0, x = s - y * texW;
        const v = Math.min(nkeys - 1, Math.max(0, keys[y * rowStride + x] | 0));
        k[s] = v;
        counts[v + 1]++;
    }
    for (let i = 0; i < nkeys; i++) counts[i + 1] += counts[i];
    const perm = new Float32Array(texW * texH);
    for (let s = 0; s < count; s++) perm[counts[k[s]]++] = s;
    for (let s = count; s < perm.length; s++) perm[s] = s;
    postMessage({ perm, gen }, [perm.buffer]);
};
