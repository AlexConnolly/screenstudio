using System.Collections.Concurrent;
using System.Diagnostics;
using SharpDX.Direct3D11;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Media.Core;
using Windows.Media.MediaProperties;
using Windows.Media.Transcoding;

namespace OpenStudio.Recorder.Capture;

/// <summary>
/// Full-screen capture (§3.1) at native resolution into a high-bitrate H.264 intermediate
/// (§3.3): Windows.Graphics.Capture → BGRA frames on the GPU → MediaStreamSource →
/// MediaTranscoder (hardware encode when available). The OS cursor is excluded from
/// capture (§4.3) — the editor re-renders a synthetic cursor from the event log.
/// </summary>
public sealed class ScreenRecorder : IDisposable
{
    private sealed record QueuedFrame(IDirect3DSurface Surface, Texture2D Texture, TimeSpan Time);

    private readonly SharpDX.Direct3D11.Device _d3d;
    private readonly IDirect3DDevice _device;
    private readonly GraphicsCaptureItem _item;
    private readonly object _d3dLock = new();
    private readonly BlockingCollection<QueuedFrame> _frames = new(boundedCapacity: 8);

    private Direct3D11CaptureFramePool? _pool;
    private GraphicsCaptureSession? _session;
    private Task? _transcodeTask;
    private FileStream? _fileStream;
    private Timer? _keepalive;
    private Texture2D? _latest;
    private TimeSpan? _captureStartTime;
    private TimeSpan? _firstFrameTime;
    private long _lastEnqueueQpc100ns;
    private TimeSpan _lastFrameTime;
    private int _dropped;

    private readonly PauseClock? _pauseClock;
    /// <summary>Optional sub-rectangle of the capture item to record (region mode, §3.1).</summary>
    private readonly (int X, int Y, int W, int H)? _region;

    public int Width { get; }
    public int Height { get; }

    /// <summary>QPC-based ms (boot-relative, same clock as the event log) of the first encoded frame.</summary>
    public double? VideoStartQpcMs { get; private set; }

    public ScreenRecorder(IntPtr monitorHandle, (int X, int Y, int W, int H)? region = null, PauseClock? pauseClock = null)
        : this(CaptureInterop.CreateItemForMonitor(monitorHandle), region, pauseClock) { }

    public static ScreenRecorder ForWindow(IntPtr hwnd, PauseClock? pauseClock = null) =>
        new(CaptureInterop.CreateItemForWindow(hwnd), null, pauseClock);

    private ScreenRecorder(GraphicsCaptureItem item, (int X, int Y, int W, int H)? region, PauseClock? pauseClock)
    {
        _pauseClock = pauseClock;
        _d3d = new SharpDX.Direct3D11.Device(
            SharpDX.Direct3D.DriverType.Hardware,
            DeviceCreationFlags.BgraSupport);

        // WGC's free-threaded pool, our copy thread and Media Foundation all touch this device.
        using (var mt = _d3d.ImmediateContext.QueryInterfaceOrNull<Multithread>())
            mt?.SetMultithreadProtected(true);

        using var dxgi = _d3d.QueryInterface<SharpDX.DXGI.Device>();
        _device = CaptureInterop.CreateWinRTDevice(dxgi);
        _item = item;

        if (region is { } r)
        {
            // Clamp to the item and round to even dimensions for the encoder.
            var x = Math.Clamp(r.X, 0, Math.Max(0, _item.Size.Width - 16));
            var y = Math.Clamp(r.Y, 0, Math.Max(0, _item.Size.Height - 16));
            var w = Math.Clamp(r.W, 16, _item.Size.Width - x) & ~1;
            var h = Math.Clamp(r.H, 16, _item.Size.Height - y) & ~1;
            _region = (x, y, w, h);
            Width = w;
            Height = h;
        }
        else
        {
            Width = _item.Size.Width & ~1;
            Height = _item.Size.Height & ~1;
        }
    }

