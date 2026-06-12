using System.IO;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;
using OpenStudio.Core.Models;

namespace OpenStudio.App.Export;

public sealed class AudioMixSettings
{
    public double MicVolume { get; set; } = 1.0;
    public bool MicMuted { get; set; }
    public double SysVolume { get; set; } = 1.0;
    public bool SysMuted { get; set; }
    public bool Normalize { get; set; } = true;
    public bool Denoise { get; set; }
    /// <summary>Click times in OUTPUT seconds (editor maps through the EDL).</summary>
    public List<double> Clicks { get; set; } = new();
    public double ClickVolume { get; set; }
    /// <summary>Music file name inside the project folder.</summary>
    public string? MusicFile { get; set; }
    public double MusicVolume { get; set; } = 0.5;
    public bool Duck { get; set; } = true;
    public double DuckAmount { get; set; } = 0.25;
}

/// <summary>One kept range of the edit decision list, in source (video-clock) seconds.</summary>
public sealed class EdlRange
{
    public double SrcStart { get; set; }
    public double SrcEnd { get; set; }
    /// <summary>Playback factor; sped-up ranges are muted in v1 (§5.2).</summary>
    public double Speed { get; set; } = 1.0;
}

/// <summary>
/// Builds the export audio: aligns mic/system tracks to the video clock, applies
/// volumes, follows the cut/speed EDL, then approximate loudness normalization (§5.5).
/// Output: interleaved 16-bit 48 kHz stereo PCM.
/// </summary>
public static class AudioMixer
{
    public const int SampleRate = 48000;
    public const int Channels = 2;

    public static byte[]? BuildPcm(string projectDir, CaptureMeta meta, List<EdlRange> ranges, AudioMixSettings mix)
    {
        var mic = mix.MicMuted ? null : LoadTrack(
            Path.Combine(projectDir, ProjectPaths.MicWav),
            meta.MicStartOffsetMs - meta.VideoStartOffsetMs, (float)mix.MicVolume);
        if (mic != null && mix.Denoise) SpectralDenoiser.DenoiseStereoInPlace(mic);
        var sys = mix.SysMuted ? null : LoadTrack(
            Path.Combine(projectDir, ProjectPaths.SysWav),
            meta.SysStartOffsetMs - meta.VideoStartOffsetMs, (float)mix.SysVolume);
        var hasClicks = mix.ClickVolume > 0 && mix.Clicks.Count > 0;
        var hasMusic = !string.IsNullOrEmpty(mix.MusicFile) && mix.MusicVolume > 0;
        if (mic == null && sys == null && !hasClicks && !hasMusic) return null;

        var srcLen = Math.Max(mic?.Length ?? 0, sys?.Length ?? 0);
        var source = new float[srcLen];
        if (mic != null) for (var i = 0; i < mic.Length; i++) source[i] += mic[i];
        if (sys != null) for (var i = 0; i < sys.Length; i++) source[i] += sys[i];

        // Apply the EDL in source time.
        var totalOut = ranges.Sum(r => (long)(Math.Max(0, r.SrcEnd - r.SrcStart) / Math.Max(0.01, r.Speed) * SampleRate)) * Channels;
        var output = new float[totalOut];
        long pos = 0;
        foreach (var r in ranges)
        {
            var outSamples = (long)(Math.Max(0, r.SrcEnd - r.SrcStart) / Math.Max(0.01, r.Speed) * SampleRate) * Channels;
            if (Math.Abs(r.Speed - 1.0) < 1e-6)
            {
                var srcStart = (long)(r.SrcStart * SampleRate) * Channels;
                for (long i = 0; i < outSamples && pos + i < output.Length; i++)
                {
                    var s = srcStart + i;
                    output[pos + i] = s >= 0 && s < srcLen ? source[s] : 0f;
                }
            }
            // speed != 1 → leave silence (§5.2: muted is fine for v1)
            pos += outSamples;
        }

        if (mix.Normalize) Normalize(output);

        // Background music along the OUTPUT timeline, auto-ducked under voice (§5.5).
        if (hasMusic)
        {
            var music = LoadTrack(Path.Combine(projectDir, mix.MusicFile!), 0, (float)mix.MusicVolume);
            if (music != null)
            {
                var duckGain = mix.Duck ? BuildDuckEnvelope(output, Math.Clamp(mix.DuckAmount, 0, 1)) : null;
                for (long i = 0; i < output.Length && i < music.Length; i++)
                {
                    var g = duckGain?[(int)(i / (Channels * DuckHop))] ?? 1f;
                    output[i] += music[i] * g;
                }
            }
        }

        // Synthesized click ticks (§4.3) — clicks arrive already mapped to output time.
        if (hasClicks) MixClicks(output, mix.Clicks, (float)mix.ClickVolume);

        // Final safety clip.
        for (var i = 0; i < output.Length; i++) output[i] = Math.Clamp(output[i], -0.995f, 0.995f);
        return ToPcm16(output);
    }

    private const int DuckHop = 2400; // 50 ms gain blocks

