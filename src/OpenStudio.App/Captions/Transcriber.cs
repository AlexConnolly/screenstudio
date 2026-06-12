using System.IO;
using System.Net.Http;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;
using OpenStudio.Core.Models;
using Whisper.net;

namespace OpenStudio.App.Captions;

/// <summary>
/// On-device transcription (§5.6) via whisper.cpp (Whisper.net bindings). The GGML model
/// is fetched once into %LOCALAPPDATA% (the only network touch in the app — everything
/// after that runs offline). mic.wav → 16 kHz mono → segments → words with proportional
/// per-word timing, shifted onto the video clock.
/// </summary>
public static class Transcriber
{
    private const string ModelUrl =
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";

    public static string ModelPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "OpenStudio", "models", "ggml-base.bin");

    public static bool ModelReady => File.Exists(ModelPath);

    public static async Task DownloadModelAsync(IProgress<double> progress, CancellationToken ct)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(ModelPath)!);
        var tmp = ModelPath + ".download";
        using var http = new HttpClient();
        using var response = await http.GetAsync(ModelUrl, HttpCompletionOption.ResponseHeadersRead, ct);
        response.EnsureSuccessStatusCode();
        var total = response.Content.Headers.ContentLength ?? 0;

        await using (var src = await response.Content.ReadAsStreamAsync(ct))
        await using (var dst = new FileStream(tmp, FileMode.Create, FileAccess.Write))
        {
            var buffer = new byte[1 << 16];
            long done = 0;
            int read;
            while ((read = await src.ReadAsync(buffer, ct)) > 0)
            {
                await dst.WriteAsync(buffer.AsMemory(0, read), ct);
                done += read;
                if (total > 0) progress.Report((double)done / total);
            }
        }
        File.Move(tmp, ModelPath, overwrite: true);
    }

    public static async Task<List<CaptionWord>> TranscribeAsync(
        string projectDir, IProgress<double> progress, CancellationToken ct)
    {
        var meta = Core.ProjectStore.LoadMeta(projectDir);
        var micPath = Path.Combine(projectDir, ProjectPaths.MicWav);
        if (!File.Exists(micPath))
            throw new InvalidOperationException("This recording has no microphone track.");

        var samples = LoadMono16k(micPath);
        var audioDuration = samples.Length / 16000.0;
        // Words are timed against mic.wav; rebase onto the video clock like every track.
        var micOffsetSec = (meta.MicStartOffsetMs - meta.VideoStartOffsetMs) / 1000.0;

        using var factory = WhisperFactory.FromPath(ModelPath);
        using var processor = factory.CreateBuilder()
            .WithLanguageDetection() // language auto-detect (§5.6)
            .WithTokenTimestamps()   // word-accurate caption timing
            .Build();

        var words = new List<CaptionWord>();
        await foreach (var segment in processor.ProcessAsync(samples, ct))
        {
            // Preferred path: real token timestamps, merged from BPE sub-words back into
            // whole words. Falls back to proportional timing if whisper didn't produce
            // usable token times for this segment.
            if (!TryAppendTokenWords(words, segment.Tokens, micOffsetSec))
            {
                AppendSegmentWords(words, segment.Text,
                    segment.Start.TotalSeconds + micOffsetSec,
                    segment.End.TotalSeconds + micOffsetSec);
            }
            progress.Report(Math.Min(1, segment.End.TotalSeconds / Math.Max(1, audioDuration)));
        }
        return words;
    }

    /// <summary>
    /// Merges whisper's BPE tokens into words with their measured timestamps.
    /// Tokens carry t0/t1 in centiseconds; a token whose text begins with a space starts a
    /// new word, continuation tokens (including attached punctuation) extend the current
    /// one. Control tokens like "[_BEG_]" / "&lt;|endoftext|&gt;" are skipped.
    /// </summary>
    private static bool TryAppendTokenWords(
        List<CaptionWord> words, Whisper.net.WhisperToken[]? tokens, double micOffsetSec)
    {
        if (tokens is not { Length: > 0 }) return false;
        var added = new List<CaptionWord>();
        CaptionWord? current = null;

        foreach (var tok in tokens)
        {
            var text = tok.Text;
            if (string.IsNullOrEmpty(text)) continue;
            if (text.StartsWith("[_") || text.StartsWith("<|")) continue;
            if (tok.Start < 0 || tok.End < tok.Start) return false; // no usable timing

            var t0 = tok.Start / 100.0 + micOffsetSec;
            var t1 = tok.End / 100.0 + micOffsetSec;
            var startsNewWord = current == null || text[0] == ' ';
            var visible = text.Trim();
            if (visible.Length == 0)
            {
                current = null; // bare whitespace token → word boundary
                continue;
            }

            if (startsNewWord)
            {
                current = new CaptionWord
                {
                    T0 = Math.Round(t0, 3),
                    T1 = Math.Round(Math.Max(t1, t0 + 0.02), 3),
                    Text = visible,
                };
                added.Add(current);
            }
            else
            {
                current!.Text += visible;
                current.T1 = Math.Round(Math.Max(current.T1, t1), 3);
            }
        }

        if (added.Count == 0) return false;
        words.AddRange(added);
        return true;
    }

    /// <summary>Fallback: splits a segment's text into words with timing proportional to
    /// word length, for segments where token timestamps weren't produced.</summary>
    private static void AppendSegmentWords(List<CaptionWord> words, string text, double t0, double t1)
    {
        var parts = text.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length == 0) return;
        var totalChars = parts.Sum(p => p.Length + 1.0);
        var span = Math.Max(0.05, t1 - t0);
        var cursor = t0;
        foreach (var part in parts)
        {
            var dur = span * ((part.Length + 1.0) / totalChars);
            words.Add(new CaptionWord
            {
                T0 = Math.Round(cursor, 3),
                T1 = Math.Round(cursor + dur, 3),
                Text = part,
            });
            cursor += dur;
        }
    }

    private static float[] LoadMono16k(string path)
    {
        using var reader = new AudioFileReader(path);
        ISampleProvider sp = reader;
        if (sp.WaveFormat.Channels > 1) sp = new StereoToMonoSampleProvider(sp);
        if (sp.WaveFormat.SampleRate != 16000) sp = new WdlResamplingSampleProvider(sp, 16000);

        var chunks = new List<float[]>();
        var total = 0L;
        var buf = new float[16000];
        int read;
        while ((read = sp.Read(buf, 0, buf.Length)) > 0)
        {
            var c = new float[read];
            Array.Copy(buf, c, read);
            chunks.Add(c);
            total += read;
        }
        var all = new float[total];
        var pos = 0;
        foreach (var c in chunks)
        {
            c.CopyTo(all, pos);
            pos += c.Length;
        }
        return all;
    }
}
