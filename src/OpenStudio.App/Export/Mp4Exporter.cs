using System.IO;
using System.Runtime.InteropServices.WindowsRuntime;
using Microsoft.Web.WebView2.Core;
using OpenStudio.Core;
using OpenStudio.Core.Models;
using Windows.Media.Core;
using Windows.Media.MediaProperties;
using Windows.Media.Transcoding;

namespace OpenStudio.App.Export;

public sealed class ExportSettings
{
    /// <summary>"mp4" | "gif" (§6)</summary>
    public string Format { get; set; } = "mp4";
    public int Width { get; set; } = 1920;
    public int Height { get; set; } = 1080;
    public int Fps { get; set; } = 30;
    public double DurationSec { get; set; }
    public uint Bitrate { get; set; } = 12_000_000;
    /// <summary>"h264" | "hevc"</summary>
    public string Codec { get; set; } = "h264";
    public List<EdlRange> Ranges { get; set; } = new();
    public AudioMixSettings Audio { get; set; } = new();
}

/// <summary>
/// Export keeps the render core as the contract (§7.3): the editor's compositor renders
/// every output frame into a WebView2 shared buffer (pixel-identical to preview), and
/// this class pulls frames on demand — MediaStreamSource requests a sample, we ask the
/// editor for exactly one frame, wait, swizzle RGBA→BGRA and hand it to the encoder.
/// Audio is mixed natively from the wav tracks. Hardware encode when available (§6).
/// </summary>
public sealed class Mp4Exporter : IDisposable
{
    private readonly AutoResetEvent _frameReady = new(false);
    private readonly Action<string> _postToEditor;
    private CoreWebView2SharedBuffer? _buffer;
    private IntPtr _bufferPtr;
    private volatile bool _cancelled;

    public Mp4Exporter(Action<string> postToEditor) => _postToEditor = postToEditor;

    public void NotifyFrameReady() => _frameReady.Set();

    public void Cancel()
    {
        _cancelled = true;
        _frameReady.Set();
    }

