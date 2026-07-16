/**
 * FFT radix-2 iterativa (Cooley-Tukey), pura e sem dependência. Usada só para o
 * espectro de magnitude do classificador de não-fala (centroide espectral).
 * Entrada deve ter tamanho potência de 2 — use nextPow2 + zero-pad.
 */

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** Janela de Hann (reduz vazamento espectral antes da FFT). */
export function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/**
 * FFT in-place de sinais reais empacotados em (re, im). im começa zerado.
 * Modifica re/im no lugar. Tamanho DEVE ser potência de 2.
 */
export function fftInPlace(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  // bit-reversal
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const tRe = re[b] * curRe - im[b] * curIm;
        const tIm = re[b] * curIm + im[b] * curRe;
        re[b] = re[a] - tRe; im[b] = im[a] - tIm;
        re[a] += tRe; im[a] += tIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
}

/**
 * Espectro de magnitude de um trecho real (aplica Hann + zero-pad p/ pow2).
 * Devolve as N/2 magnitudes (bins 0..Nyquist) e a resolução de frequência (Hz/bin).
 */
export function magnitudeSpectrum(seg: Float32Array, sampleRate: number): { mag: Float32Array; hzPerBin: number } {
  const N = nextPow2(seg.length);
  const re = new Float32Array(N), im = new Float32Array(N);
  const w = hann(seg.length);
  for (let i = 0; i < seg.length; i++) re[i] = seg[i] * w[i];
  fftInPlace(re, im);
  const half = N >> 1;
  const mag = new Float32Array(half);
  for (let i = 0; i < half; i++) mag[i] = Math.hypot(re[i], im[i]);
  return { mag, hzPerBin: sampleRate / N };
}
