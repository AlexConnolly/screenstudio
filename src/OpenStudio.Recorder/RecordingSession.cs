using System.Diagnostics;
using OpenStudio.Core;
using OpenStudio.Core.Models;
using OpenStudio.Recorder.Audio;
using OpenStudio.Recorder.Capture;
using OpenStudio.Recorder.Input;

namespace OpenStudio.Recorder;

public class RecordingOptions
{
    /// <summary>"screen" | "window" | "region" (§3.1)</summary>
    public string SourceType { get; set; } = "screen";
    public string? MonitorDeviceName { get; set; }
    public long WindowHandle { get; set; }
    public RegionRect? Region { get; set; }
    public bool CaptureMic { get; set; } = true;
    public string? MicDeviceId { get; set; }
    public bool CaptureSystemAudio { get; set; } = true;
    public bool CaptureWebcam { get; set; }
    public string? CameraDeviceId { get; set; }
    public int Fps { get; set; } = 60;
    /// <summary>"full" | "modifiers" | "ticks"</summary>
    public string KeyPrivacy { get; set; } = "modifiers";
}

/// <summary>Region in physical pixels relative to the chosen monitor's origin.</summary>
public sealed class RegionRect
{
    public int X { get; set; }
    public int Y { get; set; }
    public int W { get; set; }
    public int H { get; set; }
}

/// <summary>
/// Orchestrates one recording into a self-contained project folder (§7.1):
/// screen.mp4 + events.jsonl + mic.wav/sys.wav + meta.json, then runs auto-zoom
/// generation and writes project.json so the editor opens with zooms already there (§3.2).
/// All tracks share the QPC master clock (§3.3).
/// </summary>
public sealed class RecordingSession : IDisposable
{
    public string ProjectDir { get; }
    public DateTime StartedAtUtc { get; }

    private readonly RecordingOptions _options;
    private readonly MonitorDescriptor _monitor;
    private readonly long _sessionStartQpc;
    private readonly PauseClock _clock;
    private readonly ScreenRecorder _screen;
    private readonly InputEventLogger _input;
    private readonly WavRecorder? _mic;
    private readonly WavRecorder? _sys;
    private WebcamRecorder? _cam;
    private bool _finished;

    /// <summary>Recorded time so far — excludes pauses.</summary>
    public TimeSpan Elapsed => TimeSpan.FromMilliseconds(_clock.NowMs());

    public bool IsPaused => _clock.IsPaused;

    public void Pause()
    {
        _clock.Pause();
        if (_cam != null) _ = _cam.PauseAsync();
    }

    public void Resume()
    {
        _clock.Resume();
        if (_cam != null) _ = _cam.ResumeAsync();
    }

    private RecordingSession(string projectDir, RecordingOptions options, MonitorDescriptor monitor)
    {
        ProjectDir = projectDir;
        StartedAtUtc = DateTime.UtcNow;
        _options = options;
        _monitor = monitor;
        _sessionStartQpc = Stopwatch.GetTimestamp();
        _clock = new PauseClock(_sessionStartQpc);

        var eventsPath = Path.Combine(projectDir, ProjectPaths.EventsJsonl);
        var privacy = ParsePrivacy(options.KeyPrivacy);
        switch (options.SourceType)
        {
            case "window" when options.WindowHandle != 0:
            {
                var hwnd = new IntPtr(options.WindowHandle);
                _screen = ScreenRecorder.ForWindow(hwnd, _clock);
                // Window-relative coordinates track the window as it moves (§3.4).
                var origin = WindowEnum.Origin(hwnd);
                _input = new InputEventLogger(eventsPath, _clock, origin.X, origin.Y, privacy,
                    () => WindowEnum.Origin(hwnd));
                break;
            }
            case "region" when options.Region is { } reg:
                _screen = new ScreenRecorder(monitor.Handle, (reg.X, reg.Y, reg.W, reg.H), _clock);
                _input = new InputEventLogger(eventsPath, _clock,
                    monitor.X + reg.X, monitor.Y + reg.Y, privacy);
                break;
            default:
                _screen = new ScreenRecorder(monitor.Handle, null, _clock);
                _input = new InputEventLogger(eventsPath, _clock, monitor.X, monitor.Y, privacy);
                break;
        }

        if (options.CaptureMic)
        {
            try
            {
                _mic = WavRecorder.Microphone(
                    Path.Combine(projectDir, ProjectPaths.MicWav), options.MicDeviceId, _sessionStartQpc, _clock);
            }
            catch { /* no mic — record without it */ }
        }
        if (options.CaptureSystemAudio)
        {
            try
            {
                _sys = WavRecorder.SystemLoopback(
                    Path.Combine(projectDir, ProjectPaths.SysWav), _sessionStartQpc, _clock);
            }
            catch { /* no render device */ }
        }
    }

