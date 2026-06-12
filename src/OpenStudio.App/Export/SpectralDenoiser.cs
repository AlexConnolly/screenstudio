namespace OpenStudio.App.Export;

/// <summary>
/// On-device mic noise removal (§5.5) via spectral subtraction: estimate the noise
/// spectrum from the quietest frames, then attenuate each STFT bin toward that floor.
/// Not RNNoise-grade, but removes fan/hum/hiss well and runs fully offline with zero
/// dependencies. Operates in place on interleaved stereo float samples.
/// </summary>
public static class SpectralDenoiser
{
    private const int FrameSize = 1024; // ~21 ms @ 48 kHz
    private const int Hop = FrameSize / 2;
    private const double OverSubtraction = 1.6;
    private const double GainFloor = 0.08;

    public static void DenoiseStereoInPlace(float[] interleaved)
    {
        if (interleaved.Length < FrameSize * 4) return;
        for (var ch = 0; ch < 2; ch++)
        {
            var mono = new float[interleaved.Length / 2];
            for (var i = 0; i < mono.Length; i++) mono[i] = interleaved[i * 2 + ch];
            DenoiseMono(mono);
            for (var i = 0; i < mono.Length; i++) interleaved[i * 2 + ch] = mono[i];
        }
    }

    private static void DenoiseMono(float[] x)
    {
        var window = new double[FrameSize];
        for (var i = 0; i < FrameSize; i++)
            window[i] = 0.5 - 0.5 * Math.Cos(2 * Math.PI * i / FrameSize); // Hann

        var frameCount = (x.Length - FrameSize) / Hop;
        if (frameCount < 8) return;

        // Pass 1: per-frame energy → pick the quietest 10% as the noise profile.
        var energies = new double[frameCount];
        for (var f = 0; f < frameCount; f++)
        {
            double e = 0;
            var off = f * Hop;
            for (var i = 0; i < FrameSize; i++) e += (double)x[off + i] * x[off + i];
            energies[f] = e;
        }
        var sorted = (double[])energies.Clone();
        Array.Sort(sorted);
        var threshold = sorted[Math.Max(0, frameCount / 10 - 1)];

        var noise = new double[FrameSize / 2 + 1];
        var noiseFrames = 0;
        var re = new double[FrameSize];
        var im = new double[FrameSize];
        for (var f = 0; f < frameCount && noiseFrames < 200; f++)
        {
            if (energies[f] > threshold) continue;
            LoadFrame(x, f * Hop, window, re, im);
            Fft(re, im, false);
            for (var k = 0; k <= FrameSize / 2; k++)
                noise[k] += Math.Sqrt(re[k] * re[k] + im[k] * im[k]);
            noiseFrames++;
        }
        if (noiseFrames == 0) return;
        for (var k = 0; k < noise.Length; k++) noise[k] /= noiseFrames;

        // Pass 2: subtract, with temporal gain smoothing to avoid musical noise.
        var output = new double[x.Length];
        var norm = new double[x.Length];
        var prevGain = new double[FrameSize / 2 + 1];
        for (var k = 0; k < prevGain.Length; k++) prevGain[k] = 1;

        for (var f = 0; f < frameCount; f++)
        {
            var off = f * Hop;
            LoadFrame(x, off, window, re, im);
            Fft(re, im, false);
            for (var k = 0; k <= FrameSize / 2; k++)
            {
                var mag = Math.Sqrt(re[k] * re[k] + im[k] * im[k]);
                var clean = mag - OverSubtraction * noise[k];
                var gain = mag > 1e-12 ? Math.Max(GainFloor, clean / mag) : GainFloor;
                gain = 0.6 * prevGain[k] + 0.4 * gain;
                prevGain[k] = gain;
                Scale(re, im, k, gain);
                if (k != 0 && k != FrameSize / 2) Scale(re, im, FrameSize - k, gain);
            }
            Fft(re, im, true);
            for (var i = 0; i < FrameSize; i++)
            {
                output[off + i] += re[i] * window[i];
                norm[off + i] += window[i] * window[i];
            }
        }
        for (var i = 0; i < x.Length; i++)
        {
            if (norm[i] > 1e-9) x[i] = (float)(output[i] / norm[i]);
        }
    }

    private static void Scale(double[] re, double[] im, int k, double gain)
    {
        re[k] *= gain;
        im[k] *= gain;
    }

    private static void LoadFrame(float[] x, int offset, double[] window, double[] re, double[] im)
    {
        for (var i = 0; i < re.Length; i++)
        {
            re[i] = x[offset + i] * window[i];
            im[i] = 0;
        }
    }

    /// <summary>In-place iterative radix-2 FFT (inverse includes 1/N).</summary>
    private static void Fft(double[] re, double[] im, bool inverse)
    {
        var n = re.Length;
        for (int i = 1, j = 0; i < n; i++)
        {
            var bit = n >> 1;
            for (; (j & bit) != 0; bit >>= 1) j ^= bit;
            j |= bit;
            if (i < j)
            {
                (re[i], re[j]) = (re[j], re[i]);
                (im[i], im[j]) = (im[j], im[i]);
            }
        }
        for (var len = 2; len <= n; len <<= 1)
        {
            var ang = 2 * Math.PI / len * (inverse ? 1 : -1);
            var wRe = Math.Cos(ang);
            var wIm = Math.Sin(ang);
            for (var i = 0; i < n; i += len)
            {
                double curRe = 1, curIm = 0;
                for (var k = 0; k < len / 2; k++)
                {
                    var uRe = re[i + k];
                    var uIm = im[i + k];
                    var vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
                    var vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
                    re[i + k] = uRe + vRe;
                    im[i + k] = uIm + vIm;
                    re[i + k + len / 2] = uRe - vRe;
                    im[i + k + len / 2] = uIm - vIm;
                    var nextRe = curRe * wRe - curIm * wIm;
                    curIm = curRe * wIm + curIm * wRe;
                    curRe = nextRe;
                }
            }
        }
        if (inverse)
        {
            for (var i = 0; i < n; i++)
            {
                re[i] /= n;
                im[i] /= n;
            }
        }
    }
}