    /// <summary>Voice-follower gain: drops to duckAmount while the voice mix is audible,
    /// with fast attack (~80 ms) and slow release (~500 ms).</summary>
    private static float[] BuildDuckEnvelope(float[] voice, double duckAmount)
    {
        var blocks = (int)(voice.LongLength / (Channels * DuckHop)) + 1;
        var gains = new float[blocks];
        const double threshold = 0.015;
        var attack = (float)Math.Exp(-1.0 / (0.08 * SampleRate / DuckHop));
        var release = (float)Math.Exp(-1.0 / (0.5 * SampleRate / DuckHop));
        float gain = 1;
        for (var b = 0; b < blocks; b++)
        {
            double sum = 0;
            var start = (long)b * Channels * DuckHop;
            var end = Math.Min(voice.LongLength, start + Channels * DuckHop);
            for (var i = start; i < end; i++) sum += (double)voice[i] * voice[i];
            var rms = Math.Sqrt(sum / Math.Max(1, end - start));
            var target = rms > threshold ? (float)duckAmount : 1f;
            var coeff = target < gain ? attack : release;
            gain = target + (gain - target) * coeff;
            gains[b] = gain;
        }
        return gains;
    }

    /// <summary>Subtle synthesized tick: damped 1.8 kHz sine + soft noise transient, 30 ms.</summary>
    private static void MixClicks(float[] output, List<double> clickTimesOut, float volume)
    {
        var rnd = new Random(12345); // deterministic
        var tickLen = (int)(0.03 * SampleRate);
        var tick = new float[tickLen];
        for (var i = 0; i < tickLen; i++)
        {
            var t = i / (double)SampleRate;
            var env = Math.Exp(-t * 180);
            tick[i] = (float)((Math.Sin(2 * Math.PI * 1800 * t) * 0.7 +
                               (rnd.NextDouble() * 2 - 1) * 0.25 * Math.Exp(-t * 600)) * env * 0.5);
        }
        foreach (var t in clickTimesOut)
        {
            var start = (long)(t * SampleRate) * Channels;
            for (var i = 0; i < tickLen; i++)
            {
                var idx = start + (long)i * Channels;
                if (idx + 1 >= output.Length) break;
                if (idx < 0) continue;
                output[idx] += tick[i] * volume;
                output[idx + 1] += tick[i] * volume;
            }
        }
    }

    /// <summary>Reads a wav, resamples to 48 kHz stereo float, aligns to the video clock.</summary>
    private static float[]? LoadTrack(string path, double delayMs, float volume)
    {
        if (!File.Exists(path) || volume <= 0) return null;
        try
        {
            using var reader = new AudioFileReader(path);
            ISampleProvider sp = reader;
            if (sp.WaveFormat.SampleRate != SampleRate)
                sp = new WdlResamplingSampleProvider(sp, SampleRate);
            if (sp.WaveFormat.Channels == 1)
                sp = new MonoToStereoSampleProvider(sp);

            var chunks = new List<float[]>();
            var total = 0L;
            var buf = new float[SampleRate * Channels]; // 1 s
            int read;
            while ((read = sp.Read(buf, 0, buf.Length)) > 0)
            {
                var c = new float[read];
                Array.Copy(buf, c, read);
                chunks.Add(c);
                total += read;
            }

            var delaySamples = (long)(delayMs / 1000.0 * SampleRate) * Channels;
            var skip = delaySamples < 0 ? -delaySamples : 0;
            var lead = delaySamples > 0 ? delaySamples : 0;
            var result = new float[lead + Math.Max(0, total - skip)];
            var w = lead;
            var seen = 0L;
            foreach (var c in chunks)
            {
                for (var i = 0; i < c.Length; i++, seen++)
                {
                    if (seen < skip) continue;
                    if (w >= result.Length) break;
                    result[w++] = c[i] * volume;
                }
            }
            return result;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>RMS-based gain toward ≈ −16 LUFS with a hard peak cap. A full ITU-R BS.1770
    /// loudness pass is a later refinement; this gets speech in the right ballpark.</summary>
    private static void Normalize(float[] samples)
    {
        if (samples.Length == 0) return;
        double sum = 0;
        long voiced = 0;
        foreach (var s in samples)
        {
            if (Math.Abs(s) > 0.001)
            {
                sum += s * s;
                voiced++;
            }
        }
        if (voiced < SampleRate) return; // < 0.5 s of audible audio — leave alone
        var rms = Math.Sqrt(sum / voiced);
        var targetRms = Math.Pow(10, -18.0 / 20); // ≈ −16 LUFS for typical speech
        var gain = Math.Clamp(targetRms / Math.Max(1e-6, rms), 0.25, 8.0);

        float peak = 0;
        foreach (var s in samples) peak = Math.Max(peak, Math.Abs(s));
        if (peak * gain > 0.985) gain = 0.985 / peak;

        for (var i = 0; i < samples.Length; i++) samples[i] = (float)(samples[i] * gain);
    }

    private static byte[] ToPcm16(float[] samples)
    {
        var bytes = new byte[samples.Length * 2];
        for (var i = 0; i < samples.Length; i++)
        {
            var v = (short)Math.Clamp((int)(samples[i] * 32767f), short.MinValue, short.MaxValue);
            bytes[i * 2] = (byte)(v & 0xFF);
            bytes[i * 2 + 1] = (byte)((v >> 8) & 0xFF);
        }
        return bytes;
    }
}