    public static RecordingSession Start(string projectDir, RecordingOptions options)
    {
        MonitorDescriptor? monitor;
        if (options.SourceType == "window" && options.WindowHandle != 0)
        {
            // Use the monitor hosting the window for scale/refresh metadata.
            var hmon = WindowEnum.MonitorFromWindow(new IntPtr(options.WindowHandle), 2 /* NEAREST */);
            monitor = Monitors.All().FirstOrDefault(m => m.Handle == hmon) ?? Monitors.ByDeviceName(null);
        }
        else
        {
            monitor = Monitors.ByDeviceName(options.MonitorDeviceName);
        }
        if (monitor == null) throw new InvalidOperationException("No monitor found to capture.");
        Directory.CreateDirectory(projectDir);

        var session = new RecordingSession(projectDir, options, monitor);
        try
        {
            if (options.CaptureWebcam)
            {
                try
                {
                    session._cam = WebcamRecorder.StartAsync(
                        Path.Combine(projectDir, ProjectPaths.CameraMp4),
                        options.CameraDeviceId, session._sessionStartQpc).GetAwaiter().GetResult();
                }
                catch { /* webcam unavailable/in use — record without it */ }
            }
            session._mic?.Start();
            session._sys?.Start();
            session._input.Start();
            session._screen.Start(Path.Combine(projectDir, ProjectPaths.ScreenMp4), options.Fps);
            return session;
        }
        catch
        {
            session.Dispose();
            throw;
        }
    }

    private static KeyPrivacyMode ParsePrivacy(string mode) => mode switch
    {
        "full" => KeyPrivacyMode.Full,
        "ticks" => KeyPrivacyMode.TicksOnly,
        _ => KeyPrivacyMode.ModifiersOnly,
    };

    /// <summary>Stops all tracks, writes meta.json, generates auto-zooms into project.json.</summary>
    public async Task<string> FinishAsync()
    {
        _finished = true;
        _input.Stop();
        var durationSec = await _screen.StopAsync();
        _mic?.Stop();
        _sys?.Stop();
        if (_cam != null)
        {
            await _cam.StopAsync();
            _cam.Dispose();
        }

        var sessionStartMs = _sessionStartQpc * 1000.0 / Stopwatch.Frequency;
        var meta = new CaptureMeta
        {
            AppVersion = typeof(RecordingSession).Assembly.GetName().Version?.ToString() ?? "0.0",
            RecordedAtUtc = StartedAtUtc.ToString("O"),
            DurationSec = durationSec,
            Width = _screen.Width,
            Height = _screen.Height,
            Scale = _monitor.Scale,
            Fps = _options.Fps,
            Monitor = new MonitorMeta
            {
                DeviceName = _monitor.DeviceName,
                X = _monitor.X,
                Y = _monitor.Y,
                Width = _monitor.Width,
                Height = _monitor.Height,
                RefreshRate = _monitor.RefreshRate,
                IsPrimary = _monitor.IsPrimary,
            },
            VideoStartOffsetMs = Math.Max(0, (_screen.VideoStartQpcMs ?? sessionStartMs) - sessionStartMs),
            MicStartOffsetMs = Math.Max(0, _mic?.StartOffsetMs ?? 0),
            SysStartOffsetMs = Math.Max(0, _sys?.StartOffsetMs ?? 0),
            CamStartOffsetMs = Math.Max(0, _cam?.StartOffsetMs ?? 0),
            HasMic = _mic != null,
            HasSystemAudio = _sys != null,
            HasWebcam = _cam != null,
            KeyPrivacyMode = _options.KeyPrivacy,
        };
        ProjectStore.SaveMeta(ProjectDir, meta);

        // Auto-zooms are ready the moment the editor opens (§3.2 "on stop").
        var events = ProjectStore.LoadEvents(ProjectDir);
        ShiftEventsToVideoClock(events, meta.VideoStartOffsetMs);
        var project = new ProjectFile { Name = Path.GetFileNameWithoutExtension(ProjectDir) };
        project.Webcam.Enabled = meta.HasWebcam;
        project.Zoom.Segments = Core.Zoom.AutoZoomGenerator.Generate(
            events, meta.Width, meta.Height, durationSec, project.Zoom.Tunables);
        ProjectStore.SaveProject(ProjectDir, project);

        _screen.Dispose();
        return ProjectDir;
    }

    /// <summary>Rebases event timestamps onto the video clock (t=0 at first video frame),
    /// which is the time base the editor and zoom segments use.</summary>
    private static void ShiftEventsToVideoClock(List<InputEvent> events, double videoStartOffsetMs)
    {
        foreach (var ev in events) ev.T -= videoStartOffsetMs;
        events.RemoveAll(ev => ev.T < 0);
    }

    /// <summary>Stops everything and deletes the partial project folder.</summary>
    public async Task CancelAsync()
    {
        _finished = true;
        _input.Stop();
        try { await _screen.StopAsync(); } catch { }
        _mic?.Stop();
        _sys?.Stop();
        if (_cam != null)
        {
            await _cam.StopAsync();
            _cam.Dispose();
        }
        _screen.Dispose();
        try { Directory.Delete(ProjectDir, recursive: true); } catch { }
    }

    public void Dispose()
    {
        if (_finished) return;
        _input.Dispose();
        _mic?.Dispose();
        _sys?.Dispose();
        _cam?.Dispose();
        _screen.Dispose();
    }
}