    public void Start(string outputPath, int fps)
    {
        _pool = Direct3D11CaptureFramePool.CreateFreeThreaded(
            _device, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, _item.Size);
        _pool.FrameArrived += OnFrameArrived;

        _session = _pool.CreateCaptureSession(_item);
        _session.IsCursorCaptureEnabled = false; // §4.3 — synthetic cursor is rendered in post
        try { _session.IsBorderRequired = false; } catch { /* needs consent on some builds; the yellow border is cosmetic */ }

        var props = VideoEncodingProperties.CreateUncompressed(
            MediaEncodingSubtypes.Bgra8, (uint)Width, (uint)Height);
        var mss = new MediaStreamSource(new VideoStreamDescriptor(props))
        {
            BufferTime = TimeSpan.Zero,
            CanSeek = false,
        };
        mss.Starting += (_, e) => e.Request.SetActualStartPosition(TimeSpan.Zero);
        mss.SampleRequested += OnSampleRequested;

        var profile = MediaEncodingProfile.CreateMp4(VideoEncodingQuality.Uhd2160p);
        profile.Audio = null; // audio is recorded to separate wav tracks (§3.3)
        profile.Video.Width = (uint)Width;
        profile.Video.Height = (uint)Height;
        profile.Video.FrameRate.Numerator = (uint)fps;
        profile.Video.FrameRate.Denominator = 1;
        // Near-lossless intermediate: it gets zoomed up to 4x and re-encoded at export (§3.3).
        profile.Video.Bitrate = (uint)Math.Min(120_000_000L, (long)(Width * (long)Height * fps * 0.4));

        _fileStream = new FileStream(outputPath, FileMode.Create, FileAccess.ReadWrite, FileShare.Read);
        var transcoder = new MediaTranscoder { HardwareAccelerationEnabled = true };
        _transcodeTask = Task.Run(async () =>
        {
            var prep = await transcoder.PrepareMediaStreamSourceTranscodeAsync(
                mss, _fileStream.AsRandomAccessStream(), profile);
            if (!prep.CanTranscode)
                throw new InvalidOperationException($"Cannot encode screen capture: {prep.FailureReason}");
            await prep.TranscodeAsync();
        });

        // Anchor the video clock at capture start, not at the first frame: WGC sends
        // nothing while the screen is static, and the first frame that does arrive shows
        // what the screen looked like during that quiet lead-in anyway.
        _captureStartTime = NowQpc();
        _session.StartCapture();

        // WGC only delivers frames when pixels change; repeat the last frame during static
        // periods so the intermediate keeps real-time duration.
        _keepalive = new Timer(OnKeepalive, null, 500, 250);
    }

    private static TimeSpan NowQpc() =>
        TimeSpan.FromTicks((long)(Stopwatch.GetTimestamp() * (10_000_000.0 / Stopwatch.Frequency)));

    private void OnFrameArrived(Direct3D11CaptureFramePool sender, object? args)
    {
        using var frame = sender.TryGetNextFrame();
        if (frame is null) return;
        try
        {
            using var src = CaptureInterop.GetTexture(frame.Surface);
            Enqueue(src, frame.SystemRelativeTime);
        }
        catch (ObjectDisposedException)
        {
            // Race with Stop(); frame is simply dropped.
        }
    }

    private void OnKeepalive(object? state)
    {
        if (_frames.IsAddingCompleted) return;
        if (_pauseClock?.IsPaused == true) return;
        var now = NowQpc();
        var sinceLast = now.Ticks - Interlocked.Read(ref _lastEnqueueQpc100ns);
        if (sinceLast < TimeSpan.FromMilliseconds(400).Ticks) return;
        lock (_d3dLock)
        {
            if (_latest is null) return;
            EnqueueLocked(_latest, now);
        }
    }

    private void Enqueue(Texture2D src, TimeSpan time)
    {
        lock (_d3dLock)
        {
            if (_latest is null)
            {
                var desc = src.Description;
                desc.Usage = ResourceUsage.Default;
                desc.BindFlags = BindFlags.ShaderResource | BindFlags.RenderTarget;
                desc.CpuAccessFlags = CpuAccessFlags.None;
                desc.OptionFlags = ResourceOptionFlags.None;
                _latest = new Texture2D(_d3d, desc);
            }
            _d3d.ImmediateContext.CopyResource(src, _latest);
            if (_pauseClock?.IsPaused == true) return; // keep _latest fresh, drop the frame (§3.2 pause)
            EnqueueLocked(_latest, time);
        }
    }