    public async Task RunAsync(
        CoreWebView2 webview,
        CoreWebView2Environment environment,
        System.Windows.Threading.Dispatcher dispatcher,
        string projectDir,
        ExportSettings s,
        string outputPath)
    {
        var frameCount = Math.Max(1, (int)Math.Round(s.DurationSec * s.Fps));
        var frameBytes = (ulong)((long)s.Width * s.Height * 4);

        // WebView2 COM objects are apartment-bound: creating/posting the shared buffer
        // off the UI thread fails with a misleading "interface not supported" cast error.
        // Set up on the dispatcher and keep only the raw memory pointer for worker threads.
        await dispatcher.InvokeAsync(() =>
        {
            _buffer = environment.CreateSharedBuffer(frameBytes);
            _bufferPtr = _buffer.Buffer;
            webview.PostSharedBufferToScript(
                _buffer, CoreWebView2SharedBufferAccess.ReadWrite,
                Json.Serialize(new { type = "export:buffer", width = s.Width, height = s.Height }));
        });

        if (s.Format == "gif")
        {
            await RunGifAsync(s, outputPath, frameCount, (int)frameBytes);
            return;
        }

        var meta = ProjectStore.LoadMeta(projectDir);
        var pcm = await Task.Run(() => AudioMixer.BuildPcm(projectDir, meta, s.Ranges, s.Audio));

        var videoProps = VideoEncodingProperties.CreateUncompressed(
            MediaEncodingSubtypes.Bgra8, (uint)s.Width, (uint)s.Height);
        var videoDesc = new VideoStreamDescriptor(videoProps);

        MediaStreamSource mss;
        AudioStreamDescriptor? audioDesc = null;
        if (pcm != null)
        {
            audioDesc = new AudioStreamDescriptor(
                AudioEncodingProperties.CreatePcm(AudioMixer.SampleRate, AudioMixer.Channels, 16));
            mss = new MediaStreamSource(videoDesc, audioDesc);
        }
        else
        {
            mss = new MediaStreamSource(videoDesc);
        }
        mss.BufferTime = TimeSpan.Zero;
        mss.CanSeek = false;
        mss.Starting += (_, e) => e.Request.SetActualStartPosition(TimeSpan.Zero);

        var videoIndex = 0;
        long audioPos = 0;
        var bytesPerSecond = AudioMixer.SampleRate * AudioMixer.Channels * 2;
        var audioChunk = bytesPerSecond / 10; // 100 ms
        var frameDuration = TimeSpan.FromSeconds(1.0 / s.Fps);

        mss.SampleRequested += (_, e) =>
        {
            var request = e.Request;
            if (audioDesc != null && ReferenceEquals(request.StreamDescriptor, audioDesc))
            {
                if (_cancelled || pcm == null || audioPos >= pcm.Length)
                {
                    request.Sample = null;
                    return;
                }
                var len = (int)Math.Min(audioChunk, pcm.Length - audioPos);
                var chunk = new byte[len];
                Array.Copy(pcm, audioPos, chunk, 0, len);
                var sample = MediaStreamSample.CreateFromBuffer(
                    chunk.AsBuffer(), TimeSpan.FromSeconds((double)audioPos / bytesPerSecond));
                sample.Duration = TimeSpan.FromSeconds((double)len / bytesPerSecond);
                audioPos += len;
                request.Sample = sample;
                return;
            }

            // Video: pull exactly one frame from the editor's render core.
            if (_cancelled || videoIndex >= frameCount)
            {
                request.Sample = null;
                return;
            }
            var deferral = request.GetDeferral();
            try
            {
                var index = videoIndex;
                _postToEditor(Json.Serialize(new { type = "export:needFrame", index, total = frameCount }));
                if (!WaitForFrame() || _cancelled)
                {
                    request.Sample = null;
                    return;
                }

                var rgba = new byte[frameBytes];
                System.Runtime.InteropServices.Marshal.Copy(_bufferPtr, rgba, 0, rgba.Length);
                SwizzleRgbaToBgra(rgba);

                var sample = MediaStreamSample.CreateFromBuffer(
                    rgba.AsBuffer(), TimeSpan.FromSeconds((double)index / s.Fps));
                sample.Duration = frameDuration;
                request.Sample = sample;
                videoIndex++;

                if (index % 10 == 0 || index == frameCount - 1)
                    _postToEditor(Json.Serialize(new { type = "export:progress", frame = index + 1, total = frameCount }));
            }
            finally
            {
                deferral.Complete();
            }
        };

        var profile = s.Codec == "hevc"
            ? MediaEncodingProfile.CreateHevc(VideoEncodingQuality.Uhd2160p)
            : MediaEncodingProfile.CreateMp4(VideoEncodingQuality.Uhd2160p);
        profile.Video.Width = (uint)s.Width;
        profile.Video.Height = (uint)s.Height;
        profile.Video.Bitrate = s.Bitrate;
        profile.Video.FrameRate.Numerator = (uint)s.Fps;
        profile.Video.FrameRate.Denominator = 1;
        if (pcm == null) profile.Audio = null;

        using var fileStream = new FileStream(outputPath, FileMode.Create, FileAccess.ReadWrite, FileShare.Read);
        var transcoder = new MediaTranscoder { HardwareAccelerationEnabled = true };
        var prep = await transcoder.PrepareMediaStreamSourceTranscodeAsync(
            mss, fileStream.AsRandomAccessStream(), profile);
        if (!prep.CanTranscode)
            throw new InvalidOperationException($"Encoder rejected export settings: {prep.FailureReason}");
        await prep.TranscodeAsync();

        if (_cancelled)
        {
            fileStream.Dispose();
            try { File.Delete(outputPath); } catch { }
            throw new OperationCanceledException();
        }
    }

    /// <summary>GIF export (§6): same pull-based frame source, encoded by our own
    /// palette-optimized GIF writer instead of Media Foundation.</summary>
    private async Task RunGifAsync(ExportSettings s, string outputPath, int frameCount, int frameBytes)
    {
        await Task.Run(() =>
        {
            using var file = new FileStream(outputPath, FileMode.Create, FileAccess.Write);
            using var gif = new GifWriter(file, s.Width, s.Height, s.Fps);
            for (var index = 0; index < frameCount; index++)
            {
                if (_cancelled) break;
                _postToEditor(Json.Serialize(new { type = "export:needFrame", index, total = frameCount }));
                if (!WaitForFrame() || _cancelled) break;

                var rgba = new byte[frameBytes];
                System.Runtime.InteropServices.Marshal.Copy(_bufferPtr, rgba, 0, rgba.Length);
                gif.AddFrame(rgba);
                if (index % 5 == 0 || index == frameCount - 1)
                    _postToEditor(Json.Serialize(new { type = "export:progress", frame = index + 1, total = frameCount }));
            }
        });
        if (_cancelled)
        {
            try { File.Delete(outputPath); } catch { }
            throw new OperationCanceledException();
        }
    }

    private bool WaitForFrame()
    {
        // The editor seeks the <video> per frame; allow generous time but poll cancel.
        for (var i = 0; i < 300; i++)
        {
            if (_frameReady.WaitOne(100)) return !_cancelled;
            if (_cancelled) return false;
        }
        return false;
    }

    private static unsafe void SwizzleRgbaToBgra(byte[] data)
    {
        fixed (byte* p = data)
        {
            for (var i = 0; i < data.Length; i += 4)
            {
                var r = p[i];
                p[i] = p[i + 2];
                p[i + 2] = r;
            }
        }
    }

    public void Dispose()
    {
        try { _buffer?.Dispose(); } catch { /* apartment-bound; best effort */ }
        _frameReady.Dispose();
    }
}