    /// <summary>Caller must hold _d3dLock. Copies the recorded region of
    /// <paramref name="src"/> into a fresh texture owned by the queued sample.</summary>
    private void EnqueueLocked(Texture2D src, TimeSpan time)
    {
        if (_frames.IsAddingCompleted) return;
        if (_pauseClock != null) time -= TimeSpan.FromMilliseconds(_pauseClock.PausedTotalMs);
        var isFirst = _firstFrameTime is null;
        _firstFrameTime ??= _captureStartTime ?? time;
        VideoStartQpcMs ??= _firstFrameTime.Value.TotalMilliseconds;
        var sampleTime = time - _firstFrameTime.Value;
        if (sampleTime <= _lastFrameTime && sampleTime != TimeSpan.Zero) return; // never go backwards

        // The screen can be static for a while before WGC delivers anything; the first
        // frame doubles as the t=0 frame so the file has content from the very start.
        if (isFirst && sampleTime > TimeSpan.FromMilliseconds(100))
            QueueCopy(src, TimeSpan.Zero, time);
        QueueCopy(src, sampleTime, time);
    }

    /// <summary>Caller must hold _d3dLock.</summary>
    private void QueueCopy(Texture2D src, TimeSpan sampleTime, TimeSpan rawTime)
    {
        var desc = src.Description;
        desc.Width = Width;
        desc.Height = Height;
        var tex = new Texture2D(_d3d, desc);
        var (rx, ry) = _region is { } reg ? (reg.X, reg.Y) : (0, 0);
        _d3d.ImmediateContext.CopySubresourceRegion(
            src, 0,
            new ResourceRegion(rx, ry, 0, rx + Width, ry + Height, 1),
            tex, 0);

        SharpDX.DXGI.Surface dxgi = tex.QueryInterface<SharpDX.DXGI.Surface>();
        IDirect3DSurface surface;
        try
        {
            surface = CaptureInterop.CreateWinRTSurface(dxgi);
        }
        finally
        {
            dxgi.Dispose();
        }

        if (_frames.TryAdd(new QueuedFrame(surface, tex, sampleTime)))
        {
            _lastFrameTime = sampleTime;
            Interlocked.Exchange(ref _lastEnqueueQpc100ns, rawTime.Ticks);
        }
        else
        {
            // Encoder can't keep up; drop rather than stall the capture thread.
            tex.Dispose();
            Interlocked.Increment(ref _dropped);
        }
    }

    private void OnSampleRequested(MediaStreamSource sender, MediaStreamSourceSampleRequestedEventArgs args)
    {
        var request = args.Request;
        var deferral = request.GetDeferral();
        try
        {
            if (_frames.TryTake(out var f, Timeout.Infinite))
            {
                var sample = MediaStreamSample.CreateFromDirect3D11Surface(f.Surface, f.Time);
                sample.Processed += (_, __) => f.Texture.Dispose();
                request.Sample = sample;
            }
            else
            {
                request.Sample = null; // drained after CompleteAdding → end of stream
            }
        }
        catch (Exception)
        {
            request.Sample = null;
        }
        finally
        {
            deferral.Complete();
        }
    }

    /// <summary>Stops capture, finishes the encode, returns recorded duration in seconds.</summary>
    public async Task<double> StopAsync()
    {
        _keepalive?.Dispose();
        _keepalive = null;
        _session?.Dispose();
        _session = null;
        if (_pool != null)
        {
            _pool.FrameArrived -= OnFrameArrived;
            _pool.Dispose();
            _pool = null;
        }
        _frames.CompleteAdding();
        if (_transcodeTask != null) await _transcodeTask;
        _fileStream?.Dispose();
        _fileStream = null;
        return _lastFrameTime.TotalSeconds;
    }

    public void Dispose()
    {
        _keepalive?.Dispose();
        _session?.Dispose();
        _pool?.Dispose();
        if (!_frames.IsAddingCompleted) _frames.CompleteAdding();
        while (_frames.TryTake(out var f)) f.Texture.Dispose();
        lock (_d3dLock)
        {
            _latest?.Dispose();
            _latest = null;
        }
        _fileStream?.Dispose();
        _d3d.Dispose();
    }
}
